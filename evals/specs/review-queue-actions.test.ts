import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { validateFeed, applyDecision, exportDecisions, canArchive, canClosePr, canReclaim, reclaimCommand, deliveryIdentity } from '../../tools/review-queue/core.mjs';
import { startServer } from '../../tools/review-queue/serve.mjs';
import { next, result } from '../../tools/review-queue/executor.mjs';

const at = '2026-01-01T12:00:00.000Z';
const evidence = [{ label: 'Pinned', value: 'no' }, { label: 'Status', value: 'idle' }];
const session = { id: 'ses_universal', workspace_id: 'ws_fixture', kind: 'session', title: 'Synthetic proposal', recommended_action: 'review', question: 'Revise this proposal?', if_approved: 'Review this proposal.', group: 'another-workspace', evidence };
function grant(action: string, target_id: string) { return { action, target_id, authorized: true, source: 'explicit-human', text: 'Explicitly authorize this exact operation and target.', provenance: 'Synthetic reviewed human authorization', at }; }

test('universal archive is an exact human session instruction independent of recommendation and requires positive safety', async ({ evidence: proof }) => {
  const source = validateFeed({ items: [session] });
  expect(canArchive(source.items[0])).toBe(true);
  const archived = applyDecision(source, [session.id], 'archive', '', at, 'archive-request');
  const plan = exportDecisions(archived, at).instructions;
  expect(plan).toContain('session.archive {"sessionId":"ses_universal","workspaceId":"ws_fixture"}');
  expect(plan).toContain('independent of the recommendation');
  expect(plan).not.toContain('MANUAL AUTHORIZATION REQUIRED');
  for (const patch of [{ locked: true }, { group: 'external-mission' }, { title: 'SUPAUD-synthetic-external' }, { archived: true }, { evidence: [] }, { evidence: [{ label: 'Pinned', value: 'yes' }, { label: 'Status', value: 'idle' }] }, { evidence: [{ label: 'Pinned', value: 'no' }, { label: 'Status', value: 'busy' }] }, { evidence: [...evidence, { label: 'Pinned', value: 'yes' }] }]) {
    const unsafe = validateFeed({ items: [{ ...session, ...patch }] });
    expect(canArchive(unsafe.items[0])).toBe(false);
    expect(() => applyDecision(unsafe, [session.id], 'archive', '', at, 'blocked')).toThrow();
  }
  const none = validateFeed({ items: [{ ...session, recommended_action: 'none', if_approved: '' }] });
  expect(canArchive(none.items[0])).toBe(true);
  expect(applyDecision(none, [session.id], 'archive', '', at, 'none-archive').decisions[0].action).toBe('archive');
  proof.recordAssertionEvidence('Universal Archive is not proposal approval', 'Non-archive and none recommendations produce the exact session.archive intent through the archive action. Pinned, busy, missing/conflicting safety, archived and hard/external locks block. Cross-workspace identity remains exact; no external action is performed.', true);
});

test('Close PR and Reclaim require typed exact-target human authorization, never narrative inference', async ({ evidence: proof }) => {
  const pr = { id: 'pr-7', kind: 'pr', title: 'Synthetic PR', recommended_action: 'review', question: 'Approve the proposal?', if_approved: 'Close this PR after discussion.', pr_url: 'https://github.com/example/demo/pull/7', head_sha: 'a'.repeat(40), evidence: [{ label: 'State', value: 'OPEN' }] };
  const unknown = validateFeed({ items: [pr] });
  expect(canClosePr(unknown.items[0])).toBe(false);
  expect(exportDecisions(applyDecision(unknown, [pr.id], 'approve', '', at, 'proposal'), at).instructions).not.toContain('gh pr close');
  const permitted = validateFeed({ items: [{ ...pr, action_authorizations: [grant('close_pr', pr.id)] }] });
  expect(canClosePr(permitted.items[0])).toBe(true);
  expect(exportDecisions(applyDecision(permitted, [pr.id], 'close_pr', '', at, 'close'), at).instructions).toContain("gh pr close 'https://github.com/example/demo/pull/7'");
  expect(() => validateFeed({ items: [{ ...pr, action_authorizations: [grant('close_pr', 'pr-other')] }] })).toThrow(/exact item/);
  expect(canClosePr(validateFeed({ items: [{ ...pr, action_authorizations: [{ ...grant('close_pr', pr.id), authorized: null }] }] }).items[0])).toBe(false);
  const path = "/synthetic/tree's space";
  const tree = { id: path, kind: 'worktree', title: 'Synthetic tree', recommended_action: 'review_worktree_removal', action_authorizations: [grant('reclaim', path)] };
  const source = validateFeed({ items: [tree] });
  expect(canReclaim(source.items[0])).toBe(true);
  expect(reclaimCommand(source.items[0])).toBe("git worktree remove -- '/synthetic/tree'\\''s space'");
  const approved = applyDecision(source, [path], 'approve', '', at, 'reclaim');
  expect(approved.decisions[0].action).toBe('approve');
  expect(exportDecisions(approved, at).instructions).toContain(reclaimCommand(source.items[0]));
  for (const patch of [{ locked: true }, { group: 'external-mission' }, { action_authorizations: [] }]) expect(canReclaim(validateFeed({ items: [{ ...tree, ...patch }] }).items[0])).toBe(false);
  proof.recordAssertionEvidence('Destructive secondary actions need typed authority', 'A close-shaped proposal does not authorize PR closure. Exact typed human permission enables Close PR; mismatched/unknown permission rejects or omits it. Reclaim requires exact absolute worktree identity, emits a POSIX-quoted command including apostrophe/space, records approve only, and never overrides hard/external locks. No shell command is executed.', true);
});

test('server enforces universal archive read/safety gates and its archived result supports guarded compensation', async ({ evidence: proof }) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-universal-'));
  const path = join(directory, 'feed.json');
  const feed = validateFeed({ items: [{ ...session, delivery: { kind: 'chat-only', completeness: 'complete', source: 'session.read', provenance: 'Synthetic complete reply', observed_at: at, exchanges: [{ question: 'Explain?', at, answers: [{ text: 'Complete synthetic answer.', at }] }] } }, { ...session, id: 'ses_pinned', evidence: [{ label: 'Pinned', value: 'yes' }, { label: 'Status', value: 'idle' }] }] });
  writeFileSync(path, JSON.stringify(feed));
  const live = await startServer({ feed: path, dir: join(directory, 'queue') });
  const snapshot = JSON.stringify({ ...feed, decisions: [] });
  const post = async (route: string, body: object) => fetch(live.origin + route, { method: 'POST', headers: { Origin: live.origin, 'X-Review-Token': live.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const decision = { id: randomUUID(), ids: [session.id], action: 'archive', comment: '', decided_at: at, snapshot };
  try {
    expect((await post('/decisions', decision)).status).toBe(409);
    expect((await post('/decisions', { ...decision, id: randomUUID(), ids: ['ses_pinned'] })).status).toBe(400);
    expect((await post('/reads', { id: randomUUID(), item_id: session.id, snapshot, deliverable: deliveryIdentity(feed.items[0]) })).status).toBe(200);
    expect((await post('/decisions', decision)).status).toBe(200);
    const work = next(live.directory); expect(work.action).toBe('archive'); expect(work.items[0].recommended_action).toBe('review');
    result(work.id, 'archived', 'Synthetic original archive verified', live.directory);
    expect((await post('/controls', { id: randomUUID(), target_id: work.id, mode: 'undo', replacement: null, text: '', snapshot })).status).toBe(200);
    const compensation = next(live.directory); expect(compensation.action).toBe('unarchive'); expect(compensation.target_id).toBe(work.id);
    result(compensation.id, 'unarchived', 'Verified restoration of original archive', live.directory, [{ item_id: session.id, status: 'unarchived', text: 'Exact target restored' }]);
    expect(next(live.directory)).toBeNull();
    proof.recordAssertionEvidence('Universal Archive uses the same read and compensation boundaries', 'Server denies unread chat delivery even when recommendation is review, denies pinned archive, accepts exact read then archive, claims the archive action and only reverses its verified effect through structured unarchive compensation.', true);
  } finally { await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); }); rmSync(directory, { recursive: true, force: true }); }
});
