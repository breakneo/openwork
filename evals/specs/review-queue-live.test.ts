import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, symlinkSync, linkSync, chmodSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { startServer } from '../../tools/review-queue/serve.mjs';
import { validateFeed } from '../../tools/review-queue/core.mjs';
import { buildHtml } from '../../tools/review-queue/build.mjs';
import { MAX_BODY, MAX_FEED, MAX_LOG } from '../../tools/review-queue/protocol.mjs';

const sourceDirectory = fileURLToPath(new URL('../../tools/review-queue/', import.meta.url));
const at = '2026-01-01T12:00:00.000Z';
type Live = Awaited<ReturnType<typeof startServer>>;

function item(id: string) {
  return { id, kind: 'session', title: 'Synthetic completed explanation', recommended_action: 'archive',
    group: 'openwork', if_approved: 'Review archive eligibility using current evidence.',
    if_declined: 'Keep this session.', question: '', protected: false, workspace_id: 'ws_example', evidence: [{ label: 'Pinned', value: 'no' }, { label: 'Status', value: 'idle' }] };
}

function source() {
  return validateFeed({ items: [item('ses_exampleA'), item('ses_exampleB'),
    { ...item('ses_mixed'), group: 'another-group' },
    { ...item('ses_proposal'), kind: 'proposal' },
    { ...item('ses_alias'), recommended_action: 'review_archive_eligibility' },
    { ...item('ses_locked'), locked: true },
    { ...item('ses_external'), group: 'external-mission', locked: false },
    { ...item('ses_none'), recommended_action: 'none', locked: true },
    { ...item('ses_night'), title: 'NIGHT REVIEW — synthetic' },
    { ...item('ses_nooutcome'), if_approved: '' },
    { ...item('/example/worktree'), kind: 'worktree' },
    ...[7, 8].map((number) => ({ ...item(`https://github.com/example/demo/pull/${number}`), kind: 'pr',
      recommended_action: 'review_merge_candidate', pr_url: `https://github.com/example/demo/pull/${number}`, head_sha: 'a'.repeat(40) }))],
    metadata: { source: 'Synthetic live protocol fixture', collection_caveat: 'Never a live service identity.' } });
}

function decision(feed = source(), patch: object = {}) {
  return { id: randomUUID(), ids: ['ses_exampleA'], action: 'approve', comment: '', decided_at: at,
    snapshot: JSON.stringify({ ...feed, decisions: [] }), ...patch };
}

function http(live: Pick<Live, 'origin' | 'token'>, path: string, options: { method?: string; body?: unknown; raw?: string; headers?: OutgoingHttpHeaders } = {}) {
  return new Promise<{ status: number; text: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const data = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const headers = Object.fromEntries(Object.entries({ Origin: live.origin, 'X-Review-Token': live.token,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers }).filter(([, value]) => value !== undefined));
    const req = request({ hostname: '127.0.0.1', port: new URL(live.origin).port, path,
      method: options.method ?? (data === undefined ? 'GET' : 'POST'), headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode === undefined) { reject(new Error('Missing HTTP status')); return; }
        resolve({ status: res.statusCode, text, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Bounded local request timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

async function close(live: Live) {
  if (!live.server.listening) return;
  await new Promise<void>((resolve, reject) => {
    live.server.close((error) => error ? reject(error) : resolve());
    live.server.closeAllConnections();
  });
}

async function withLive(run: (live: Live, feedPath: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'review-queue-live-'));
  const feedPath = join(root, 'feed.json');
  writeFileSync(feedPath, JSON.stringify(source()), { mode: 0o600 });
  const live = await startServer({ feed: feedPath, dir: join(root, 'queue') });
  try { await run(live, feedPath); }
  finally { await close(live); rmSync(root, { recursive: true, force: true }); }
}

function records(directory: string, name = 'results.jsonl') {
  const text = readFileSync(join(directory, name), 'utf8');
  return text ? text.trimEnd().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.kind !== 'protocol') : [];
}

function execute(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(sourceDirectory, 'executor.mjs'), '--dir', directory, ...args],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
}

function next(directory: string) {
  const run = execute(directory, 'next');
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout);
}

test('live queue binds random loopback, protects every data route and refuses cross-origin or unlisted requests', async ({ evidence }) => {
  await withLive(async (live) => {
    expect(live.origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    expect(live.server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(live.token.length).toBeGreaterThanOrEqual(32);
    expect(live.url).toBe(`${live.origin}/#token=${encodeURIComponent(live.token)}`);
    expect(statSync(live.directory).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(live.directory, '.gitignore'), 'utf8')).toBe('*\n');
    for (const name of ['server.json', 'decisions.jsonl', 'results.jsonl']) expect(statSync(join(live.directory, name)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(live.directory, 'server.json'), 'utf8'))).toEqual({ origin: live.origin, token: live.token });
    expect(JSON.parse((await http(live, '/server.json')).text)).toEqual({ origin: live.origin, token: live.token });
    for (const path of ['/server.json', '/feed', '/protocol', '/results?since=0', '/decisions', '/controls', '/reads', '/deliverables/ses_exampleA.md', '/threads/ses_exampleA']) {
      const body = ['/controls', '/reads'].includes(path) ? {} : path === '/decisions' ? decision() : path.startsWith('/threads') ? { id: randomUUID(), text: 'Please clarify' } : undefined;
      for (const token of [undefined, 'wrong', 'x'.repeat(live.token.length)]) {
        const response = await http(live, path, { body, headers: { 'X-Review-Token': token } });
        expect(response.status).toBe(401);
        expect(response.text).not.toContain(live.token);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
    }
    for (const headers of [{ Host: 'localhost' }, { Host: 'evil.example' }, { Origin: 'null' }, { Origin: 'https://evil.example' },
      { Origin: `${live.origin}/` }, { Origin: [live.origin, live.origin] }, { 'X-Review-Token': [live.token, live.token] },
      { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      expect((await http(live, '/feed', { headers })).status).toBe(403);
    }
    expect((await http(live, '/decisions', { body: decision(), headers: { Origin: undefined } })).status).toBe(403);
    expect((await http(live, '/feed', { headers: { Origin: undefined } })).status).toBe(200);
    for (const path of ['/server.json?token=x', '/feed?token=x', '/index.html?token=x', '/results?since=-1', '/results?since=0&since=1',
      '/results?since=1.5', '/results?since=01', '/results?since=0&x=1', '/results?token=x', '/results/../feed', '/%66eed', '/.gitignore',
      '/decisions.jsonl', '/results.jsonl', '/core.mjs', '/ui.js', '/../../package.json', '/favicon.ico']) {
      expect((await http(live, path)).status).toBe(404);
    }
    for (const method of ['OPTIONS', 'HEAD', 'PUT', 'DELETE', 'POST']) expect((await http(live, '/feed', { method })).status).toBe(404);
    expect((await http(live, '/results?since=9007199254740992')).status).toBe(400);
    expect((await http(live, '/results?since=1')).status).toBe(409);
    expect(records(live.directory)).toEqual([]);
    expect(records(live.directory, 'decisions.jsonl')).toEqual([]);
  });
  evidence.recordAssertionEvidence('Loopback authentication and route allowlist fail closed', 'Random IPv4 loopback binding, private files, token headers, exact Host/Origin, duplicate headers, missing POST origin, no CORS, route/query/method denial and zero rejected-request side effects asserted.', true);
});

test('live HTML uses source build without secrets; startup feed stays frozen until restart', async ({ evidence }) => {
  await withLive(async (live, feedPath) => {
    const template = readFileSync(join(sourceDirectory, 'template.html'), 'utf8');
    const core = readFileSync(join(sourceDirectory, 'core.mjs'), 'utf8');
    const ui = readFileSync(join(sourceDirectory, 'ui.js'), 'utf8');
    const offline = buildHtml(source(), template, core, ui);
    expect(offline).toContain("connect-src 'none'");
    const expected = buildHtml({ items: [], decisions: [] }, template.replace("connect-src 'none'", "connect-src 'self'"), core, ui);
    for (const path of ['/', '/index.html']) {
      const response = await http(live, path, { headers: { 'X-Review-Token': undefined, Origin: undefined } });
      expect(response.status).toBe(200);
      expect(response.text).toBe(expected);
      expect(response.text).not.toContain(live.token);
      expect(response.text).not.toContain('Synthetic completed explanation');
      expect(response.text).not.toContain('ses_exampleA');
      expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    }
    const changed = { ...source(), metadata: { source: 'Changed source envelope' } };
    writeFileSync(feedPath, JSON.stringify(changed));
    expect(JSON.parse((await http(live, '/feed')).text)).toEqual(source());
    expect((await http(live, '/decisions', { body: decision(changed) })).status).toBe(409);
    const body = decision();
    const receipt = JSON.parse((await http(live, '/decisions', { body })).text);
    expect(receipt.items).toEqual([source().items[0]]);
    expect(receipt.decisions).toEqual([{ id: 'ses_exampleA', action: 'approve', comment: '', batch_id: body.id, decided_at: at }]);
    expect(JSON.parse((await http(live, '/feed')).text).decisions).toEqual([]);
    await close(live);
    const restarted = await startServer({ feed: feedPath, dir: live.directory, token: 't'.repeat(32) });
    try {
      expect(JSON.parse((await http(restarted, '/feed')).text)).toEqual(validateFeed(changed));
      expect((await http(restarted, '/decisions', { body: decision() })).status).toBe(409);
      expect(JSON.parse((await http(restarted, '/decisions', { body })).text)).toEqual(receipt);
      expect(records(live.directory)).toHaveLength(1);
    } finally { await close(restarted); }
  });
  evidence.recordAssertionEvidence('Source-generated live HTML and restart-only snapshots', 'Offline CSP remains none, live CSP is self, unauthenticated index contains no generated token, changing disk feed has no effect until restart, stale envelopes reject, frozen snapshots persist and identical old requests return original receipts after restart.', true);
});

test('decisions validate exact bodies, locked items, homogeneous batches, comments and timestamps without partial writes', async ({ evidence }) => {
  await withLive(async (live) => {
    for (const patch of [{ ids: [] }, { ids: ['ses_exampleA', 'ses_exampleA'] }, { ids: ['missing'] }, { ids: null },
      { ids: ['ses_exampleA', 'ses_mixed'] }, { ids: ['ses_exampleA', 'ses_proposal'] }, { ids: ['ses_exampleA', 'ses_alias'] },
      { action: 'merge' }, { comment: null }, { comment: 'x'.repeat(10001) }, { comment: '\u0000' }, { id: 'unsafe/identity' },
      { extra: true }, { decided_at: '2026-02-30T12:00:00Z' }, { decided_at: '2026-01-01T12:00:00' },
      { action: 'ask_info', comment: '  ' }, { action: 'request_changes', comment: '' }, { action: 'comment', comment: '' },
      { ids: ['ses_nooutcome'] }, { ids: ['https://github.com/example/demo/pull/7', 'https://github.com/example/demo/pull/8'] }]) {
      expect((await http(live, '/decisions', { body: decision(source(), patch) })).status).toBe(400);
    }
    for (const id of ['ses_locked', 'ses_external', 'ses_none', 'ses_night', '/example/worktree']) {
      for (const action of ['approve', 'decline', 'defer', 'ask_info', 'request_changes', 'comment']) {
        expect((await http(live, '/decisions', { body: decision(source(), { ids: [id], action, comment: 'Reviewed text' }) })).status).toBe(400);
      }
      expect((await http(live, `/threads/${encodeURIComponent(id)}`, { body: { id: randomUUID(), text: 'stop' } })).status).toBe(400);
    }
    for (const body of [null, [], {}, { id: randomUUID() }]) expect((await http(live, '/decisions', { body })).status).toBe(400);
    expect((await http(live, '/decisions', { raw: '{broken' })).status).toBe(400);
    expect((await http(live, '/decisions', { body: decision(), headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await http(live, '/decisions', { body: decision(), headers: { 'Content-Encoding': 'gzip' } })).status).toBe(415);
    expect((await http(live, '/decisions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': MAX_BODY + 1 } })).status).toBe(413);
    expect((await http(live, '/decisions', { raw: ' '.repeat(MAX_BODY + 1), headers: { 'Transfer-Encoding': 'chunked' } })).status).toBe(413);
    expect(records(live.directory)).toEqual([]);
    expect(records(live.directory, 'decisions.jsonl')).toEqual([]);
    const body = decision(source(), { ids: ['ses_exampleA', 'ses_exampleB'], comment: 'Scoped archive intent only' });
    const response = await http(live, '/decisions', { body });
    expect(response.status).toBe(200);
    const receipt = JSON.parse(response.text);
    expect(receipt).toEqual({ id: body.id, decision_id: body.id, item_ids: body.ids, kind: 'decision', action: 'approve', status: 'queued',
      text: body.comment, at, items: source().items.slice(0, 2), decisions: body.ids.map((id) => ({ id, action: 'approve', comment: body.comment, batch_id: body.id, decided_at: at })) });
    expect((await http(live, '/decisions', { body: decision(source(), { decided_at: '2025-12-31T12:00:00Z' }) })).status).toBe(400);
    expect(records(live.directory)).toEqual([receipt]);
    const singleMerge = decision(source(), { ids: ['https://github.com/example/demo/pull/7'] });
    expect((await http(live, '/decisions', { body: singleMerge })).status).toBe(200);
    expect(records(live.directory)).toHaveLength(2);
    expect(records(live.directory).every((entry) => entry.status === 'queued')).toBe(true);
  });
  evidence.recordAssertionEvidence('Decision validation is atomic and shares core policy', 'Exact receipt/core events, homogeneous archive batch and single merge intent accepted; malformed fields, mixed batches, all locked actions, missing outcomes/comments, stale chronology and bulk merge approvals rejected without appends or external execution.', true);
});

test('fresh change-to-merge retains the exact PR head and rejects bulk replacement approval', async ({ evidence }) => {
  const pr = 'https://github.com/example/demo/pull/7';
  await withLive(async (live) => {
    const original = decision(source(), { ids: [pr], action: 'decline' });
    expect((await http(live, '/decisions', { body: original })).status).toBe(200);
    const control = { id: randomUUID(), target_id: original.id, mode: 'change', replacement: { action: 'approve', comment: 'Explicit new approval for this frozen PR/head only.', decided_at: at }, text: 'Change the reviewed decision', snapshot: original.snapshot };
    const response = await http(live, '/controls', { body: control });
    expect(response.status).toBe(200);
    const receipt = JSON.parse(response.text);
    const claimed = next(live.directory);
    expect(claimed).toMatchObject({ id: receipt.replacement_id, action: 'approve', target_id: original.id, control_id: control.id, item_ids: [pr] });
    expect(claimed.items[0]).toMatchObject({ pr_url: pr, head_sha: 'a'.repeat(40) });
    expect(claimed.decisions[0]).toMatchObject({ action: 'approve', comment: control.replacement.comment, batch_id: claimed.id });
    expect((await http(live, '/controls', { body: { ...control, id: randomUUID(), target_id: claimed.id, snapshot: 'different head snapshot' } })).status).toBe(409);
    expect(next(live.directory)).toBeNull();
  });
  await withLive(async (live) => {
    const original = decision(source(), { ids: [pr, 'https://github.com/example/demo/pull/8'], action: 'decline' });
    expect((await http(live, '/decisions', { body: original })).status).toBe(200);
    const control = { id: randomUUID(), target_id: original.id, mode: 'change', replacement: { action: 'approve', comment: '', decided_at: at }, text: '', snapshot: original.snapshot };
    expect((await http(live, '/controls', { body: control })).status).toBe(400);
    expect(records(live.directory, 'decisions.jsonl')).toHaveLength(1);
    expect(next(live.directory).action).toBe('decline');
  });
  evidence.recordAssertionEvidence('Replacement merge approval is fresh, exact and per-PR', 'New explicit single-PR approval is stored with its original exact PR URL/head and control references, then claimed once. A different snapshot rejects and a homogeneous two-PR declined batch cannot be changed into bulk merge approval. No GitHub mutation is performed.', true);
});

test('request idempotency is durable and threads use encoded identities, UUIDs and stop priority', async ({ evidence }) => {
  await withLive(async (live) => {
    const body = decision();
    const responses = await Promise.all([http(live, '/decisions', { body }), http(live, '/decisions', { body })]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[1].text).toBe(responses[0].text);
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    expect((await http(live, '/decisions', { body: reordered })).text).toBe(responses[0].text);
    for (const patch of [{ comment: 'Changed' }, { extra: true }, { action: 'invalid' }, { snapshot: null }]) {
      expect((await http(live, '/decisions', { body: { ...body, ...patch } })).status).toBe(409);
    }
    expect((await http(live, '/threads/ses_exampleA', { body: { id: body.id, text: 'Changed route' } })).status).toBe(409);
    for (const thread of [{ id: 'not-uuid', text: 'hello' }, { id: randomUUID(), text: '' }, { id: randomUUID(), text: '\u0000' },
      { id: randomUUID(), text: 'x'.repeat(10001) }, { id: randomUUID(), text: 'hello', extra: true }]) {
      expect((await http(live, '/threads/ses_exampleA', { body: thread })).status).toBe(400);
    }
    for (const path of ['/threads/%ZZ', '/threads/%73es_exampleA']) expect((await http(live, path, { body: { id: randomUUID(), text: 'hello' } })).status).toBe(400);
    expect((await http(live, '/threads/missing', { body: { id: randomUUID(), text: 'hello' } })).status).toBe(404);
    const prId = 'https://github.com/example/demo/pull/7';
    const marker = join(live.directory, 'must-not-exist');
    const thread = { id: randomUUID(), text: `Literal $(touch '${marker}') <script>data</script>` };
    const path = `/threads/${encodeURIComponent(prId)}`;
    const response = await http(live, path, { body: thread });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ id: thread.id, decision_id: thread.id, item_ids: [prId], kind: 'thread',
      action: 'ask_info', status: 'queued', text: thread.text, author: 'human', decisions: [] });
    expect((await http(live, path, { body: thread })).text).toBe(response.text);
    expect((await http(live, path, { body: { ...thread, text: 'changed' } })).status).toBe(409);
    const stop = { id: randomUUID(), text: ' STOP\n' };
    expect((await http(live, '/threads/ses_exampleA', { body: stop })).status).toBe(200);
    expect(records(live.directory)).toHaveLength(3);
    expect(records(live.directory, 'decisions.jsonl')).toHaveLength(3);
    expect(next(live.directory)).toMatchObject({ id: stop.id, action: 'stop', items: [source().items[0]] });
    expect(records(live.directory).at(-1)).toMatchObject({ decision_id: stop.id, status: 'rechecking', action: 'stop', item_ids: ['ses_exampleA'] });
    const stopped = execute(live.directory, 'result', stop.id, 'stopped', 'Stopped agent loop before any external action.');
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(next(live.directory)).toBeNull();
    expect(records(live.directory).some((event) => event.decision_id === body.id && event.status === 'rechecking')).toBe(false);
    expect(records(live.directory).some((event) => event.decision_id === thread.id && event.status === 'rechecking')).toBe(false);
    expect(existsSync(marker)).toBe(false);
    const full = JSON.parse((await http(live, '/results?since=0')).text);
    const inputs = records(live.directory, 'decisions.jsonl').map((record) => record.event);
    const current_ids = [body.id, thread.id, stop.id];
    expect(full).toEqual({ cursor: records(live.directory).length, events: records(live.directory), inputs, current_ids });
    expect(JSON.parse((await http(live, `/results?since=${full.cursor}`)).text)).toEqual({ cursor: full.cursor, events: [], inputs, current_ids });
    expect(JSON.parse((await http(live, '/results?since=3')).text).events).toEqual(full.events.slice(3));
  });
  evidence.recordAssertionEvidence('Durable idempotency and per-item human threads', 'Concurrent/equivalent key-order requests produce one original receipt, changed bodies/routes conflict, encoded PR thread identity and UUID/text bounds validated; stop claims first and durably prevents later work claims, cursors return exact suffixes and claimed work never reappears.', true);
});

test('executor subprocess persists claims before output, skips concurrent claims and appends only bounded result states', async ({ evidence }) => {
  await withLive(async (live) => {
    const body = decision(source(), { ids: ['ses_exampleA', 'ses_exampleB'] });
    expect((await http(live, '/decisions', { body })).status).toBe(200);
    expect(execute(live.directory, 'result', body.id, 'done', 'Not claimed').status).toBe(1);
    const first = next(live.directory);
    expect(first).toEqual(records(live.directory, 'decisions.jsonl')[0].event);
    expect(first.items).toEqual(source().items.slice(0, 2));
    expect(records(live.directory).at(-1)).toMatchObject({ decision_id: first.id, status: 'rechecking', item_ids: body.ids });
    const claimId = records(live.directory).at(-1).id;
    expect((await http(live, '/decisions', { body: decision(source(), { id: claimId }) })).status).toBe(409);
    expect(next(live.directory)).toBeNull();
    for (const status of ['rechecking', 'done', 'archived', 'merged', 'blocked', 'reply', 'deferred', 'declined', 'waiting', 'stopped']) {
      const run = execute(live.directory, 'result', body.id, status, `Synthetic ${status} receipt`);
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ decision_id: body.id, status, text: `Synthetic ${status} receipt`,
        item_ids: body.ids, kind: status === 'reply' ? 'thread' : 'status', author: 'agent' });
      const count = records(live.directory).length;
      expect(execute(live.directory, 'result', body.id, status, `Synthetic ${status} receipt`).stdout).toBe(run.stdout);
      expect(records(live.directory)).toHaveLength(count);
    }
    const before = readFileSync(join(live.directory, 'results.jsonl'), 'utf8');
    for (const args of [['result', body.id, 'execute', 'no'], ['result', 'unknown', 'done', 'no'], ['result', body.id, 'done', ''],
      ['result', body.id, 'done', 'x'.repeat(10001)], ['result', body.id, 'done', 'text', 'extra'], ['shell', 'echo'], ['next', '--unknown', 'x']]) {
      expect(execute(live.directory, ...args).status).toBe(1);
    }
    expect(readFileSync(join(live.directory, 'results.jsonl'), 'utf8')).toBe(before);
    expect((await http(live, '/decisions', { body: decision(source(), { action: 'defer' }) })).status).toBe(409);
    const second = decision(source(), { ids: ['ses_alias'], action: 'defer' });
    expect((await http(live, '/decisions', { body: second })).status).toBe(200);
    const workers = [0, 1].map(() => {
      const child = spawn(process.execPath, [join(sourceDirectory, 'executor.mjs'), 'next', '--dir', live.directory], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.resume();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      return once(child, 'close').then(([code]) => ({ code, stdout })).finally(() => clearTimeout(timer));
    });
    const workersDone = await Promise.all(workers);
    expect(workersDone.filter((worker) => worker.code === 0 && JSON.parse(worker.stdout)?.id === second.id)).toHaveLength(1);
    expect(records(live.directory).filter((event) => event.decision_id === second.id && event.status === 'rechecking')).toHaveLength(1);
    expect(next(live.directory)).toBeNull();
  });
  evidence.recordAssertionEvidence('Filesystem-only executor is at-most-once on claim', 'Independent next/result processes prove persisted claims, full item snapshots, no replay after abandoning a claim, one winner across concurrent workers, all supported states and reply threads, duplicate-result stability and rejection without mutation.', true);
});

test('server CLI honors default private directory and fragment token without supporting extra options', async ({ evidence }) => {
  const root = mkdtempSync(join(tmpdir(), 'review-queue-cli-'));
  const feedPath = join(root, 'feed.json');
  writeFileSync(feedPath, JSON.stringify(source()), { mode: 0o600 });
  const script = join(sourceDirectory, 'serve.mjs');
  for (const args of [[], ['--feed', feedPath, '--port', '70000'], ['--feed', feedPath, '--token', 'short'],
    ['--feed', feedPath, '--feed', feedPath], ['--feed', feedPath, 'extra']]) {
    const failed = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 5000 });
    expect(failed.status).toBe(1);
    expect(existsSync(join(root, 'reports'))).toBe(false);
  }
  const token = 'Synthetic-token-with-fragment-#&?=characters';
  const child = spawn(process.execPath, [script, '--feed', feedPath, '--token', token], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  let printed = '';
  child.stderr.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk) => { printed += chunk; if (printed.includes('\n')) resolve(); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Server exited before publishing its URL')));
    });
    const directory = join(root, 'reports', 'review-queue');
    const config: { origin: string; token: string } = JSON.parse(readFileSync(join(directory, 'server.json'), 'utf8'));
    expect(config.token).toBe(token);
    expect(printed.trim()).toBe(`${config.origin}/#token=${encodeURIComponent(token)}`);
    expect((await http(config, '/feed')).status).toBe(200);
    expect((await http(config, '/')).text).not.toContain(token);
    expect(statSync(join(directory, 'server.json')).mode & 0o777).toBe(0o600);
    const idle = spawnSync(process.execPath, [join(sourceDirectory, 'executor.mjs'), 'next'], { cwd: root, encoding: 'utf8', timeout: 5000 });
    expect(idle.status, idle.stderr).toBe(0);
    expect(JSON.parse(idle.stdout)).toBeNull();
    child.kill('SIGTERM');
    expect((await exited)[0]).toBe(0);
    expect(existsSync(join(directory, '.server.lock'))).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    clearTimeout(timeout);
    rmSync(root, { recursive: true, force: true });
  }
  evidence.recordAssertionEvidence('CLI defaults and strict option parsing match HTTP protocol', 'Real server subprocess publishes only a fragment-token URL, writes private default reports/review-queue metadata, serves authenticated requests, exits cleanly on SIGTERM, and rejects missing, duplicate and unsupported options before creating reports.', true);
});

test('startup, bounded storage and crash recovery refuse unsafe files or uncertain inputs', async ({ evidence }) => {
  await withLive(async (live, feedPath) => {
    await expect(startServer({ feed: feedPath, dir: live.directory, token: 'short' })).rejects.toThrow(/Token/);
    await expect(startServer({ feed: feedPath, dir: live.directory })).rejects.toThrow(/locked/);
    const body = decision();
    expect((await http(live, '/decisions', { body })).status).toBe(200);
    writeFileSync(join(live.directory, 'results.jsonl'), '', { mode: 0o600 });
    expect(execute(live.directory, 'next').status).toBe(0);
    expect((await http(live, '/decisions', { body })).status).toBe(200);
    expect(records(live.directory)).toHaveLength(2);
    expect(records(live.directory, 'decisions.jsonl')).toHaveLength(1);
    writeFileSync(join(live.directory, '.ledger.lock'), '', { mode: 0o600 });
    expect((await http(live, '/decisions', { body: decision() })).status).toBe(503);
    expect(execute(live.directory, 'next').status).toBe(1);
    rmSync(join(live.directory, '.ledger.lock'));
    const before = readFileSync(join(live.directory, 'results.jsonl'), 'utf8');
    writeFileSync(join(live.directory, 'results.jsonl'), before + '{partial');
    expect((await http(live, '/results?since=0')).status).toBe(503);
    expect(execute(live.directory, 'next').status).toBe(1);
    const inputsBefore = readFileSync(join(live.directory, 'decisions.jsonl'), 'utf8');
    expect((await http(live, '/decisions', { body: decision() })).status).toBe(503);
    expect(readFileSync(join(live.directory, 'decisions.jsonl'), 'utf8')).toBe(inputsBefore);
    writeFileSync(join(live.directory, 'results.jsonl'), before + '{invalid}\n');
    expect((await http(live, '/results?since=0')).status).toBe(503);
    writeFileSync(join(live.directory, 'results.jsonl'), before);
    truncateSync(join(live.directory, 'results.jsonl'), MAX_LOG + 1);
    expect((await http(live, '/results?since=0')).status).toBe(507);
    writeFileSync(join(live.directory, 'results.jsonl'), before);
    await close(live);
    const outside = join(live.directory, 'outside');
    writeFileSync(outside, 'untouched', { mode: 0o600 });
    rmSync(join(live.directory, 'server.json'));
    symlinkSync(outside, join(live.directory, 'server.json'));
    await expect(startServer({ feed: feedPath, dir: live.directory })).rejects.toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    rmSync(join(live.directory, 'server.json'));
    linkSync(outside, join(live.directory, 'server.json'));
    await expect(startServer({ feed: feedPath, dir: live.directory })).rejects.toThrow(/single-link/);
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    rmSync(join(live.directory, 'server.json'));
    chmodSync(join(live.directory, 'decisions.jsonl'), 0o644);
    await expect(startServer({ feed: feedPath, dir: live.directory })).rejects.toThrow(/0600/);
    expect(existsSync(join(live.directory, '.server.lock'))).toBe(false);
    chmodSync(join(live.directory, 'decisions.jsonl'), 0o600);
    writeFileSync(feedPath, '{"items":[{"id":"bad"}]}');
    await expect(startServer({ feed: feedPath, dir: live.directory })).rejects.toThrow();
    truncateSync(feedPath, MAX_FEED + 1);
    await expect(startServer({ feed: feedPath, dir: live.directory })).rejects.toThrow(/bounded/);
  });
  evidence.recordAssertionEvidence('Privacy bounds and crash ambiguity fail closed', 'Weak tokens, second server, unpublished work, stale lock, truncated/full logs, symlink/hardlink metadata, public log mode, invalid/oversized feed rejected; exact request can finish publication without duplicating queued work and protected target bytes remain unchanged.', true);
});
