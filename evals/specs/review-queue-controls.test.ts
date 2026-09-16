import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { startServer } from '../../tools/review-queue/serve.mjs';
import { next, result } from '../../tools/review-queue/executor.mjs';
import { readLog, withLedger, appendEvent, exclusiveFile, statusEvent, queueProtocol } from '../../tools/review-queue/protocol.mjs';
import { applyDecision, validateFeed } from '../../tools/review-queue/core.mjs';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-controls-'));
  const feed = validateFeed({ items: ['A', 'B', 'C'].map((name) => ({ id: `ses_fixture${name}`, title: `Synthetic ${name}`, kind: 'session', group: 'example', recommended_action: 'archive', if_approved: 'Recheck before archiving.', workspace_id: 'ws_fixture' })), decisions: [] });
  const path = join(root, 'feed.json');
  writeFileSync(path, JSON.stringify(feed));
  const live = await startServer({ feed: path, dir: join(root, 'queue') });
  const snapshot = JSON.stringify({ ...feed, decisions: [] });
  const post = async (route: string, body: object) => {
    const response = await fetch(live.origin + route, { method: 'POST', headers: { Origin: live.origin, 'X-Review-Token': live.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const decide = (patch: object = {}) => ({ id: randomUUID(), ids: ['ses_fixtureA'], action: 'approve', comment: '', decided_at: new Date().toISOString(), snapshot, ...patch });
  const control = (target_id: string, patch: object = {}) => ({ id: randomUUID(), target_id, mode: 'undo', replacement: null, text: '', snapshot, ...patch });
  const close = async () => { if (live.server.listening) await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); }); rmSync(root, { recursive: true, force: true }); };
  return { ...live, feed, path, snapshot, post, decide, control, close };
}

test('queued withdrawal beats claims durably; running claims cannot be interrupted and same-item requests conflict', async ({ evidence }) => {
  const f = await fixture();
  try {
    const decision = f.decide();
    expect((await f.post('/decisions', decision)).status).toBe(200);
    expect((await f.post('/decisions', f.decide())).status).toBe(409);
    const undo = f.control(decision.id);
    const outcomes = await Promise.all([f.post('/controls', undo), f.post('/controls', undo)]);
    expect(outcomes.map((entry) => entry.status)).toEqual([200, 200]);
    expect(outcomes[0].value).toEqual(outcomes[1].value);
    expect(outcomes[0].value.status).toBe('withdrawn');
    expect(next(f.directory)).toBeNull();
    expect(readLog(f.directory, 'results.jsonl').some((event) => event.status === 'rechecking')).toBe(false);
    expect((await f.post('/controls', { ...undo, text: 'different' })).status).toBe(409);
    expect((await f.post('/controls', f.control(decision.id))).status).toBe(409);
    const second = f.decide();
    expect((await f.post('/decisions', second)).status).toBe(200);
    expect(next(f.directory).id).toBe(second.id);
    const before = readFileSync(join(f.directory, 'decisions.jsonl'), 'utf8');
    const refused = await f.post('/controls', f.control(second.id));
    expect(refused.status).toBe(409);
    expect(refused.value.error).toContain('Running');
    result(second.id, 'reply', 'A discussion reply does not resolve the execution claim', f.directory);
    expect((await f.post('/controls', f.control(second.id))).value.error).toContain('Running');
    expect(readFileSync(join(f.directory, 'decisions.jsonl'), 'utf8')).toBe(before);
    expect(next(f.directory)).toBeNull();
    evidence.recordAssertionEvidence('Withdrawal and claim share one durable linearization point', 'Duplicate concurrent undo has one receipt, withdraw prevents every claim, same-item decision conflicts, running undo returns 409 without an append and abandoned claims never replay.', true);
  } finally { await f.close(); }
});

test('archive change requires completed compensation before replacement; failures and stale controls block', async ({ evidence }) => {
  const f = await fixture();
  try {
    const original = f.decide({ ids: ['ses_fixtureA', 'ses_fixtureB'] });
    expect((await f.post('/decisions', original)).status).toBe(200);
    next(f.directory);
    result(original.id, 'archived', 'All synthetic targets archived', f.directory);
    expect((await f.post('/controls', f.control(original.id))).status).toBe(409);
    result(original.id, 'archived', 'All synthetic targets archived with individual receipts', f.directory, original.ids.map((item_id) => ({ item_id, status: 'archived', text: 'Confirmed archived' })));
    const change = f.control(original.id, { mode: 'change', replacement: { action: 'decline', comment: '', decided_at: new Date().toISOString() } });
    expect((await f.post('/controls', { ...change, ids: ['ses_fixtureA'] })).status).toBe(400);
    expect((await f.post('/controls', { ...change, snapshot: 'stale' })).status).toBe(409);
    const accepted = await f.post('/controls', change);
    expect(accepted.status).toBe(200);
    const control = accepted.value;
    const compensation = next(f.directory);
    expect(compensation).toMatchObject({ id: control.compensation_id, action: 'unarchive', target_id: original.id, item_ids: original.ids });
    expect(next(f.directory)).toBeNull();
    result(compensation.id, 'blocked', 'One target uncertain; do not replace', f.directory);
    expect(next(f.directory)).toBeNull();
    expect((await f.post('/decisions', f.decide())).status).toBe(409);
    expect(readLog(f.directory, 'results.jsonl').some((event) => event.decision_id === control.replacement_id && event.status === 'rechecking')).toBe(false);
    expect(() => result(original.id, 'no_effect', 'Incorrect relabel', f.directory)).toThrow();
    expect(() => result(compensation.id, 'unarchived', 'Missing target receipts', f.directory)).toThrow();
    result(compensation.id, 'unarchived', 'Reconciled: both targets are now unarchived', f.directory, original.ids.map((item_id) => ({ item_id, status: 'unarchived', text: 'Confirmed unarchived' })));
    const replacement = next(f.directory);
    expect(replacement).toMatchObject({ id: control.replacement_id, depends_on: compensation.id, action: 'decline', target_id: original.id, item_ids: original.ids });
    expect(() => result(compensation.id, 'blocked', 'Too late', f.directory)).toThrow();
    expect(next(f.directory)).toBeNull();
    expect((await f.post('/controls', change)).value).toEqual(control);
    expect(readLog(f.directory, 'decisions.jsonl')).toHaveLength(2);
    evidence.recordAssertionEvidence('Compensation gates the exact whole-batch replacement', 'Partial/stale control rejected. Unarchive claims first; running and blocked compensation prevent replacement and new same-item work. Explicit all-target unarchived permits one replacement. Successful compensation and controlled original cannot be relabeled.', true);
  } finally { await f.close(); }
});

test('mixed bulk effects compensate only explicit affected targets and unknown targets prevent any replacement', async ({ evidence }) => {
  const f = await fixture();
  try {
    const original = f.decide({ ids: ['ses_fixtureA', 'ses_fixtureB'] });
    await f.post('/decisions', original); next(f.directory);
    expect(() => result(original.id, 'blocked', 'Incomplete target list', f.directory, [{ item_id: 'ses_fixtureA', status: 'archived', text: 'Known effect' }])).toThrow();
    result(original.id, 'blocked', 'Partial outcome needs inspection', f.directory, [
      { item_id: 'ses_fixtureA', status: 'archived', text: 'Archive confirmed' },
      { item_id: 'ses_fixtureB', status: 'blocked', text: 'External state unknown' },
    ]);
    expect((await f.post('/controls', f.control(original.id))).status).toBe(409);
    expect(readLog(f.directory, 'decisions.jsonl')).toHaveLength(1);
    result(original.id, 'blocked', 'Reconciled mixed outcome', f.directory, [
      { item_id: 'ses_fixtureA', status: 'archived', text: 'Archive confirmed' },
      { item_id: 'ses_fixtureB', status: 'no_effect', text: 'Confirmed no external action on this target' },
    ]);
    const control = (await f.post('/controls', f.control(original.id, { mode: 'change', replacement: { action: 'decline', comment: '', decided_at: new Date().toISOString() } }))).value;
    const compensation = next(f.directory);
    expect(compensation.item_ids).toEqual(['ses_fixtureA']);
    expect(compensation.id).toBe(control.compensation_id);
    expect(next(f.directory)).toBeNull();
    result(compensation.id, 'unarchived', 'Affected target restored', f.directory, [{ item_id: 'ses_fixtureA', status: 'unarchived', text: 'Verified original archive restored' }]);
    expect(next(f.directory).item_ids).toEqual(original.ids);
    evidence.recordAssertionEvidence('Mixed bulk effects never become fictional all-or-none outcomes', 'Partial outcome arrays reject. Complete archived/unknown outcomes block control with no child writes. After explicit per-target reconciliation to archived/no_effect, only the archived target is compensated; the complete replacement batch waits for that success.', true);
  } finally { await f.close(); }
});

test('sent questions need explicit follow-up; generic done, blocked and merged outcomes are not safely undoable', async ({ evidence }) => {
  const f = await fixture();
  try {
    const ask = f.decide({ action: 'ask_info', comment: 'Synthetic question?' });
    expect((await f.post('/decisions', ask)).status).toBe(200);
    next(f.directory);
    for (const status of ['blocked', 'done']) {
      result(ask.id, status, 'Outcome requires reconciliation', f.directory);
      expect((await f.post('/controls', f.control(ask.id))).status).toBe(409);
    }
    result(ask.id, 'waiting', 'Question sent; awaiting reply', f.directory);
    expect((await f.post('/controls', f.control(ask.id))).status).toBe(400);
    expect(() => result(ask.id, 'no_effect', 'Pretend nothing sent', f.directory)).toThrow();
    const accepted = await f.post('/controls', f.control(ask.id, { text: 'Please disregard the previous synthetic request.' }));
    expect(accepted.status).toBe(200);
    const cancel = next(f.directory);
    expect(cancel.action).toBe('cancel_followup');
    expect(cancel.text).toBe('Please disregard the previous synthetic request.');
    result(cancel.id, 'cancelled', 'Follow-up sent; original cannot be unsent', f.directory, [{ item_id: 'ses_fixtureA', status: 'cancelled', text: 'Reviewed follow-up sent' }]);
    expect(next(f.directory)).toBeNull();
    const other = f.decide({ ids: ['ses_fixtureB'] });
    await f.post('/decisions', other); next(f.directory);
    result(other.id, 'merged', 'Synthetic legacy merge report', f.directory);
    result(other.id, 'blocked', 'Later uncertainty does not erase merge', f.directory);
    const refused = await f.post('/controls', f.control(other.id));
    expect(refused.status).toBe(409);
    expect(refused.value.error).toContain('not reversible');
    evidence.recordAssertionEvidence('No fictional unsend or absence of external effect', 'Generic done/blocked refuses reversal. Known sent question requires exact reviewed follow-up text and gets a separate cancel_followup claim. no_effect cannot erase sent history; merge remains irreversible despite a later blocked status.', true);
  } finally { await f.close(); }
});

test('control publication holes recover children exactly once; old envelopes stay readable and ambiguous legacy work never executes', async ({ evidence }) => {
  const f = await fixture();
  try {
    const original = f.decide();
    await f.post('/decisions', original);
    const change = f.control(original.id, { mode: 'change', replacement: { action: 'decline', comment: '', decided_at: new Date().toISOString() } });
    const accepted = (await f.post('/controls', change)).value;
    const log = readLog(f.directory, 'results.jsonl');
    writeFileSync(join(f.directory, 'results.jsonl'), JSON.stringify(log[0]) + '\n');
    const replacement = next(f.directory);
    expect(replacement.id).toBe(accepted.replacement_id);
    expect(next(f.directory)).toBeNull();
    expect((await f.post('/controls', change)).value).toEqual(accepted);
    expect(readLog(f.directory, 'results.jsonl').filter((event) => event.id === accepted.id)).toHaveLength(1);
    expect(readLog(f.directory, 'results.jsonl').filter((event) => event.id === accepted.replacement_id)).toHaveLength(1);
    const legacy = f.decide({ ids: ['ses_fixtureC'] });
    const event = { id: legacy.id, decision_id: legacy.id, item_ids: legacy.ids, kind: 'decision', action: 'approve', status: 'queued', text: '', at: legacy.decided_at, items: [f.feed.items[2]], decisions: applyDecision(f.feed, legacy.ids, 'approve', '', legacy.decided_at, legacy.id).decisions };
    withLedger(f.directory, () => {
      appendEvent(f.directory, 'decisions.jsonl', { request: { route: '/decisions', body: legacy }, event });
      appendEvent(f.directory, 'results.jsonl', event);
    });
    expect(next(f.directory)).toEqual(event);
    result(event.id, 'no_effect', 'Legacy work inspected only', f.directory);
    const duplicate = { ...event, id: randomUUID(), decision_id: '' };
    duplicate.decision_id = duplicate.id;
    withLedger(f.directory, () => {
      appendEvent(f.directory, 'decisions.jsonl', { request: { route: '/decisions', body: { ...legacy, id: duplicate.id } }, event: duplicate });
      appendEvent(f.directory, 'results.jsonl', duplicate);
    });
    expect(next(f.directory)).toBeNull();
    expect(readLog(f.directory, 'results.jsonl').at(-1).text).toContain('Multiple same-item');
    evidence.recordAssertionEvidence('Atomic input survives publication crashes without double execution', 'Removing only control publication records recovers root and child from one durable envelope, claims replacement once, and idempotent retry adds no work. Legacy envelope claims normally; an ambiguous second legacy same-item request is blocked instead of executed.', true);
  } finally { await f.close(); }
});

test('claim and withdrawal contend on the shared lock, and independent executors have at most one winner', async ({ evidence }) => {
  const f = await fixture();
  try {
    const original = f.decide(); await f.post('/decisions', original);
    const release = exclusiveFile(f.directory, '.ledger.lock');
    try {
      expect((await f.post('/controls', f.control(original.id))).status).toBe(503);
      expect(() => next(f.directory)).toThrow(/locked/);
    } finally { release(); }
    const script = fileURLToPath(new URL('../../tools/review-queue/executor.mjs', import.meta.url));
    const workers = [0, 1].map(() => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--dir', f.directory, 'next']);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.resume();
      child.on('error', reject);
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
    }));
    const done = await Promise.all(workers);
    expect(done.filter((worker) => worker.code === 0 && JSON.parse(worker.output)?.id === original.id)).toHaveLength(1);
    expect(readLog(f.directory, 'results.jsonl').filter((event) => event.status === 'rechecking')).toHaveLength(1);
    expect((await f.post('/controls', f.control(original.id))).status).toBe(409);
    evidence.recordAssertionEvidence('One cross-process lock governs both admission and claims', 'Holding the exact ledger lock denies both withdrawal and claim; two isolated CLI processes then produce exactly one durable claim and subsequent undo cannot interrupt it.', true);
  } finally { await f.close(); }
});

test('a dependent replacement can be withdrawn before claim without interrupting its running compensation', async ({ evidence }) => {
  const f = await fixture();
  try {
    const original = f.decide(); await f.post('/decisions', original); next(f.directory);
    result(original.id, 'archived', 'Synthetic archive complete', f.directory);
    const change = (await f.post('/controls', f.control(original.id, { mode: 'change', replacement: { action: 'decline', comment: '', decided_at: new Date().toISOString() } }))).value;
    const compensation = next(f.directory);
    expect(next(f.directory)).toBeNull();
    expect((await f.post('/controls', f.control(change.replacement_id))).status).toBe(200);
    expect((await f.post('/decisions', f.decide())).status).toBe(409);
    result(compensation.id, 'unarchived', 'Compensation completed despite replacement withdrawal', f.directory, [{ item_id: 'ses_fixtureA', status: 'unarchived', text: 'Original archive verified and restored' }]);
    expect(next(f.directory)).toBeNull();
    expect(readLog(f.directory, 'results.jsonl').some((event) => event.decision_id === change.replacement_id && event.status === 'rechecking')).toBe(false);
    evidence.recordAssertionEvidence('Queued replacement withdrawal does not interrupt compensation', 'A dependency-blocked but unclaimed replacement can be withdrawn under the same lock. Running compensation continues, prevents unrelated replacement admission, then completes without ever claiming the withdrawn replacement.', true);
  } finally { await f.close(); }
});

test('withdrawal and CLI claim races have only one winner in both arrival orders', async ({ evidence }) => {
  const script = fileURLToPath(new URL('../../tools/review-queue/executor.mjs', import.meta.url));
  const claim = (directory: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--dir', directory, 'next']); let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.resume(); child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
  for (const order of ['withdraw-first', 'claim-first', 'concurrent']) {
    const f = await fixture();
    try {
      const original = f.decide(); await f.post('/decisions', original);
      const request = f.control(original.id);
      let control;
      let worker;
      if (order === 'withdraw-first') { control = await f.post('/controls', request); worker = await claim(f.directory); }
      else if (order === 'claim-first') { worker = await claim(f.directory); control = await f.post('/controls', request); }
      else { [control, worker] = await Promise.all([f.post('/controls', request), claim(f.directory)]); }
      const claims = readLog(f.directory, 'results.jsonl').filter((event) => event.decision_id === original.id && event.status === 'rechecking');
      expect(claims.length).toBeLessThanOrEqual(1);
      if (control.status === 200) { expect(claims).toHaveLength(0); if (worker.code === 0) expect(JSON.parse(worker.output)).toBeNull(); }
      else { expect([409, 503]).toContain(control.status); expect(claims).toHaveLength(1); }
      expect(next(f.directory)).toBeNull();
    } finally { await f.close(); }
  }
  evidence.recordAssertionEvidence('Withdrawal/claim arrival order is linearizable', 'Real CLI subprocess and HTTP control tested withdrawal-first, claim-first and concurrent. Accepted withdrawal has zero claims; claim wins reject control, and no path reclaims the request. No wall-clock/idleness inference.', true);
});

test('every control publication prefix and legacy publication hole repairs exactly once before claim', async ({ evidence }) => {
  for (const plan of ['undo-queued', 'change-queued', 'undo-archived', 'change-archived']) {
    const total = 1 + Number(plan.startsWith('change')) + Number(plan.endsWith('archived'));
    for (let prefix = 0; prefix <= total; prefix++) {
    const f = await fixture();
    try {
      const original = f.decide(); await f.post('/decisions', original);
      if (plan.endsWith('archived')) { next(f.directory); result(original.id, 'archived', 'Original archive confirmed', f.directory); }
      const before = readLog(f.directory, 'results.jsonl');
      const request = f.control(original.id, plan.startsWith('change') ? { mode: 'change', replacement: { action: 'decline', comment: '', decided_at: new Date().toISOString() } } : {});
      const control = (await f.post('/controls', request)).value;
      const published = readLog(f.directory, 'results.jsonl').slice(before.length);
      expect(published).toHaveLength(total);
      writeFileSync(join(f.directory, 'results.jsonl'), [...before, ...published.slice(0, prefix)].map((event) => JSON.stringify(event) + '\n').join(''));
      if (prefix % 2) expect((await f.post('/controls', request)).value).toEqual(control);
      expect(next(f.directory)?.id ?? null).toBe(control.compensation_id ?? control.replacement_id);
      expect(next(f.directory)).toBeNull();
      expect((await f.post('/controls', request)).value).toEqual(control);
      const recovered = readLog(f.directory, 'results.jsonl');
      for (const event of published) expect(recovered.filter((entry) => entry.id === event.id)).toEqual([event]);
      expect(recovered.some((event) => event.decision_id === control.replacement_id && event.status === 'rechecking')).toBe(plan === 'change-queued');
      expect(readLog(f.directory, 'decisions.jsonl')).toHaveLength(2);
    } finally { await f.close(); }
    }
  }
  const f = await fixture();
  try {
    const original = f.decide(); await f.post('/decisions', original);
    writeFileSync(join(f.directory, 'results.jsonl'), '');
    expect(next(f.directory).id).toBe(original.id);
    expect(next(f.directory)).toBeNull();
    const receipt = readLog(f.directory, 'results.jsonl')[0];
    appendEvent(f.directory, 'results.jsonl', { ...receipt, text: 'unequal duplicate' });
    expect(() => next(f.directory)).toThrow(/Unequal duplicate/);
  } finally { await f.close(); }
  evidence.recordAssertionEvidence('All durable publication boundaries fail safely', 'Every prefix of queued undo/change and archived undo/change envelopes recovers the exact stored plan via retry or next, once, with no child exposed before full publication and no premature dependent replacement. Legacy missing publication uses the same repair before claim. Unequal duplicate receipt blocks further work.', true);
});

test('single-target compensation needs structured success and cannot undo a later independent archive', async ({ evidence }) => {
  const f = await fixture();
  try {
    const original = f.decide(); await f.post('/decisions', original); next(f.directory); result(original.id, 'archived', 'Original effect', f.directory);
    const control = (await f.post('/controls', f.control(original.id, { mode: 'change', replacement: { action: 'decline', comment: '', decided_at: new Date().toISOString() } }))).value;
    const compensation = next(f.directory);
    expect(compensation.effect_receipt_id).toBeTruthy();
    expect(() => result(compensation.id, 'unarchived', 'No structured targets', f.directory)).toThrow(/structured/);
    withLedger(f.directory, () => appendEvent(f.directory, 'results.jsonl', statusEvent(compensation, 'unarchived', 'Legacy scalar receipt is not structured success')));
    expect(next(f.directory)).toBeNull();
    const independent = { ...original, id: randomUUID() };
    const event = { id: independent.id, decision_id: independent.id, item_ids: original.ids, kind: 'decision', action: 'approve', status: 'queued', text: '', at: original.decided_at, items: [f.feed.items[0]], decisions: [] };
    withLedger(f.directory, () => {
      appendEvent(f.directory, 'decisions.jsonl', { request: { route: '/decisions', body: independent }, event });
      appendEvent(f.directory, 'results.jsonl', event);
      appendEvent(f.directory, 'results.jsonl', statusEvent(event, 'rechecking', 'Independent legacy claim'));
      appendEvent(f.directory, 'results.jsonl', statusEvent(event, 'archived', 'Later independent archive'));
    });
    expect(() => result(compensation.id, 'unarchived', 'Must not overwrite later archive', f.directory, [{ item_id: original.ids[0], status: 'unarchived', text: 'Invalid later effect' }])).toThrow(/no longer current/);
    expect(next(f.directory)).toBeNull();
    expect(readLog(f.directory, 'results.jsonl').some((entry) => entry.decision_id === control.replacement_id && entry.status === 'rechecking')).toBe(false);
  } finally { await f.close(); }
  evidence.recordAssertionEvidence('Structured compensation is tied to the original effect', 'Single-target scalar completion cannot release replacement. The claim carries its exact original-effect receipt. A later independent archive prevents compensation success/replacement rather than undoing later work.', true);
});

test('protocol epoch rejects old readers, survives restart and preserves stop; fixed ports fail without fallback', async ({ evidence }) => {
  const f = await fixture();
  try {
    const protocol = queueProtocol(f.directory);
    expect(protocol.protocol).toBe(3);
    const raw = readFileSync(join(f.directory, 'decisions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(() => raw.map((record) => record.event).map((event) => event.id)).toThrow();
    expect((await fetch(f.origin + '/protocol')).status).toBe(401);
    const response = await fetch(f.origin + '/protocol', { headers: { 'X-Review-Token': f.token } });
    expect(await response.json()).toEqual(protocol);
    for (const port of [-1, 65536, 1.5]) await expect(startServer({ feed: f.path, dir: join(f.directory, 'invalid'), port })).rejects.toThrow(/Port/);
    await expect(startServer({ feed: f.path, dir: join(f.directory, 'occupied'), port: Number(new URL(f.origin).port) })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const stop = { id: randomUUID(), text: 'stop' }; await f.post('/threads/ses_fixtureA', stop); expect(next(f.directory).id).toBe(stop.id);
    await new Promise<void>((resolve) => { f.server.close(() => resolve()); f.server.closeAllConnections(); });
    const restarted = await startServer({ feed: f.path, dir: f.directory, port: Number(new URL(f.origin).port), token: f.token });
    try { expect(restarted.origin).toBe(f.origin); expect(queueProtocol(f.directory)).toEqual(protocol); expect(next(f.directory)).toBeNull(); }
    finally { await new Promise<void>((resolve) => { restarted.server.close(() => resolve()); restarted.server.closeAllConnections(); }); }
  } finally { await f.close(); }
  evidence.recordAssertionEvidence('Versioned deployment cannot accidentally resume or fall back', 'Durable protocol sentinel has no event and makes old reader shape fail before claim; authenticated epoch survives same-port restart and stop remains latched. Invalid bounded ports reject and occupied loopback port reports EADDRINUSE with no fallback.', true);
});

test('a restarted feed blocks old queued work and old-target controls without replaying them', async ({ evidence }) => {
  const f = await fixture();
  try {
    const original = f.decide(); await f.post('/decisions', original);
    await new Promise<void>((resolve) => { f.server.close(() => resolve()); f.server.closeAllConnections(); });
    const changed = validateFeed({ ...f.feed, metadata: { source: 'New synthetic evidence' } });
    writeFileSync(f.path, JSON.stringify(changed));
    const live = await startServer({ feed: f.path, dir: f.directory });
    try {
      expect(next(f.directory)).toBeNull();
      expect(readLog(f.directory, 'results.jsonl').at(-1).text).toContain('Stale feed');
      const response = await fetch(live.origin + '/controls', { method: 'POST', headers: { Origin: live.origin, 'X-Review-Token': live.token, 'Content-Type': 'application/json' }, body: JSON.stringify(f.control(original.id, { snapshot: JSON.stringify({ ...changed, decisions: [] }) })) });
      expect(response.status).toBe(409);
      expect(readLog(f.directory, 'decisions.jsonl')).toHaveLength(1);
    } finally { await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); }); }
    evidence.recordAssertionEvidence('Stale evidence never gains execution or replacement authority', 'Restart with changed provenance blocks the frozen old request before returning work. A new current snapshot does not authorize a control against the old target.', true);
  } finally { await f.close(); }
});
