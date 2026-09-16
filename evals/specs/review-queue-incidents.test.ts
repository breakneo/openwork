import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { evaluateArchiveGates, waitingReceipt } from '../../tools/review-queue/gates.mjs';
import { effectiveActionStatuses } from '../../tools/review-queue/core.mjs';

const observed_at = '2026-01-01T12:00:00.000Z';
const safe = { observed_at, authority: 'live-human', approved_item_id: 'ses_fixture', approved_action: 'archive', item_id: 'ses_fixture', identity_verified: true,
  title: 'Synthetic inactive reporting root', parentId: null, pinned: false, active_user_root: false, external_mission: false, busy: false, working: false, descendants: 'idle', safety_resolved: true,
  scope: 'outside', coordinator_worktree_clean: false, task_kind: 'reporting', task_worktree: { ownership: 'none', clean: false } };
const agent = { ...safe, authority: 'agent-initiated', agent_grant: true, scope: 'in-scope', purpose_complete: true, learnings_captured: true, pending_decision: false, remaining_work: false };

test('human archive authority does not inherit agent scope or coordinator worktree gates', async ({ evidence }) => {
  expect(evaluateArchiveGates(safe)).toMatchObject({ allowed: true, gate: 'passed', worktree: 'not applicable to explicit human instruction' });
  expect(evaluateArchiveGates(agent)).toMatchObject({ allowed: true, worktree: 'not applicable — no owned task worktree' });
  expect(evaluateArchiveGates({ ...agent, task_kind: 'watchdog' }).allowed).toBe(true);
  expect(evaluateArchiveGates({ ...agent, scope: 'outside' })).toMatchObject({ allowed: false, gate: 'scope' });
  expect(evaluateArchiveGates({ ...agent, task_kind: 'code' })).toMatchObject({ allowed: false, gate: 'owned-task-worktree' });
  expect(evaluateArchiveGates({ ...agent, task_worktree: { ownership: 'owned', clean: false } })).toMatchObject({ allowed: false, gate: 'owned-task-worktree-clean' });
  expect(evaluateArchiveGates({ ...safe, approved_item_id: 'ses_other' })).toMatchObject({ allowed: false, gate: 'authorization' });
  expect(evaluateArchiveGates({ ...safe, parentId: null, active_user_root: undefined })).toMatchObject({ allowed: false, gate: 'active-user-root' });
  evidence.recordAssertionEvidence('Explicit human instruction and actual ownership are distinct', 'Cross-workspace/outside-scope human approval passes applicable safety gates without agent-only scope/clean-tree heuristics. Reporting/watchdog with no owned task tree is N/A despite coordinator dirt. Agent scope and actual owned-tree dirt still block. Wrong authorization and unknown active-root identity block; parentId null alone supplies no activity conclusion.', true);
});

test('every still-applicable archive gate fails closed with deterministic owner and observation receipt', async ({ evidence }) => {
  const cases = [
    ['identity', { identity_verified: false }], ['pinned', { pinned: true }], ['pinned', { pinned: undefined }],
    ['active-user-root', { active_user_root: true }], ['external-mission', { external_mission: true }], ['external-mission', { title: 'SUPAUD-synthetic-external', external_mission: false }],
    ['busy', { busy: true }], ['working', { working: true }], ['descendants', { descendants: 'busy' }], ['descendants', { descendants: 'unknown' }], ['safety', { safety_resolved: false }],
  ];
  for (const [gate, patch] of cases) {
    if (typeof patch !== 'object') throw new Error('Invalid synthetic gate patch');
    const verdict = evaluateArchiveGates({ ...safe, ...patch });
    expect(verdict.allowed).toBe(false); expect(verdict.gate).toBe(gate); expect(verdict.status).toBe('blocked');
    expect(verdict.observed_at).toBe(observed_at); expect(verdict.who).toBeTruthy(); expect(verdict.unblock).toBeTruthy();
    expect(verdict.text).toContain(`gate=${gate}; observed_at=${observed_at}; who=`);
  }
  expect(evaluateArchiveGates({ ...safe, pinned: true, busy: true }).gate).toBe('pinned');
  const waiting = waitingReceipt({ owner: 'synthetic-owner', outstanding: 'Current evidence', observed_at, next_check_at: '2026-01-01T12:05:00.000Z' });
  expect(waiting.status).toBe('waiting'); expect(waiting.text).toContain('waiting is not done'); expect(waiting.text).toContain('next_check_at=');
  expect(() => waitingReceipt({ owner: '', outstanding: 'Evidence', observed_at, next_check_at: observed_at })).toThrow();
  evidence.recordAssertionEvidence('First failing safety gate is actionable and dated', 'Identity, pins, exact active user root, external prefix, busy, working, busy/unknown descendants and unresolved safety each deny authorization with named first gate, observation time, owner and unblock instruction. Waiting receipt names owner/outstanding/next-check and never means done. Pure evaluator only; no external dispatch is simulated.', true);
});

test('incident counts use latest decision/item outcome, preserve replies separately and retain historical blocked evidence', async ({ evidence }) => {
  const input = { id: 'approval', decision_id: 'approval', kind: 'decision', action: 'approve', status: 'queued', item_ids: ['ses_fixture'], at: observed_at, text: '' };
  const event = (id: string, status: string) => ({ ...input, id, kind: status === 'reply' ? 'thread' : 'status', status, text: `Synthetic ${status}` });
  const claimed = event('claim', 'rechecking');
  const blocked = event('blocked-one', 'blocked');
  const repeated = event('blocked-two', 'blocked');
  const history = [input, claimed, blocked, repeated, repeated];
  expect(effectiveActionStatuses([input])[0]).toMatchObject({ phase: 'accepted — not claimed', claimed: false });
  expect(effectiveActionStatuses([input, claimed])[0]).toMatchObject({ phase: 'claimed — running or unresolved', claimed: true });
  expect(effectiveActionStatuses(history).filter((entry) => entry.status === 'blocked')).toHaveLength(1);
  const archived = event('archived', 'archived');
  const rows = effectiveActionStatuses([...history, archived, event('reply-after-archive', 'reply')]);
  expect(rows).toHaveLength(1); expect(rows[0].status).toBe('archived'); expect(rows[0].historical_blocked).toHaveLength(2);
  expect(rows.filter((entry) => entry.status === 'blocked')).toHaveLength(0);
  const waiting = effectiveActionStatuses([input, claimed, event('waiting', 'waiting'), event('owner-reply', 'reply')]);
  expect(waiting[0].status).toBe('waiting'); expect(waiting[0].phase).toBe('waiting');
  const mixed = { ...event('mixed', 'blocked'), outcomes: [{ item_id: 'ses_fixture', status: 'archived', text: 'Verified target' }, { item_id: 'ses_other', status: 'blocked', text: 'Missing evidence' }] };
  const perTarget = effectiveActionStatuses([{ ...input, item_ids: ['ses_fixture', 'ses_other'] }, mixed]);
  expect(perTarget.filter((entry) => entry.status === 'blocked')).toHaveLength(1);
  expect(perTarget.find((entry) => entry.item_id === 'ses_fixture')?.status).toBe('archived');
  evidence.recordAssertionEvidence('Current incidents do not count history as new failures', 'Repeated/duplicate blocked receipts count once per request/item. Archive supersedes that incident while retaining two historical blocks. Owner replies never erase archived or waiting execution state. Accepted and claimed remain distinct; structured bulk outcomes count only the blocked target.', true);
});
