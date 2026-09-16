import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, statSync, symlinkSync, linkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { validateFeed, applyDecision, undoLast, latestDecisions, exportDecisions, safeUrl, isLocked, recommendationVerb, canApprove, canArchive, hasConcreteQuestion } from '../../tools/review-queue/core.mjs';
import { convertReport, supplementReport, privateOutputPath, writePrivateOutput, parseQueueArgs, tableCells } from '../../tools/review-queue/convert.mjs';
import { buildHtml } from '../../tools/review-queue/build.mjs';

const time = '2026-01-01T12:00:00.000Z';
const later = '2026-01-01T12:01:00.000Z';
const sourceDirectory = fileURLToPath(new URL('../../tools/review-queue/', import.meta.url));
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing synthetic ${label}`);
  return value;
}
function findItem(source: ReturnType<typeof validateFeed>, id: string) {
  return required(source.items.find((entry) => entry.id === id), `item ${id}`);
}
function item(id = 'ses_exampleA') {
  return { id, kind: 'session', title: 'Synthetic task', summary: 'Fictional evidence only',
    purpose: 'Explain a fictional setting.', delivered: 'A concise explanation.', status_on_dev: 'No runtime change.',
    why: 'The requested explanation is complete.', if_approved: 'Record archive intent after current-state checks.',
    if_declined: 'Keep the session available.', question: 'Should this explanation be retained for follow-up?', raw_evidence: [],
    evidence: [{ label: 'Workspace', value: 'openwork' }, { label: 'Pinned', value: 'no' }, { label: 'Status', value: 'idle' }],
    recommended_action: 'archive', links: [], age: 'an arbitrary age label', risk: 'low', group: 'openwork',
    workspace_id: 'ws_example', protected: false };
}
function feed() {
  return validateFeed({ items: [item(), item('ses_exampleB')], decisions: [], metadata: { source: 'synthetic', collection_caveat: 'Not live; original snapshot only.' } });
}
function prItem() {
  return { id: 'pr-7', kind: 'pr', title: 'Synthetic PR', recommended_action: 'merge', group: 'PR / OPEN',
    purpose: 'Improve a fictional setting.', delivered: 'A proposed change.', status_on_dev: 'Not merged.',
    why: 'Ready for current-head verification.', if_approved: 'Record merge intent subject to fresh checks and authorization.',
    if_declined: 'Leave the PR open.', question: '', raw_evidence: [],
    pr_url: 'https://github.com/example/demo/pull/7', head_sha: 'a'.repeat(40), evidence: [{ label: 'State', value: 'OPEN' }] };
}
function nightInput() {
  return {
    schema_version: 1, status: 'Synthetic historical inventory only', as_of: time,
    session_inventory_as_of: time, generated_at: later,
    coverage: { initial_roots: 3, known_session_items: 2, latest_candidate_roots_observed: 4,
      unknown_new_root_count: null, unidentified_candidate_count_at_observation: 1,
      external_mission_count: 0, pr_items: 1, reclaimable_worktrees: 1, caveat: 'Unknown is not zero; fictional coverage.' },
    items: [{ ...item(), recommended_action: 'review_archive_eligibility', age_days: 1.5,
      stale_bound: true, execution_policy: 'Review only; current authorization required', archived: false },
    { id: '/example/night-tree', kind: 'worktree', title: 'Synthetic worktree', recommended_action: 'review_worktree_removal', age_days: null }],
    actions_taken: [{ id: 'history-1', kind: 'session', action: 'archive', target_id: 'ses_historical', status: 'recorded, not re-executed',
      created_session_id: 'ses_followup', title: 'Synthetic historical follow-up', createdAt: Date.parse(time),
      head: 'a'.repeat(40), summary: 'Historical source only', evidence: [{ label: 'Observation', value: 'Synthetic record' }] }],
    metadata: { source: 'synthetic-night.json', collected_at: time, collection_time: 'Fictional original window', collection_caveat: 'Not live; never infer current permission.' },
  };
}
function instructions(candidate: object, action = 'approve', comment = '') {
  const source = validateFeed({ items: [candidate] });
  const historical = validateFeed({ ...source, decisions: [{ id: source.items[0].id, action, comment, decided_at: time, batch_id: 'batch-1' }] });
  return exportDecisions(historical, later).instructions;
}
test('historical archive exports share Busy Working and active-root safety without weakening offline scope', async ({ evidence }) => {
  const decision = { id: 'ses_exampleA', action: 'approve', comment: '', decided_at: time, batch_id: 'historical' };
  for (const label of ['Busy', 'Working', 'Active user root']) {
    for (const values of [['yes'], ['no', 'yes']]) {
      const candidate = { ...item(), evidence: [...item().evidence, ...values.map((value) => ({ label, value }))] };
      const imported = validateFeed({ items: [candidate], decisions: [decision] });
      expect(imported.decisions).toEqual([decision]);
      expect(canArchive(imported.items[0])).toBe(false);
      expect(() => applyDecision(imported, [decision.id], 'approve', '', later, 'new-request')).toThrow(/Archive/);
      const exported = exportDecisions(imported, later);
      expect(exported.instructions).toContain('BLOCKED');
      expect(exported.instructions).not.toContain('session.archive ');
      expect(validateFeed(JSON.parse(exported.json))).toEqual(imported);
    }
  }
  const clear = { ...item(), evidence: [...item().evidence, ...['Busy', 'Working', 'Active user root'].map((label) => ({ label, value: 'no' }))] };
  expect(instructions(clear)).toContain('session.archive {"sessionId":"ses_exampleA","workspaceId":"ws_example"}');
  expect(canArchive({ ...clear, group: 'OpenWork Chat' })).toBe(true);
  expect(instructions({ ...clear, group: 'OpenWork Chat' })).toContain('BLOCKED');
  expect(instructions({ ...clear, group: 'OpenWork Chat' })).not.toContain('session.archive ');
  evidence.recordAssertionEvidence('Historical readability is not unsafe archive authority', 'Imported legacy approve events remain readable and round-trip. Each positive/conflicting Busy, Working or Active user root observation rejects a new archive approval and blocks the historical export call. All-clear evidence still produces the exact plan, while the stricter offline workspace scope remains enforced.', true);
});

const report = `# Synthetic report

**Early delivery; collection window: a fictional earlier time.** Not a live snapshot. Inventory is multi-call, not atomic.

## Merge column — strict candidates

| Priority | PR | Exact head | Fresh verification |
|---|---|---|---|
| 1 | [#7 — demo](https://github.com/example/demo/pull/7) | ${'a'.repeat(40)} | Synthetic narrow checks passed; not live |

## Session inventory

### openwork — \`ws_example\` (4)

| Row | Session ID | Title | Created EDT | Updated EDT | Model / variant | Pin; status | Class | Column; deliverable or decision |
|---|---|---|---|---|---|---|---|---|
| O01 | ses_exampleA | Synthetic lookup | 01-01 10:00 | 01-01 11:00 | unknown | —; i | C | A; final delivered |
| O02 | ses_exampleB | More lookup | 01-01 10:00 | 01-01 11:00 | unknown | P,K; i | C | D; #7 pending decision |
| O03 | ses_exampleC | Running example | 01-01 10:00 | 01-01 11:00 | unknown | —; b | R | Keep; running |
| O04 | ses_externalA | SUPAUD-20260915-A99 synthetic | 01-01 10:00 | 01-01 11:00 | unknown | —; i | C | A; owned elsewhere |

### OpenWork Chat — \`ws_chatExample\` (2)

| Row | Session ID | Title | Created EDT | Updated EDT | Model / variant | Pin; status | Class | Column; deliverable or decision |
|---|---|---|---|---|---|---|---|---|
| C01 | ses_chatExample | Innocent meeting coordinator | 01-01 10:00 | 01-01 11:00 | unknown | —; i | C | A; done |
| C02 | ses_controller | Identify inquiry / meeting coordinator | 01-01 10:00 | 01-01 11:00 | unknown | P; i | C | D; preserve pin |

## Decision column

1. **Operator:** choose a scope for O01.
2. **Operator:** ask the owner of O02 for evidence.
3. **Operator:** external reference C02; leave untouched.

## PR freshness — every open PR

| PR | Head | Base | Fresh local result |
|---|---|---|---|
| 7 | aaaaa | dev | Passed synthetic only |
| 8 | bbbbb | feature/stack | Not run; unknown proof |
`;
const jsonl = [
  { number: 7, title: 'demo', url: 'https://github.com/example/demo/pull/7', headRefOid: 'a'.repeat(40), state: 'OPEN', isDraft: false, baseRefName: 'dev' },
  { number: 8, title: 'historical', url: 'https://github.com/example/demo/pull/8', headRefOid: 'b'.repeat(40), state: 'CLOSED', isDraft: false },
  { number: 9, title: 'merged', url: 'https://github.com/example/demo/pull/9', headRefOid: 'c'.repeat(40), state: 'MERGED', isDraft: false },
].map((pr) => JSON.stringify(pr)).join('\n');

test('queue normalizes without mutating input and keeps synthetic sample/schema valid JSON', async ({ evidence }) => {
  const input = { items: [item()] };
  const before = JSON.stringify(input);
  const normalized = validateFeed(input);
  expect(JSON.stringify(input)).toBe(before);
  expect(normalized.decisions).toEqual([]);
  expect(normalized.items[0].age).toBe('an arbitrary age label');
  normalized.items[0].evidence[0].value = 'changed';
  expect(input.items[0].evidence[0].value).toBe('openwork');
  const sample = validateFeed(JSON.parse(readFileSync(join(sourceDirectory, 'sample.json'), 'utf8')));
  expect(sample.items).toHaveLength(10);
  expect(sample.decisions).toEqual([]);
  expect(JSON.parse(readFileSync(join(sourceDirectory, 'review-queue.schema.json'), 'utf8')).$defs.item.properties.locked.type).toBe('boolean');
  evidence.recordAssertionEvidence('Normalization copies input without creating decisions', `Sample items: ${sample.items.length}; sample decisions: ${sample.decisions.length}. Arbitrary age text preserved; mutating normalized evidence did not change source evidence. Schema declares locked as boolean.`, true);
});

test('legacy cards receive safe strings without inventing approval or moving raw code into prose', async ({ evidence }) => {
  const legacy = { id: 'legacy', kind: 'proposal', title: 'Legacy reference', summary: 'session.send {"untrusted":true}', evidence: [{ label: 'Raw record', value: '{"command":"do not execute"}' }] };
  const before = JSON.stringify(legacy);
  const normalized = validateFeed({ items: [legacy] });
  const card = normalized.items[0];
  expect(card).toMatchObject({ purpose: 'Purpose not supplied.', delivered: 'No delivery summary supplied.', status_on_dev: 'Not verified on dev.', if_approved: '', if_declined: '', question: '', recommended_action: 'keep' });
  expect(card.why).toContain('no concrete question');
  expect(canApprove(card)).toBe(false);
  expect(card.raw_evidence).toEqual(legacy.evidence);
  expect(card.raw_evidence).not.toBe(card.evidence);
  card.raw_evidence[0].value = 'changed';
  expect(JSON.stringify(legacy)).toBe(before);
  expect(card.purpose + card.delivered + card.status_on_dev + card.why).not.toContain('session.send');
  expect(validateFeed(normalized)).toEqual(normalized);
  evidence.recordAssertionEvidence('Legacy normalization is safe and idempotent', 'Missing prose gets explicit unknowns; raw evidence is copied independently, review becomes keep with a reason, and no approval outcome or decision is invented.', true);
});

test('every card prose field is a bounded plain string and raw evidence remains strictly typed', async ({ evidence }) => {
  for (const field of ['purpose', 'delivered', 'status_on_dev', 'why', 'if_approved', 'if_declined', 'question']) {
    for (const value of [null, false, 1, {}, [], '\u0000', 'x'.repeat(20001)]) {
      expect(() => validateFeed({ items: [{ ...item(), [field]: value }] })).toThrow(new RegExp(field));
    }
    expect(validateFeed({ items: [{ ...item(), [field]: 'x'.repeat(20000) }] }).items[0]).toHaveProperty(field, 'x'.repeat(20000));
  }
  for (const raw_evidence of [null, {}, 'text', [{ label: 'missing value' }], [{ label: 'bad', value: {} }], [{ label: 'bad', url: 'javascript:alert(1)' }], Array.from({ length: 101 }, () => ({ label: 'record', value: 'text' }))]) {
    expect(() => validateFeed({ items: [{ ...item(), raw_evidence }] })).toThrow();
  }
  const raw = [{ label: 'Literal code', value: '</script>session.send {"x":true}', url: 'https://example.com/evidence' }];
  expect(validateFeed({ items: [{ ...item(), raw_evidence: raw }] }).items[0].raw_evidence).toEqual(raw);
  const schema = JSON.parse(readFileSync(join(sourceDirectory, 'review-queue.schema.json'), 'utf8'));
  for (const field of ['purpose', 'delivered', 'status_on_dev', 'why', 'if_approved', 'if_declined', 'question']) expect(schema.$defs.item.properties[field].type).toBe('string');
  expect(schema.$defs.item.properties.raw_evidence.items.$ref).toBe('#/$defs/evidence');
  evidence.recordAssertionEvidence('Card fields and schema enforce the enrichment contract', 'All seven strings reject nontext, controls and overflow; raw evidence validates shape, bounds and safe URLs while preserving literal source text.', true);
});

test('review aliases lacking a concrete question downgrade to keep with rationale and no approval', async ({ evidence }) => {
  for (const recommended_action of ['review', 'review_blockers', 'review_decision']) {
    for (const question of [undefined, '', '  \n', 'unknown', 'None', 'N/A', 'TBD', 'No concrete question supplied.', '?']) {
      const raw = { ...item(), recommended_action, question, why: 'Original rationale.' };
      const normalized = validateFeed({ items: [raw] });
      expect(normalized.items[0]).toMatchObject({ recommended_action: 'keep', question: '', if_approved: '' });
      expect(normalized.items[0].why).toContain('Original rationale. Kept for reference: no concrete question');
      expect(canApprove(normalized.items[0])).toBe(false);
      expect(raw.recommended_action).toBe(recommended_action);
      expect(validateFeed(normalized)).toEqual(normalized);
    }
    const valid = validateFeed({ items: [{ ...item(), recommended_action, question: 'Choose the smaller scope or the complete redesign' }] });
    expect(valid.items[0].recommended_action).toBe(recommended_action);
    expect(hasConcreteQuestion(valid.items[0])).toBe(true);
    expect(canApprove(valid.items[0])).toBe(true);
  }
  for (const recommended_action of ['archive', 'review_archive_eligibility', 'merge', 'review_merge_candidate']) {
    expect(validateFeed({ items: [{ ...item(), recommended_action, question: '' }] }).items[0].recommended_action).toBe(recommended_action);
  }
  evidence.recordAssertionEvidence('Only concrete review questions can remain review recommendations', 'Three review aliases with nine empty/placeholder variants downgrade idempotently and lose approval; concrete choices remain review, and archive/merge recommendations need no fabricated question.', true);
});

test('explicit reference locks, unauthorized worktrees and external missions remain non-bypassable', async ({ evidence }) => {
  for (const patch of [{ recommended_action: 'none', locked: true }, { recommended_action: ' NONE ', locked: true }, { kind: 'worktree', recommended_action: 'keep' }, { kind: 'worktree', recommended_action: 'remove' }, { group: 'external-mission' }, { title: 'SUPAUD-20260915-A99 synthetic' }, { title: 'NIGHT REVIEW — synthetic' }, { title: '[night-review] synthetic' }, { title: 'Identify client making initial inquiry' }]) {
    const raw = { ...item(), locked: false, protected: false, ...patch };
    const source = validateFeed({ items: [raw] });
    expect(isLocked(source.items[0])).toBe(true);
    expect(canApprove(source.items[0])).toBe(false);
    for (const action of ['approve', 'decline', 'defer', 'ask_info', 'request_changes', 'comment']) {
      expect(() => applyDecision(source, [raw.id], action, 'Literal comment', time, 'locked')).toThrow(/Locked/);
      expect(() => validateFeed({ ...source, decisions: [{ id: raw.id, action, comment: 'Literal comment', batch_id: 'import', decided_at: time }] })).toThrow(/Locked/);
    }
    expect(() => validateFeed({ ...source, drafts: { [raw.id]: 'Cannot restore a draft' } })).toThrow(/Locked/);
    expect(source.decisions).toEqual([]);
    expect(exportDecisions(source, later).instructions).not.toMatch(/^session\.|^gh |^git |^rm /m);
  }
  expect(isLocked({ ...item(), title: 'Ordinary review of night mode' })).toBe(false);
  evidence.recordAssertionEvidence('Read-only categories cannot be unlocked by source flags', 'Legacy action variants, imported events and drafts fail closed across nine explicit/reference lock variants; no mutation instructions are generated. An unrelated night-mode title remains actionable.', true);
});

test('missing approval outcomes reject single, mixed batch and imported approval without blocking decline', async ({ evidence }) => {
  for (const if_approved of [undefined, '', '  \n']) {
    const source = validateFeed({ items: [item(), { ...item('ses_exampleB'), if_approved }] });
    const before = JSON.stringify(source);
    expect(canApprove(source.items[1])).toBe(false);
    expect(() => applyDecision(source, ['ses_exampleB'], 'approve', '', time, 'one')).toThrow(/if_approved/);
    expect(() => applyDecision(source, ['ses_exampleA', 'ses_exampleB'], 'approve', '', time, 'batch')).toThrow(/if_approved/);
    expect(() => validateFeed({ ...source, decisions: [{ id: 'ses_exampleB', action: 'approve', comment: '', batch_id: 'import', decided_at: time }] })).toThrow(/if_approved/);
    expect(JSON.stringify(source)).toBe(before);
    for (const action of ['decline', 'defer', 'ask_info', 'request_changes', 'comment']) {
      const decided = applyDecision(source, ['ses_exampleB'], action, 'Reviewed text', time, 'allowed');
      expect(undoLast(validateFeed(JSON.parse(exportDecisions(decided, later).json)))).toEqual(source);
    }
  }
  expect(canApprove(validateFeed({ items: [item()] }).items[0])).toBe(true);
  evidence.recordAssertionEvidence('Approval requires an outcome on every path', 'Missing, empty and whitespace outcomes reject single/bulk/import approval atomically; other decisions retain export/restore/undo behavior.', true);
});

test('enriched card prose and raw evidence remain snapshot-bound through export and undo', async ({ evidence }) => {
  const source = feed();
  const decided = applyDecision(source, ['ses_exampleA'], 'approve', '', time, 'one');
  const exported = JSON.parse(exportDecisions(decided, later).json);
  for (const field of ['purpose', 'delivered', 'status_on_dev', 'why', 'if_approved', 'if_declined', 'question', 'raw_evidence']) {
    expect(source.items[0]).toHaveProperty(field, exported.items[0][field]);
  }
  expect(validateFeed(exported)).toEqual(decided);
  expect(undoLast(validateFeed(exported))).toEqual(source);
  evidence.recordAssertionEvidence('Enrichment survives portable decision history', 'Seven strings and raw evidence retain exact values in exported item snapshots; restore and undo preserve all fields.', true);
});

test('queue rejects duplicate identities, unsafe enums, invalid references and bounded-field abuse', async ({ evidence }) => {
  expect(() => validateFeed({ items: [item(), item()] })).toThrow(/Duplicate/);
  for (const patch of [{ kind: 'other' }, { risk: 'critical' }, { title: 'x'.repeat(501) }, { id: "ses_x';rm" }, { owner_session_id: 'not-session' }, { protected: 'false' }, { unexpected: true }]) {
    expect(() => validateFeed({ items: [{ ...item(), ...patch }] })).toThrow();
  }
  expect(() => applyDecision(feed(), ['missing'], 'approve', '', time, 'batch')).toThrow(/unknown item/);
  expect(() => applyDecision(feed(), ['ses_exampleA'], 'execute', '', time, 'batch')).toThrow(/action/);
  expect(() => validateFeed({ items: [item()], metadata: { collected_at: '2026-02-30T12:00:00Z' } })).toThrow(/valid date/);
  evidence.recordAssertionEvidence('Invalid identities and fields fail closed', 'Rejected duplicate item IDs, unknown kind/risk, 501-character title, shell-shaped ID, invalid owner ID, nonboolean protection, unknown fields, missing decision target, execute action, and February 30 collection date.', true);
});

test('queue requires explicit comments and valid timezone-aware chronological timestamps', async ({ evidence }) => {
  for (const action of ['ask_info', 'request_changes', 'comment']) {
    expect(() => applyDecision(feed(), ['ses_exampleA'], action, '  \n', time, 'batch')).toThrow(/nonempty/);
    expect(applyDecision(feed(), ['ses_exampleA'], action, 'Please clarify', time, 'batch').decisions).toHaveLength(1);
  }
  for (const date of ['yesterday', '2026-01-01', '2026-02-30T12:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T12:00:00']) {
    expect(() => applyDecision(feed(), ['ses_exampleA'], 'approve', '', date, 'batch')).toThrow();
  }
  const decided = applyDecision(feed(), ['ses_exampleA'], 'approve', '', later, 'batch');
  expect(() => applyDecision(decided, ['ses_exampleB'], 'approve', '', time, 'earlier')).toThrow(/append order/);
  evidence.recordAssertionEvidence('Comments and timestamps are explicit and ordered', 'ask_info, request_changes and comment each accepted a nonempty comment and rejected whitespace-only text. Rejected five malformed/date-only/timezone-free timestamps and an event older than the preceding event.', true);
});

test('bulk append is immutable and constrained to homogeneous kind, group and recommendation', async ({ evidence }) => {
  const original = feed();
  const first = applyDecision(original, ['ses_exampleA', 'ses_exampleB'], 'approve', '', time, 'bulk');
  expect(first).not.toBe(original);
  expect(original.decisions).toEqual([]);
  expect(first.decisions).toHaveLength(2);
  expect(latestDecisions(first).map((event) => event.action)).toEqual(['approve', 'approve']);
  for (const patch of [{ kind: 'proposal' }, { group: 'other' }, { recommended_action: 'review' }]) {
    const mixed = validateFeed({ items: [item(), { ...item('ses_exampleB'), ...patch }] });
    expect(() => applyDecision(mixed, ['ses_exampleA', 'ses_exampleB'], 'approve', '', time, 'mixed')).toThrow(/homogeneous/);
    expect(mixed.decisions).toEqual([]);
  }
  expect(() => applyDecision(original, [], 'approve', '', time, 'empty')).toThrow();
  expect(() => applyDecision(original, ['ses_exampleA', 'ses_exampleA'], 'approve', '', time, 'dup')).toThrow();
  expect(() => applyDecision(first, ['ses_exampleA'], 'decline', '', later, 'bulk')).toThrow(/already exists/);
  evidence.recordAssertionEvidence('Bulk decisions are immutable and homogeneous', `Original events: ${original.decisions.length}; accepted bulk events: ${first.decisions.length}. Rejected mixed kind, group or recommendation, empty or duplicate selections, and reused batch ID; rejected attempts left source decisions empty.`, true);
});

test('new and legacy messages preserve approval while Later is not an executable ledger action', async ({ evidence }) => {
  let current = applyDecision(feed(), ['ses_exampleA'], 'approve', '', time, 'approval');
  for (const action of ['message', 'ask_info', 'request_changes', 'comment']) {
    current = applyDecision(current, ['ses_exampleA'], action, 'Reviewed synthetic message', later, `message-${action}`);
    expect(latestDecisions(current).map((entry) => entry.action)).toEqual(['approve']);
  }
  expect(current.decisions).toHaveLength(5);
  expect(() => applyDecision(current, ['ses_exampleB'], 'later', '', later, 'not-work')).toThrow();
  expect(() => applyDecision(current, ['ses_exampleB'], 'message', ' ', later, 'empty-message')).toThrow();
  expect(JSON.parse(exportDecisions(current, later).json).effective_decisions[0].action).toBe('approve');
  evidence.recordAssertionEvidence('Messages and disposition are separate', 'Approve followed by each new/legacy message retains approval and all five audit events. Empty message and executable Later reject; export effective approval remains intact.', true);
});

test('messages remain orthogonal to decisions; undo drops exactly one complete batch', async ({ evidence }) => {
  const original = feed();
  const first = applyDecision(original, ['ses_exampleA', 'ses_exampleB'], 'approve', '', time, 'bulk');
  const second = applyDecision(first, ['ses_exampleA'], 'comment', 'Still a question', later, 'followup');
  expect(latestDecisions(second).map((event) => event.action)).toEqual(['approve', 'approve']);
  expect(second.decisions).toHaveLength(3);
  expect(undoLast(second)).toEqual(first);
  expect(undoLast(first)).toEqual(original);
  expect(undoLast(original)).toEqual(original);
  expect(second.decisions).toHaveLength(3);
  evidence.recordAssertionEvidence('Legacy message preserves approval and undo removes only the last batch', `Effective actions: ${JSON.stringify(latestDecisions(second).map((event) => event.action))}; audit remains ${second.decisions.length} events. Undo restored the preceding bulk, then the original empty history; undo on empty history was a no-op and did not mutate the three-event input.`, true);
});

test('imports reject broken append audits, reused batches, duplicates and inconsistent bulk comments', async ({ evidence }) => {
  const first = applyDecision(feed(), ['ses_exampleA', 'ses_exampleB'], 'approve', '', time, 'bulk');
  expect(() => validateFeed({ ...first, decisions: [...first.decisions, first.decisions[0]] })).toThrow(/once per batch/);
  const second = applyDecision(first, ['ses_exampleA'], 'decline', '', later, 'next');
  expect(() => validateFeed({ ...second, decisions: [...second.decisions, { ...first.decisions[1], decided_at: later }] })).toThrow(/contiguous/);
  expect(() => validateFeed({ ...first, decisions: [first.decisions[0], { ...first.decisions[1], comment: 'different' }] })).toThrow(/homogeneous/);
  evidence.recordAssertionEvidence('Imported audit batches cannot be forged or reused', `Constructed valid histories with ${first.decisions.length} and ${second.decisions.length} events. Imports rejected duplicate item events in one batch, a reused noncontiguous batch, and inconsistent comments inside a bulk batch.`, true);
});

test('locked flags and external-mission groups forbid every action, imported events and drafts', async ({ evidence }) => {
  for (const patch of [{ locked: true }, { group: 'external-mission', locked: false }]) {
    const locked = { ...item(), ...patch };
    expect(isLocked(locked)).toBe(true);
    for (const action of ['approve', 'decline', 'defer', 'ask_info', 'request_changes', 'comment']) {
      expect(() => applyDecision({ items: [locked] }, [locked.id], action, 'text', time, 'batch')).toThrow(/Locked/);
    }
    expect(() => validateFeed({ items: [locked], decisions: [{ id: locked.id, action: 'comment', comment: 'text', batch_id: 'import', decided_at: time }] })).toThrow(/Locked/);
    expect(() => validateFeed({ items: [locked], drafts: { [locked.id]: 'text' } })).toThrow(/Locked/);
    expect(exportDecisions({ items: [locked] }, time).instructions).not.toMatch(/^session\.(send|archive)/m);
  }
  expect(isLocked(item())).toBe(false);
  const untouched = validateFeed({ items: [item(), { ...item('ses_locked'), locked: true }] });
  expect(undoLast(applyDecision(untouched, ['ses_exampleA'], 'defer', '', time, 'one'))).toEqual(untouched);
  evidence.recordAssertionEvidence('Locked and external items forbid all decision paths', 'For locked:true and external-mission with locked:false, all six actions, imported comment events and drafts were rejected; exports contained no session send/archive call. Ordinary items remained unlocked and undo restored a mixed feed without changing its locked item.', true);
});

test('URLs reject script, credential, whitespace and backslash tricks but accept HTTP(S)', async ({ evidence }) => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', '//example.com', 'https://user:pass@example.com', 'https://example.com\n', 'https://example.com\\evil', ' https://example.com']) expect(safeUrl(url)).toBeNull();
  expect(safeUrl('https://example.com/a?q=x#y')).toBe('https://example.com/a?q=x#y');
  expect(safeUrl('http://example.com')).toBe('http://example.com/');
  expect(() => validateFeed({ items: [{ ...item(), links: [{ label: 'unsafe', url: 'javascript:alert(1)' }] }] })).toThrow(/HTTP/);
  expect(() => validateFeed({ items: [{ ...item(), evidence: [{ label: 'unsafe', url: 'data:text/html,x' }] }] })).toThrow(/HTTP/);
  evidence.recordAssertionEvidence('Only safe absolute HTTP(S) links survive', 'Accepted HTTPS with query/fragment and normalized a bare HTTP host. Rejected eight script/data/file/relative/credential/whitespace/backslash cases; invalid link and evidence URLs also failed feed validation.', true);
});

test('archive instructions require positive identity/pin/status evidence and current permission rechecks', async ({ evidence }) => {
  const allowed = instructions(item());
  expect(allowed).toContain('session.archive {"sessionId":"ses_exampleA","workspaceId":"ws_example"}');
  expect(allowed).toContain('task worktree clean');
  expect(allowed).toContain('If any check is unknown or false, STOP');
  for (const patch of [{ protected: true }, { protected: undefined }, { group: 'OpenWork Chat' }, { workspace_id: undefined }, { evidence: [] }, { evidence: [...item().evidence, { label: 'Pinned', value: 'yes' }] }, { evidence: [...item().evidence.slice(0, 2), { label: 'Status', value: 'running' }] }, { evidence: [{ label: 'Workspace', value: 'openwork' }, { label: 'Pinned', value: 'yes' }, { label: 'Status', value: 'idle' }] }]) {
    const result = instructions({ ...item(), ...patch });
    expect(result).toContain('BLOCKED');
    expect(result).not.toMatch(/^session\.archive /m);
  }
  expect(instructions(item(), 'decline')).not.toMatch(/^session\.archive /m);
  evidence.recordAssertionEvidence('Archive instructions retain identity and permission gates', 'Verified exact synthetic session.archive JSON plus worktree-clean and STOP rechecks. Eight protected, unknown, Chat, missing-workspace, missing/conflicting-evidence, running or pinned cases produced BLOCKED and no archive call. Decline produced no archive call.', true);
});

test('merge instructions use a literal validated GitHub URL/full SHA and never bypass or close', async ({ evidence }) => {
  const allowed = instructions(prItem());
  expect(allowed).toContain(`gh pr merge 'https://github.com/example/demo/pull/7' --squash --match-head-commit '${'a'.repeat(40)}'`);
  for (const gate of ['current head', 'base branch and base head', 'required checks', 'exact-head reviews', 'human merge authorization']) expect(allowed).toContain(gate);
  expect(allowed).not.toContain('--admin');
  for (const patch of [{ head_sha: 'abcdef' }, { head_sha: 'a'.repeat(39) + ';' }, { head_sha: undefined }, { protected: true }, { pr_url: 'https://github.com/example/demo/pull/7?x=1' }, { pr_url: 'https://github.com.evil.test/example/demo/pull/7' }, { pr_url: 'http://github.com/example/demo/pull/7' }, { pr_url: "https://github.com/example/demo/pull/7';id" }, { evidence: [{ label: 'State', value: 'CLOSED' }] }]) {
    const result = instructions({ ...prItem(), ...patch });
    expect(result).toContain('BLOCKED');
    expect(result).not.toMatch(/^gh pr merge /m);
  }
  for (const action of ['decline', 'defer']) {
    expect(instructions(prItem(), action)).not.toMatch(/gh pr (?:merge|close)/);
  }
  evidence.recordAssertionEvidence('Merge instructions cannot bypass identity or authorization', 'Verified literal example GitHub PR URL, squash flag and full 40-hex match-head SHA; current-head/base/checks/reviews/human-authorization gates are present and --admin absent. Nine unsafe head/URL/protection/closed-state variants were blocked without a merge command; decline/defer emitted neither merge nor close.', true);
});

test('follow-ups use exact session/owner IDs and JSON escaping; worktrees/proposals stay manual', async ({ evidence }) => {
  const comment = 'Quote "x"\n$(touch /tmp/not-executed); </script><b>data</b>';
  for (const candidate of [item(), { ...prItem(), owner_session_id: 'ses_exampleA' }]) {
    const result = instructions(candidate, 'request_changes', comment);
    const call = result.split('\n').find((line) => line.startsWith('session.send '));
    expect(call).toBeDefined();
    expect(JSON.parse(required(call, 'session.send line').slice('session.send '.length))).toEqual({ sessionId: 'ses_exampleA', text: comment });
    expect(result).not.toMatch(/^gh pr /m);
  }
  expect(instructions(prItem(), 'ask_info', 'Please clarify')).toContain('BLOCKED');
  const externalOwner = validateFeed({ items: [{ ...item(), locked: true }, { ...prItem(), owner_session_id: 'ses_exampleA' }] });
  const blocked = exportDecisions(applyDecision(externalOwner, ['pr-7'], 'comment', 'Do not send', time, 'batch'), later).instructions;
  expect(blocked).toContain('target owner is locked');
  expect(blocked).not.toMatch(/^session\.send /m);
  const result = instructions({ id: 'example', title: 'Example', kind: 'proposal', recommended_action: 'remove', if_approved: 'Record a request for separately authorized work.' });
  expect(result).toContain('MANUAL AUTHORIZATION REQUIRED');
  expect(result).not.toMatch(/^git |^rm |^session\./m);
  expect(() => instructions({ id: 'example', title: 'Example', kind: 'worktree', recommended_action: 'remove', if_approved: 'Remove the worktree.' })).toThrow(/Locked/);
  evidence.recordAssertionEvidence('Follow-ups are exact JSON data, never arbitrary commands', 'Session and PR-owner follow-ups parsed back to the exact synthetic target/comment containing quotes, newline, shell substitution and HTML; no PR command was emitted. Missing and locked owners were blocked. Proposal approval required manual authorization and emitted no git, rm or session mutation; worktree approval was rejected.', true);
});

test('exports preserve exact normalized items, metadata, full audit and effective decisions for restore', async ({ evidence }) => {
  const first = applyDecision(feed(), ['ses_exampleA', 'ses_exampleB'], 'approve', '', time, 'bulk');
  const last = applyDecision(first, ['ses_exampleA'], 'comment', '<script>alert(1)</script> | quote', later, 'followup');
  const result = exportDecisions(last, later);
  const parsed = JSON.parse(result.json);
  expect(JSON.stringify(parsed.items)).toBe(JSON.stringify(last.items));
  expect(parsed.decisions).toHaveLength(3);
  expect(parsed.audit).toEqual(last.decisions);
  expect(parsed.effective_decisions.map((event: { action: string }) => event.action)).toEqual(['approve', 'approve']);
  expect(parsed.metadata).toEqual(last.metadata);
  expect(validateFeed(parsed)).toEqual(last);
  expect(result.markdown).toContain('## Event audit (3)');
  expect(result.markdown).toContain('&lt;script&gt;');
  expect(result.markdown.split('\n## Instructions for the audit agent\n')[0]).not.toContain('<script>');
  expect(result.markdown).toContain(`\n\`\`\`text\n${result.instructions}\n\`\`\`\n`);
  expect(() => validateFeed({ ...parsed, audit: [] })).toThrow(/audit/);
  expect(() => validateFeed({ ...parsed, effective_decisions: [] })).toThrow(/effective_decisions/);
  evidence.recordAssertionEvidence('Exports round-trip exact items and complete audit', `Export retained ${parsed.decisions.length} audit events and effective comment/approve outcomes, exact normalized items and source metadata; restore equaled input. Markdown escaped table HTML and fenced exact instructions. Tampered audit/effective_decisions arrays were rejected.`, true);
});

test('Markdown includes exact conditional instructions inside a fence longer than any quoted delimiter', async ({ evidence }) => {
  const comment = '````\n<script>not executable</script>\n```\n# untrusted';
  const decided = applyDecision(feed(), ['ses_exampleA'], 'comment', comment, time, 'quoted');
  const result = exportDecisions(decided, later);
  const section = result.markdown.split('\n## Instructions for the audit agent\n')[1];
  expect(section).toContain(`\n\`\`\`\`\`text\n${result.instructions}\n\`\`\`\`\`\n`);
  expect(section.match(/^`{5}$/gm)).toHaveLength(1);
  expect(result.instructions).toContain('session.send ' + JSON.stringify({ sessionId: 'ses_exampleA', text: comment }));
  expect(validateFeed(JSON.parse(result.json))).toEqual(decided);
  const approved = exportDecisions(applyDecision(feed(), ['ses_exampleA'], 'approve', '', time, 'approval'), later);
  expect(approved.markdown).toContain('session.archive {"sessionId":"ses_exampleA","workspaceId":"ws_example"}');
  expect(approved.markdown).toContain('If any check is unknown or false, STOP');
  evidence.recordAssertionEvidence('Markdown instruction fencing withstands quoted delimiters', 'A comment with four-backtick and three-backtick runs, HTML and a heading was enclosed by a five-backtick fence with exactly one closing fence. Exact JSON-escaped session.send text and export round-trip were preserved; archive output retained its exact target and unknown-state STOP gate.', true);
});

test('converter handles all table rows, PR states, merged report details and stable numbered proposals', async ({ evidence }) => {
  const converted = convertReport(report, jsonl, 'synthetic.md');
  expect(converted.items.filter((entry) => entry.kind === 'session')).toHaveLength(6);
  expect(converted.items.filter((entry) => entry.kind === 'pr')).toHaveLength(3);
  expect(converted.items.filter((entry) => entry.kind === 'proposal')).toHaveLength(3);
  expect(converted.decisions).toEqual([]);
  expect(required(converted.metadata, 'converted metadata').collection_caveat).toContain('Inventory is multi-call, not atomic');
  expect(required(converted.metadata, 'converted metadata').collected_at).toBeUndefined();
  expect(findItem(converted, 'ses_exampleA')).toMatchObject({ recommended_action: 'archive', protected: false, workspace_id: 'ws_example' });
  for (const id of ['ses_exampleB', 'ses_exampleC', 'ses_chatExample']) expect(findItem(converted, id).protected).toBe(true);
  expect(findItem(converted, 'pr-7')).toMatchObject({ recommended_action: 'merge', owner_session_id: 'ses_exampleB', head_sha: 'a'.repeat(40) });
  expect(findItem(converted, 'pr-7').summary).toContain('Passed synthetic only');
  expect(findItem(converted, 'pr-8')).toMatchObject({ recommended_action: 'keep', protected: true });
  expect(findItem(converted, 'pr-9').summary).toContain('verification unknown');
  expect(convertReport(report, jsonl, 'synthetic.md')).toEqual(converted);
  evidence.recordAssertionEvidence('Report conversion preserves counts and historical caveats', `Converted ${converted.items.length} synthetic items: six sessions, three PRs and three stable proposals, with zero decisions and no collected_at invented. Preserved non-atomic caveat, exact workspace/owner/head, protected pinned/running/Chat rows, closed PR keep recommendation, and unknown proof on the unverified historical PR.`, true);
});

test('converter locks explicit external mission and exact controller without broad title inference', async ({ evidence }) => {
  const converted = convertReport(report, jsonl);
  for (const id of ['ses_externalA', 'ses_controller']) {
    const entry = findItem(converted, id);
    expect(entry).toMatchObject({ locked: true, group: 'external-mission', recommended_action: 'none' });
    expect(entry.summary).toContain('External mission (untouched)');
  }
  expect(isLocked(findItem(converted, 'ses_chatExample'))).toBe(false);
  const externalProposal = required(converted.items.find((entry) => entry.kind === 'proposal' && entry.owner_session_id === 'ses_controller'), 'external proposal');
  expect(isLocked(externalProposal)).toBe(true);
  expect(() => applyDecision(converted, ['ses_controller'], 'comment', 'hello', time, 'batch')).toThrow(/Locked/);
  evidence.recordAssertionEvidence('Converter locks exact external identities without broad title guesses', 'Synthetic SUPAUD-prefixed session and exact controller were locked with external-mission/none and untouched summaries; a dependent proposal was locked. An innocent meeting-coordinator title was not locked. A comment to the controller was rejected.', true);
});

test('converter deduplicates sessions and JSONL entries, retains escaped pipes and refuses malformed input', async ({ evidence }) => {
  const duplicated = report.replace('| O01 | ses_exampleA', '| O00 | ses_exampleA | Duplicate title | 01-01 10:00 | 01-01 11:00 | unknown | —; i | C | A; older detail |\n| O01 | ses_exampleA');
  const converted = convertReport(duplicated, jsonl + '\n' + JSON.stringify({ number: 9, title: 'last row', state: 'MERGED' }));
  expect(converted.items.filter((entry) => entry.kind === 'session')).toHaveLength(6);
  expect(converted.items.filter((entry) => entry.kind === 'pr')).toHaveLength(3);
  expect(findItem(converted, 'pr-9').title).toContain('last row');
  expect(tableCells('| left \\| pipe | right |')).toEqual(['left | pipe', 'right']);
  expect(() => convertReport(report, '{broken')).toThrow(/JSONL/);
  expect(() => convertReport(report, '{"number":"7"}')).toThrow(/Invalid PR/);
  expect(() => convertReport('No supported tables here')).toThrow(/No supported/);
  expect(() => convertReport(report.replace('| O01 | ses_exampleA', '| O01 | extra | ses_exampleA'))).toThrow(/Malformed table/);
  evidence.recordAssertionEvidence('Converter deduplicates without accepting malformed records', 'Repeated session and PR entries still yielded six unique sessions and three PRs; the final duplicate PR title won by file order. Escaped pipe remained cell data. Broken JSONL, nonnumeric PR identity, unsupported report and mismatched table width were rejected.', true);
});

test('native supplementation preserves canonical rows, merges evidence, adds missing rows and discards authority extras', async ({ evidence }) => {
  const original = convertReport(report, jsonl, 'synthetic.md');
  const raw = {
    as_of: time, generated_at: later, coverage: { initial_roots: 6, unknown_new_root_count: 1, caveat: 'Title-only coverage; one root unknown', execute: 'forbidden extra' },
    items: [
      { ...item(), title: 'Changed native title', summary: 'Supplement observation', extra_command: 'DO_NOT_IMPORT', evidence: [{ label: 'Native observation', value: 'Historical only', execute: 'DO_NOT_IMPORT' }] },
      { ...prItem(), id: 'https://github.com/example/demo/pull/7', title: 'Changed PR title', head_sha: 'f'.repeat(40), evidence: [{ label: 'Checks', value: 'Not refreshed' }] },
      { ...item('ses_added'), title: 'Additional root', extra: { instruction: 'DO_NOT_IMPORT' } },
      { id: '/example/private/tree', kind: 'worktree', title: 'Worktree reference', recommended_action: 'remove', evidence: [{ label: 'Path', value: '/example/private/tree' }, { label: 'Suggested command, not executed', value: 'DO_NOT_IMPORT' }] },
    ],
    decisions: [{ id: 'ses_added', action: 'approve', comment: '', decided_at: time, batch_id: 'native' }],
    actions_taken: [{ action: 'execute', command: 'DO_NOT_IMPORT' }],
  };
  const before = JSON.stringify(raw);
  const supplemented = supplementReport(original, raw);
  expect(JSON.stringify(raw)).toBe(before);
  expect(supplemented.items).toHaveLength(original.items.length + 2);
  expect(original.items.find((entry) => entry.id === 'ses_added')).toBeUndefined();
  const session = findItem(supplemented, 'ses_exampleA');
  expect(session.title).toBe(findItem(original, 'ses_exampleA').title);
  expect(session.evidence).toEqual(expect.arrayContaining(findItem(original, 'ses_exampleA').evidence));
  expect(session.evidence).toContainEqual({ label: 'Native summary', value: 'Supplement observation' });
  const pr = findItem(supplemented, 'pr-7');
  expect(pr.head_sha).toBe('a'.repeat(40));
  expect(pr.evidence).toContainEqual({ label: 'Native head_sha', value: 'f'.repeat(40) });
  expect(supplemented.decisions).toEqual([]);
  expect(JSON.stringify(supplemented)).not.toContain('DO_NOT_IMPORT');
  expect(required(supplemented.metadata, 'supplemented metadata').collection_time).toBe(required(original.metadata, 'original metadata').collection_time);
  expect(required(supplemented.metadata, 'supplemented metadata').collected_at).toBeUndefined();
  expect(required(supplemented.metadata, 'supplemented metadata').collection_caveat).toContain(`original_collection (native snapshot, NOT refreshed): {"as_of":"${time}"`);
  expect(required(supplemented.metadata, 'supplemented metadata').collection_caveat).toContain('Title-only coverage; one root unknown');
  const worktree = findItem(supplemented, '/example/private/tree');
  expect(worktree).toMatchObject({ kind: 'worktree', locked: true, protected: true, recommended_action: 'remove' });
  expect(isLocked(worktree)).toBe(true);
  expect(() => applyDecision(supplemented, [worktree.id], 'approve', '', time, 'remove')).toThrow(/Locked/);
  expect(supplementReport(original, { ...raw, items: [...raw.items, raw.items[3]] }).items).toHaveLength(supplemented.items.length);
  expect(exportDecisions(supplemented, later).instructions).not.toMatch(/worktree remove|DO_NOT_IMPORT/);
  evidence.recordAssertionEvidence('Native supplement adds evidence without importing authority', `Item count grew from ${original.items.length} to ${supplemented.items.length}; native/source inputs remained unchanged, canonical title/head/evidence won, differing native observations remained evidence, and duplicate worktree rows deduplicated. No decisions or DO_NOT_IMPORT command extras survived. Collection time stayed unchanged; original as_of/coverage were retained. Worktree path ID and remove recommendation were preserved, but the row was locked read-only, rejected approval and emitted no removal instruction.`, true);
});

test('native locks are monotonic across duplicate rows and cover exact external owners and their dependents', async ({ evidence }) => {
  const original = validateFeed({ items: [item(), { ...prItem(), owner_session_id: 'ses_exampleA' }, { ...item('ses_locked'), locked: true }] });
  const native = { items: [
    { ...item(), group: 'external-mission', locked: false },
    { ...item(), group: 'innocent', locked: false },
    { ...item('ses_locked'), locked: false },
    ...Array.from({ length: 5 }, (_, index) => ({ ...item(`ses_external${index}`), title: 'Inventory-only identity', group: 'external-mission' })),
  ] };
  const supplemented = supplementReport(original, native);
  for (const id of ['ses_exampleA', 'ses_locked', 'pr-7', ...Array.from({ length: 5 }, (_, index) => `ses_external${index}`)]) {
    expect(isLocked(findItem(supplemented, id))).toBe(true);
    expect(() => applyDecision(supplemented, [id], 'comment', 'No action', time, 'batch')).toThrow(/Locked/);
  }
  expect(findItem(supplemented, 'ses_exampleA').group).toBe('external-mission');
  const decided = applyDecision(original, ['ses_exampleA'], 'approve', '', time, 'old');
  expect(() => supplementReport(decided, native)).toThrow(/Locked/);
  expect(decided.decisions).toHaveLength(1);
  evidence.recordAssertionEvidence('Native locks only tighten and protect dependent owners', 'All eight tested owner/dependent/locked identities remained locked and rejected comments despite duplicate native rows with locked:false. External owner classification persisted. Applying a new lock to a previously decided item failed closed and preserved its original single-event audit.', true);
});

test('native supplementation rejects malformed selected data, ambiguous identities and unsafe PR URLs', async ({ evidence }) => {
  for (const raw of [null, [], {}, { items: {} }, { items: [null] }, { items: [{ id: 'ses_exampleA', kind: 'other', title: 'x' }] }, { items: [{ ...item(), locked: 'false' }] }, { items: [{ ...item(), evidence: 'wrong' }] }, { items: [{ ...item(), links: [{ label: 'x', url: 'javascript:alert(1)' }] }] }, { items: [], as_of: 'yesterday' }, { items: [], coverage: { initial_roots: -1 } }]) {
    expect(() => supplementReport(feed(), raw)).toThrow();
  }
  for (const patch of [{ pr_url: 'https://evil.test/example/demo/pull/7' }, { pr_url: 'https://github.com/example/demo/pull/7?exec=1' }, { id: 'pr-8' }, { pr_url: 'https://github.com/other/demo/pull/7' }]) {
    expect(() => supplementReport({ items: [prItem()] }, { items: [{ ...prItem(), ...patch }] })).toThrow();
  }
  expect(() => supplementReport(feed(), { items: [{ id: '/example/a', kind: 'worktree', title: 'x', path: '/example/b' }] })).toThrow(/Conflicting/);
  const existing = validateFeed({ items: [{ id: 'worktree-existing', kind: 'worktree', title: 'Keep identity', evidence: [{ label: 'Path', value: '/example/a' }] }] });
  const merged = supplementReport(existing, { items: [{ id: '/example/a', kind: 'worktree', title: 'Native title' }] });
  expect(merged.items).toHaveLength(1);
  expect(merged.items[0]).toMatchObject({ id: 'worktree-existing', title: 'Keep identity', locked: true });
  evidence.recordAssertionEvidence('Malformed supplement fields and identity collisions fail closed', 'Rejected null/array/missing/malformed items, invalid kinds/flags/evidence/links/date/coverage, four unsafe or mismatched PR identities, and conflicting worktree paths. A matching worktree path merged to one existing canonical ID/title while adding its lock.', true);
});

test('night feed preserves typed snapshot fields without inventing absent metadata or freshness', async ({ evidence }) => {
  const raw = nightInput();
  const before = JSON.stringify(raw);
  const normalized = validateFeed(raw);
  expect(normalized).toMatchObject(raw);
  expect(normalized.decisions).toEqual([]);
  expect(JSON.stringify(raw)).toBe(before);
  const coverage = required(normalized.coverage, 'night coverage');
  expect(coverage.unknown_new_root_count).toBeNull();
  coverage.initial_roots = 99;
  required(normalized.metadata, 'night metadata').source = 'changed';
  required(normalized.actions_taken, 'night history')[0].summary = 'changed';
  expect(JSON.stringify(raw)).toBe(before);
  const minimal = validateFeed({ items: [item()] });
  for (const field of ['schema_version', 'status', 'as_of', 'session_inventory_as_of', 'generated_at', 'coverage', 'actions_taken', 'metadata']) expect(minimal).not.toHaveProperty(field);
  for (const field of ['age_days', 'stale_bound', 'execution_policy', 'archived']) expect(findItem(minimal, 'ses_exampleA')).not.toHaveProperty(field);
  evidence.recordAssertionEvidence('Night fields are typed snapshot data, not live authority', 'All synthetic feed/item/history/metadata fields survived normalization; nested coverage, metadata and history copies did not mutate input. Missing optional fields stayed absent and no decisions were created.', true);
});

test('night snapshot version, status and all three timestamps reject invalid types and bounds', async ({ evidence }) => {
  for (const schema_version of [null, true, '1', 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
    expect(() => validateFeed({ items: [], schema_version })).toThrow(/schema_version/);
  }
  for (const schema_version of [0, 1, Number.MAX_SAFE_INTEGER]) expect(validateFeed({ items: [], schema_version }).schema_version).toBe(schema_version);
  for (const status of [null, false, 1, {}, [], 'x'.repeat(2001), '\u0000']) expect(() => validateFeed({ items: [], status })).toThrow(/status/);
  expect(validateFeed({ items: [], status: 'x'.repeat(2000) }).status).toHaveLength(2000);
  for (const field of ['as_of', 'session_inventory_as_of', 'generated_at']) {
    expect(validateFeed({ items: [], [field]: '2026-01-01T07:00:00-05:00' })).toHaveProperty(field, time);
    for (const value of [null, 0, true, {}, [], 'yesterday', '2026-01-01', '2026-02-30T12:00:00Z', '2026-01-01T12:00:00', '2026-01-01T24:00:00Z']) {
      expect(() => validateFeed({ items: [], [field]: value })).toThrow(new RegExp(field));
    }
  }
  evidence.recordAssertionEvidence('Night snapshot envelope validates types and timestamps', 'Safe integer versions and bounded status accepted; wrong types, fractional/unsafe versions, control text and oversized status rejected. Every timestamp normalized an explicit offset and rejected missing timezone, impossible date, invalid hour and nontext input.', true);
});

test('coverage distinguishes nullable unknown counts from zero and rejects invalid values for every count', async ({ evidence }) => {
  const fields = ['initial_roots', 'known_session_items', 'latest_candidate_roots_observed', 'unknown_new_root_count', 'unidentified_candidate_count_at_observation', 'external_mission_count', 'pr_items', 'reclaimable_worktrees'];
  for (const field of fields) {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) expect(validateFeed({ items: [], coverage: { [field]: value } }).coverage).toEqual({ [field]: value });
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', false, {}, []]) {
      expect(() => validateFeed({ items: [], coverage: { [field]: value } })).toThrow(new RegExp(`coverage.${field}`));
    }
    if (field !== 'unknown_new_root_count') expect(() => validateFeed({ items: [], coverage: { [field]: null } })).toThrow(new RegExp(field));
  }
  const unknown = validateFeed({ items: [], coverage: { unknown_new_root_count: null } });
  expect(unknown.coverage).toEqual({ unknown_new_root_count: null });
  expect(validateFeed(JSON.parse(exportDecisions(unknown, later).json))).toEqual(unknown);
  expect(validateFeed({ items: [], coverage: {} }).coverage).not.toHaveProperty('unknown_new_root_count');
  for (const coverage of [null, [], 'unknown', 0, { unexpected: 1 }, { caveat: null }, { caveat: 1 }, { caveat: '\u0000' }, { caveat: 'x'.repeat(20001) }]) expect(() => validateFeed({ items: [], coverage })).toThrow(/coverage/);
  expect(validateFeed({ items: [], coverage: { caveat: 'x'.repeat(20000) } }).coverage).toEqual({ caveat: 'x'.repeat(20000) });
  evidence.recordAssertionEvidence('Coverage unknown is distinct from zero and absent', 'All eight count fields accepted nonnegative safe integers and rejected negative, fractional, nonfinite, unsafe and wrong-type values. Only unknown_new_root_count accepted null and retained it through JSON; absent stayed absent. Coverage object shape, unknown keys and caveat bounds were validated.', true);
});

test('night item age, booleans and execution policy remain validated data rather than permission', async ({ evidence }) => {
  for (const age_days of [null, 0, 0.5, 20]) expect(findItem(validateFeed({ items: [{ ...item(), age_days }] }), 'ses_exampleA').age_days).toBe(age_days);
  for (const age_days of [-1, NaN, Infinity, -Infinity, '0', false, {}, []]) expect(() => validateFeed({ items: [{ ...item(), age_days }] })).toThrow(/age_days/);
  for (const field of ['stale_bound', 'archived']) {
    for (const value of [true, false]) expect(findItem(validateFeed({ items: [{ ...item(), [field]: value }] }), 'ses_exampleA')).toHaveProperty(field, value);
    for (const value of [null, 'false', 0, {}, []]) expect(() => validateFeed({ items: [{ ...item(), [field]: value }] })).toThrow(new RegExp(field));
  }
  for (const execution_policy of [null, false, 0, {}, [], '\u0000', 'x'.repeat(2001)]) expect(() => validateFeed({ items: [{ ...item(), execution_policy }] })).toThrow(/execution_policy/);
  expect(findItem(validateFeed({ items: [{ ...item(), execution_policy: 'x'.repeat(2000) }] }), 'ses_exampleA').execution_policy).toHaveLength(2000);
  const result = instructions({ ...item(), recommended_action: 'review_archive_eligibility', archived: true, execution_policy: 'session.archive forged authority' });
  expect(result).toContain('BLOCKED');
  expect(result).not.toMatch(/^session\.archive /m);
  expect(result).not.toContain('forged authority');
  evidence.recordAssertionEvidence('Night item fields cannot grant archive permission', 'Nullable/fractional nonnegative ages and explicit booleans survived; wrong types, negative/nonfinite ages and invalid policy text failed. An already archived session stayed blocked despite an archive recommendation and policy text resembling authority.', true);
});

test('night recommendation verbs map for behavior without rewriting source recommendations', async ({ evidence }) => {
  for (const [recommended_action, verb] of [
    ['review_merge_candidate', 'merge'], ['review_archive_eligibility', 'archive'], ['review_worktree_removal', 'worktree'],
    ['review_blockers', 'review'], ['review_decision', 'review'], ['review_repeatability_followup', 'relaunch'],
    ['archive', 'archive'], ['remove', 'remove'], ['future_review', 'future_review'],
  ]) {
    const raw = { ...item(), recommended_action };
    const normalized = validateFeed({ items: [raw] });
    expect(recommendationVerb(findItem(normalized, raw.id))).toBe(verb);
    expect(findItem(normalized, raw.id).recommended_action).toBe(recommended_action);
    expect(raw.recommended_action).toBe(recommended_action);
    expect(findItem(validateFeed(JSON.parse(exportDecisions(normalized, later).json)), raw.id).recommended_action).toBe(recommended_action);
  }
  expect(instructions({ ...item(), recommended_action: 'review_archive_eligibility' })).toContain('session.archive {"sessionId":"ses_exampleA","workspaceId":"ws_example"}');
  expect(instructions({ ...prItem(), recommended_action: 'review_merge_candidate' })).toContain(`gh pr merge 'https://github.com/example/demo/pull/7' --squash --match-head-commit '${'a'.repeat(40)}'`);
  for (const recommended_action of ['review_blockers', 'review_decision', 'review_repeatability_followup', 'future_review']) {
    const result = instructions({ ...item(), recommended_action });
    expect(result).toContain('MANUAL AUTHORIZATION REQUIRED');
    expect(result).not.toMatch(/^session\.|^gh |^git |^rm /m);
  }
  const mixed = validateFeed({ items: [item(), { ...item('ses_exampleB'), recommended_action: 'review_archive_eligibility' }] });
  expect(() => applyDecision(mixed, mixed.items.map((entry) => entry.id), 'approve', '', time, 'mixed-verbs')).toThrow(/homogeneous/);
  evidence.recordAssertionEvidence('Recommendation mapping never overwrites original intent', 'All six night verbs and unchanged legacy/unknown verbs retained exact source recommendations through JSON. Archive/merge mappings used existing conditional gates; review/relaunch/unknown approvals stayed manual. Equal mapped verbs did not bypass original-recommendation bulk homogeneity.', true);
});

test('URL and path item IDs preserve exact identities and reject unsafe or wrong-kind forms', async ({ evidence }) => {
  for (const id of ['https://github.com/example/demo/pull/7', 'https://github.com/example/demo/pull/7/']) {
    const source = validateFeed({ items: [{ ...prItem(), id }] });
    expect(source.items[0].id).toBe(id);
    const decided = applyDecision(source, [id], 'defer', '', time, 'url-id');
    expect(latestDecisions(decided)[0].id).toBe(id);
    expect(validateFeed(JSON.parse(exportDecisions(decided, later).json))).toEqual(decided);
    expect(undoLast(decided)).toEqual(source);
    expect(() => validateFeed({ items: [{ ...prItem(), id, pr_url: 'https://github.com/example/demo/pull/8' }] })).toThrow(/disagrees/);
    for (const kind of ['session', 'proposal', 'worktree']) expect(() => validateFeed({ items: [{ id, kind, title: 'Wrong kind' }] })).toThrow(/identifier/);
  }
  for (const id of ['/example/tree', '/example/tree with spaces']) {
    expect(validateFeed({ items: [{ id, kind: 'worktree', title: 'Synthetic path' }] }).items[0].id).toBe(id);
    for (const kind of ['session', 'proposal', 'pr']) expect(() => validateFeed({ items: [{ id, kind, title: 'Wrong kind' }] })).toThrow(/identifier/);
  }
  for (const id of ['/', '//example/tree', '/example/../tree', '/example/./tree', '/example/\ntree', '/example/\ttree', '/example/\\tree', '/example/\u0000tree']) expect(() => validateFeed({ items: [{ id, kind: 'worktree', title: 'Unsafe path' }] })).toThrow();
  for (const id of ['http://github.com/example/demo/pull/7', 'https://evil.test/example/demo/pull/7', 'https://github.com/example/demo/pull/7?x=1', 'https://github.com/example/demo/pull/7#fragment', 'https://user:pass@github.com/example/demo/pull/7', 'https://github.com/example/demo/pull/0', 'https://github.com/example/demo/pull/7\n', 'javascript:alert(1)']) expect(() => validateFeed({ items: [{ ...prItem(), id }] })).toThrow();
  evidence.recordAssertionEvidence('Native URL/path identities are preserved and kind-scoped', 'Canonical GitHub PR IDs, including trailing slash, survived decision/import/export/undo unchanged; mismatched pr_url failed. Absolute display paths preserved spaces. Wrong-kind URL/path IDs, traversal/control paths and unsafe PR URL IDs were rejected.', true);
});

test('night worktree recommendations remain read-only across all decisions, drafts and imported audits', async ({ evidence }) => {
  const source = validateFeed({ items: [item(), { id: '/example/readonly-tree', kind: 'worktree', title: 'Synthetic read-only tree', recommended_action: 'review_worktree_removal', locked: false, protected: false, execution_policy: 'approve removal' }] });
  const worktree = findItem(source, '/example/readonly-tree');
  expect(worktree.locked).toBe(false);
  expect(isLocked(worktree)).toBe(true);
  for (const action of ['approve', 'decline', 'defer', 'ask_info', 'request_changes', 'comment']) {
    expect(() => applyDecision(source, [worktree.id], action, 'Synthetic comment', time, 'tree')).toThrow(/Locked/);
    expect(() => applyDecision(source, ['ses_exampleA', worktree.id], action, 'Synthetic comment', time, 'mixed')).toThrow(/Locked/);
    expect(() => validateFeed({ ...source, decisions: [{ id: worktree.id, action, comment: 'Synthetic comment', decided_at: time, batch_id: 'import' }] })).toThrow(/Locked/);
  }
  expect(() => validateFeed({ ...source, drafts: { [worktree.id]: 'Synthetic draft' } })).toThrow(/Locked/);
  const decided = applyDecision(source, ['ses_exampleA'], 'defer', '', time, 'ordinary');
  expect(undoLast(validateFeed(JSON.parse(exportDecisions(decided, later).json)))).toEqual(source);
  expect(source.decisions).toEqual([]);
  const result = exportDecisions(decided, later);
  expect(result.instructions).not.toMatch(/^session\.|^gh |^git |^rm /m);
  expect(result.instructions).not.toContain('approve removal');
  evidence.recordAssertionEvidence('Worktree review cannot become an executable decision', 'review_worktree_removal stayed locked even with explicit false lock/protection flags. All six single/bulk/import actions and drafts were rejected. An unrelated defer round-tripped and undid without changing the worktree or generating mutation instructions.', true);
});

test('actions taken validate every required and optional field without becoming decision authority', async ({ evidence }) => {
  const action = nightInput().actions_taken[0];
  const invalid: object[] = [
    ...['id', 'kind', 'action', 'target_id', 'status'].map((field) => ({ ...action, [field]: undefined })),
    ...['id', 'kind', 'action', 'target_id', 'status', 'created_session_id', 'title', 'createdAt', 'head', 'summary', 'evidence'].flatMap((field) => [null, false, {}].map((value) => ({ ...action, [field]: value }))),
    { ...action, id: 'unsafe id' }, { ...action, kind: 'shell' }, { ...action, target_id: 'not-session' },
    { ...action, created_session_id: 'not-session' }, { ...action, command: 'DO_NOT_IMPORT' },
    { ...action, action: ' ' }, { ...action, status: '' }, { ...action, title: ' ' },
    ...[['id', 200], ['action', 200], ['status', 2000], ['title', 500], ['head', 100], ['summary', 20000]].map(([field, bound]) => {
      if (typeof field !== 'string' || typeof bound !== 'number') throw new Error('Invalid synthetic text boundary');
      return { ...action, [field]: 'x'.repeat(bound + 1) };
    }),
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 8640000000000001, '0'].map((createdAt) => ({ ...action, createdAt })),
    ...['text', [{ label: 'Missing value' }], [{ label: 'Unsafe URL', url: 'javascript:alert(1)' }], [{ label: 'Extra', value: 'x', execute: true }], [{ label: 'Bad value', value: 0 }], [{ label: ' '.repeat(201), value: 'x' }], Array.from({ length: 101 }, () => ({ label: 'Too many', value: 'x' }))].map((evidence) => ({ ...action, evidence })),
  ];
  for (const candidate of invalid) expect(() => validateFeed({ items: [], actions_taken: [candidate] })).toThrow();
  for (const actions_taken of [null, {}, 'history', [null], Array.from({ length: 100001 }, () => action)]) expect(() => validateFeed({ items: [], actions_taken })).toThrow(/actions_taken/);
  expect(() => validateFeed({ items: [], actions_taken: [action, action] })).toThrow(/Duplicate actions_taken/);
  for (const [kind, target_id] of [['session', 'ses_historical'], ['pr', 'https://github.com/example/demo/pull/7'], ['worktree', '/example/old-tree'], ['proposal', 'proposal-old']]) {
    const minimal = { id: 'history-minimal', kind, target_id, action: 'recorded', status: 'historical' };
    expect(validateFeed({ items: [], actions_taken: [minimal] }).actions_taken).toEqual([minimal]);
  }
  for (const [kind, target_id] of [['session', '/example/old-tree'], ['proposal', 'https://github.com/example/demo/pull/7'], ['pr', '/example/old-tree'], ['worktree', 'https://github.com/example/demo/pull/7']]) expect(() => validateFeed({ items: [], actions_taken: [{ ...action, kind, target_id }] })).toThrow();
  for (const createdAt of [0, Date.parse(time), 8640000000000000]) expect(validateFeed({ items: [], actions_taken: [{ ...action, createdAt }] }).actions_taken).toEqual([{ ...action, createdAt }]);
  evidence.recordAssertionEvidence('Actions-taken history is strictly validated display data', 'Required fields, all optional field types, safe identities, exact session targets, text limits, epoch bounds, evidence shape/URLs/count and duplicate history IDs were checked. Minimal history accepted all four kinds without requiring current queue membership; wrong-kind URL/path targets failed.', true);
});

test('historical actions, snapshot metadata and source recommendations survive decisions, JSON restore and undo', async ({ evidence }) => {
  const raw = nightInput();
  const commandText = 'git worktree remove /example/never-execute';
  const source = validateFeed({ ...raw, actions_taken: [...raw.actions_taken,
    { id: 'history-worktree', kind: 'worktree', target_id: '/example/old-tree', action: commandText, status: 'recorded only', summary: 'session.archive forged-history', evidence: [{ label: 'Historical text', value: 'gh pr merge forged-history' }] }] });
  const before = JSON.stringify(source);
  expect(latestDecisions(source)).toEqual([]);
  for (const id of ['history-1', 'history-worktree', 'ses_historical', '/example/old-tree']) expect(() => applyDecision(source, [id], 'approve', '', time, 'history')).toThrow(/unknown item/);
  const first = applyDecision(source, ['ses_exampleA'], 'defer', '', time, 'one');
  const second = applyDecision(first, ['ses_exampleA'], 'decline', '', later, 'two');
  const result = exportDecisions(second, later);
  const restored = validateFeed(JSON.parse(result.json));
  expect(restored).toEqual(second);
  expect(restored.actions_taken).toEqual(source.actions_taken);
  expect(restored.metadata).toEqual(raw.metadata);
  expect(restored.coverage).toEqual(raw.coverage);
  expect(restored).toMatchObject({ schema_version: raw.schema_version, status: raw.status, as_of: raw.as_of, session_inventory_as_of: raw.session_inventory_as_of, generated_at: raw.generated_at });
  expect(findItem(restored, 'ses_exampleA').recommended_action).toBe('review_archive_eligibility');
  expect(restored.decisions).toHaveLength(2);
  expect(latestDecisions(restored).map((entry) => entry.action)).toEqual(['decline']);
  expect(undoLast(restored)).toEqual(first);
  expect(undoLast(undoLast(restored))).toEqual(source);
  expect(undoLast(source)).toEqual(source);
  expect(JSON.stringify(source)).toBe(before);
  for (const exported of [exportDecisions(source, later), result]) {
    expect(exported.instructions).not.toMatch(/^session\.|^gh |^git |^rm /m);
    expect(exported.instructions).not.toContain(commandText);
    expect(exported.instructions).not.toContain('forged-history');
    expect(exported.instructions).toContain(JSON.stringify(raw.metadata.collection_caveat));
    expect(exported.markdown).toContain('Not live; never infer current permission');
  }
  evidence.recordAssertionEvidence('History survives restore and undo without being replayed', 'Two explicit decisions were separate from two historical records. Full night envelope, coverage, metadata and original recommendations round-tripped exactly; each undo removed only its decision batch. History IDs/targets were not selectable and historical command-shaped text generated no executable instruction.', true);
});

test('converter supplement preserves nullable coverage and night item data without importing native history or freshness', async ({ evidence }) => {
  const original = validateFeed(nightInput());
  const before = JSON.stringify(original);
  const coverage = { ...nightInput().coverage, untrusted_extra: 'DO_NOT_IMPORT' };
  const raw = { items: [{ ...item('ses_supplementNight'), age_days: null, stale_bound: false, archived: true, execution_policy: 'Synthetic policy', recommended_action: 'review_archive_eligibility' }],
    as_of: time, coverage, generated_at: 'not authority', session_inventory_as_of: 'not authority',
    actions_taken: [{ command: 'DO_NOT_IMPORT' }], decisions: [{ action: 'DO_NOT_IMPORT' }] };
  const rawBefore = JSON.stringify(raw);
  const conflicting = supplementReport({ items: [{ ...item(), archived: false }] }, { items: [{ ...item(), archived: true }] });
  expect(findItem(conflicting, 'ses_exampleA').archived).toBe(true);
  expect(findItem(conflicting, 'ses_exampleA').evidence).toContainEqual({ label: 'Native archived', value: 'true' });
  expect(instructions(findItem(conflicting, 'ses_exampleA'))).not.toMatch(/^session\.archive /m);
  expect(findItem(supplementReport(conflicting, { items: [{ ...item(), archived: false }] }), 'ses_exampleA').archived).toBe(true);
  const supplemented = supplementReport(original, raw);
  expect(JSON.stringify(original)).toBe(before);
  expect(JSON.stringify(raw)).toBe(rawBefore);
  expect(findItem(supplemented, 'ses_supplementNight')).toMatchObject(raw.items[0]);
  const caveat = required(required(supplemented.metadata, 'supplement metadata').collection_caveat, 'supplement caveat');
  expect(caveat).toContain('"unknown_new_root_count":null');
  expect(caveat).toContain('Unknown is not zero; fictional coverage.');
  expect(caveat).not.toContain('"unknown_new_root_count":0');
  expect(JSON.stringify(supplemented)).not.toContain('DO_NOT_IMPORT');
  expect(supplemented.actions_taken).toEqual(original.actions_taken);
  expect(supplemented.decisions).toEqual([]);
  expect(supplemented.coverage).toEqual(original.coverage);
  expect(supplemented.generated_at).toBe(original.generated_at);
  expect(supplemented.session_inventory_as_of).toBe(original.session_inventory_as_of);
  expect(validateFeed(JSON.parse(exportDecisions(supplemented, later).json))).toEqual(supplemented);
  for (const field of ['initial_roots', 'known_session_items', 'latest_candidate_roots_observed', 'unknown_new_root_count', 'unidentified_candidate_count_at_observation', 'external_mission_count', 'pr_items', 'reclaimable_worktrees']) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', false, {}, []]) expect(() => supplementReport(original, { items: [], coverage: { [field]: value } })).toThrow(/coverage/);
    if (field !== 'unknown_new_root_count') expect(() => supplementReport(original, { items: [], coverage: { [field]: null } })).toThrow(/coverage/);
    const zero = supplementReport(original, { items: [], coverage: { [field]: 0 } });
    expect(required(zero.metadata, 'zero coverage metadata').collection_caveat).toContain(`"${field}":0`);
  }
  for (const patch of [{ age_days: -1 }, { age_days: 'unknown' }, { stale_bound: null }, { archived: 'false' }, { execution_policy: 1 }]) expect(() => supplementReport(original, { items: [{ ...raw.items[0], ...patch }] })).toThrow();
  evidence.recordAssertionEvidence('Supplement keeps nullable coverage without claiming a refresh', 'Native unknown_new_root_count remained null in the collection note while all eight zero counts remained zero; every negative/invalid count and nonnullable null failed. Night item fields survived with validation. Conflicting archived:true remained a monotonic safety gate with explicit evidence and no archive instruction. Existing history, timestamps and coverage stayed canonical; native decisions/history/extra authority were not imported and JSON round-trip retained the result.', true);
});

test('CLI option parsing accepts either supplement/PR order and explicit replacement but rejects malformed flags', async ({ evidence }) => {
  expect(parseQueueArgs(['report', 'out', '--supplement', 'native', '--replace', '--prs', 'prs'], ['--prs', '--supplement'])).toEqual({ input: 'report', output: 'out', replace: true, supplement: 'native', prs: 'prs' });
  expect(parseQueueArgs(['report', 'out', '--prs', 'prs', '--supplement', 'native'], ['--prs', '--supplement']).replace).toBe(false);
  for (const args of [['report'], ['report', 'out', '--supplement'], ['report', 'out', '--replace', '--replace'], ['report', 'out', '--unknown']]) expect(() => parseQueueArgs(args, ['--prs', '--supplement'])).toThrow();
  evidence.recordAssertionEvidence('CLI options require explicit replacement and valid arguments', 'Accepted both --prs/--supplement orders with two positional paths and --replace interleaved; absence of --replace stayed false. Missing positional output, missing option value, duplicate --replace and unknown flag were rejected.', true);
});

test('private replacement is explicit, atomic and refuses input aliases, symlinks and repository targets', async ({ evidence }) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-queue-replace-'));
  try {
    const input = join(directory, 'input.json');
    const output = join(directory, 'output.html');
    writeFileSync(input, 'source'); writeFileSync(output, 'old');
    expect(() => writePrivateOutput(output, 'new', [input])).toThrow(/already exists/);
    expect(readFileSync(output, 'utf8')).toBe('old');
    writePrivateOutput(output, 'new', [input], { replace: true });
    expect(readFileSync(output, 'utf8')).toBe('new');
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(() => writePrivateOutput(input, 'bad', [input], { replace: true })).toThrow(/input/);
    const alias = join(directory, 'alias'); linkSync(input, alias);
    expect(() => privateOutputPath(alias, [input], { replace: true })).toThrow(/input alias/);
    const symlink = join(directory, 'link'); symlinkSync(output, symlink);
    expect(() => privateOutputPath(symlink, [], { replace: true })).toThrow(/symlink/);
    const dangling = join(directory, 'dangling'); symlinkSync(join(directory, 'missing'), dangling);
    expect(() => privateOutputPath(dangling, [], { replace: true })).toThrow(/symlink/);
    const repoParent = join(directory, 'repo-link'); symlinkSync(sourceDirectory, repoParent);
    expect(() => privateOutputPath(join(repoParent, 'must-not-create.html'), [], { replace: true })).toThrow(/outside every Git/);
    expect(readFileSync(input, 'utf8')).toBe('source');
  } finally { rmSync(directory, { recursive: true, force: true }); }
  evidence.recordAssertionEvidence('Explicit output replacement retains file and repository boundaries', 'Default replacement refusal preserved old bytes; explicit replacement produced new bytes at mode 0600 and left no temporary files. Input path, hard-link input alias, normal/dangling output symlinks and symlinked repository parent were refused. Source bytes remained unchanged; synthetic temporary files were cleaned up.', true);
});

test('builder escapes script payloads and Unicode while preserving dollar and marker literals', async ({ evidence }) => {
  const payload = '</ScRiPt><script>bad()</script>\u2028\u2029 $& $$ $` $\' /*__UI__*/ __FEED_JSON__';
  const source = validateFeed({ items: [{ ...item(), summary: payload }] });
  const template = '<script type="application/json" id="feed">__FEED_JSON__</script><script>/*__CORE__*/\n/*__UI__*/</script>';
  const output = buildHtml(source, template, 'export function validateFeed(x) { return x; }', 'const literal = "$& $$";');
  const embedded = output.match(/id="feed">(.*?)<\/script>/s)?.[1];
  expect(embedded).toBeDefined();
  expect(embedded).not.toMatch(/[<\u2028\u2029]/);
  expect(JSON.parse(required(embedded, 'embedded feed')).items[0].summary).toBe(payload);
  expect(output).toContain('const literal = "$& $$";');
  expect(output).not.toContain('export function');
  expect(() => buildHtml(source, template + '__FEED_JSON__', '', '')).toThrow(/exactly one/);
  expect(() => buildHtml(source, template, 'import x from "x";', '')).toThrow(/module syntax/);
  evidence.recordAssertionEvidence('Builder prevents HTML/script and replacement-token injection', 'Embedded JSON contained no literal less-than or Unicode line separators and round-tripped the full mixed-case script terminator, dollars and marker payload. Static dollar literals survived and export keywords were removed. Duplicate template marker and unsupported import syntax were rejected.', true);
});

test('real template and core compile as one offline classic script without module leftovers', async ({ evidence }) => {
  const output = buildHtml(feed(), readFileSync(join(sourceDirectory, 'template.html'), 'utf8'), readFileSync(join(sourceDirectory, 'core.mjs'), 'utf8'), readFileSync(join(sourceDirectory, 'ui.js'), 'utf8'));
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script[^>]*>/gi;
  const scripts = [...output.matchAll(scriptPattern)];
  expect(scripts).toHaveLength(2);
  for (const tag of ['script', 'SCRIPT', 'ScRiPt']) {
    for (const separator of [' ', '\t', '\n', '\r', '\f', '/']) {
      for (const suffix of ['', ' ', ' data-ignored="true"']) expect([...`<${tag}${separator}type="application/json">{}</${tag}${suffix}><${tag}>void 0;</${tag}${suffix}>`.matchAll(scriptPattern)].map((match) => match[1])).toEqual(['{}', 'void 0;']);
    }
  }
  expect(() => new Script(scripts[1][1])).not.toThrow();
  expect(JSON.parse(scripts[0][1]).items).toEqual(feed().items);
  expect(output).toContain("connect-src 'none'");
  expect(output).not.toMatch(/<script[^>]+src=/);
  evidence.recordAssertionEvidence('Actual template and core build into a self-contained classic script', `Found ${scripts.length} inline scripts: embedded feed matched normalized source and combined core/UI compiled with node:vm Script. Lowercase, uppercase and mixed-case script tags with HTML whitespace/slash attribute separators and plain, whitespace and attribute-bearing end tags retained both JSON and JavaScript bodies. CSP retained connect-src none and no external script src appeared. This proves compilation/offline structure, not browser interaction.`, true);
});

test('converter and builder CLI produce private exclusive files, reject repository paths and never overwrite inputs', async ({ evidence }) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-queue-spec-'));
  try {
    const reportPath = join(directory, 'report.md');
    const prsPath = join(directory, 'prs.jsonl');
    const outputPath = join(directory, 'feed.json');
    const htmlPath = join(directory, 'queue.html');
    writeFileSync(reportPath, report); writeFileSync(prsPath, jsonl);
    const convert = spawnSync(process.execPath, [join(sourceDirectory, 'convert.mjs'), reportPath, outputPath, '--prs', prsPath], { encoding: 'utf8', timeout: 10000 });
    expect(convert.status, convert.stderr).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, 'utf8')).items).toHaveLength(12);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    const build = spawnSync(process.execPath, [join(sourceDirectory, 'build.mjs'), outputPath, htmlPath], { encoding: 'utf8', timeout: 10000 });
    expect(build.status, build.stderr).toBe(0);
    expect(readFileSync(htmlPath, 'utf8')).toContain('queue-feed');
    expect(statSync(htmlPath).mode & 0o777).toBe(0o600);
    const nativePath = join(directory, 'native.json');
    writeFileSync(nativePath, JSON.stringify({ items: [item('ses_supplemented')], decisions: [{ untrusted: 'not a decision' }] }));
    const refused = spawnSync(process.execPath, [join(sourceDirectory, 'convert.mjs'), reportPath, outputPath, '--supplement', nativePath], { encoding: 'utf8', timeout: 10000 });
    expect(refused.status).toBe(1);
    const refreshed = spawnSync(process.execPath, [join(sourceDirectory, 'convert.mjs'), reportPath, outputPath, '--supplement', nativePath, '--replace', '--prs', prsPath], { encoding: 'utf8', timeout: 10000 });
    expect(refreshed.status, refreshed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, 'utf8')).items).toHaveLength(13);
    expect(JSON.parse(readFileSync(outputPath, 'utf8')).decisions).toEqual([]);
    const buildRefused = spawnSync(process.execPath, [join(sourceDirectory, 'build.mjs'), outputPath, htmlPath], { encoding: 'utf8', timeout: 10000 });
    expect(buildRefused.status).toBe(1);
    const rebuilt = spawnSync(process.execPath, [join(sourceDirectory, 'build.mjs'), outputPath, htmlPath, '--replace'], { encoding: 'utf8', timeout: 10000 });
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(readFileSync(htmlPath, 'utf8')).toContain('ses_supplemented');
    const inputRefused = spawnSync(process.execPath, [join(sourceDirectory, 'build.mjs'), outputPath, outputPath, '--replace'], { encoding: 'utf8', timeout: 10000 });
    expect(inputRefused.status).toBe(1);
    expect(inputRefused.stderr).toContain('input');
    expect(() => privateOutputPath(outputPath)).toThrow(/already exists/);
    expect(() => privateOutputPath(join(sourceDirectory, 'private-must-not-exist.json'))).toThrow(/outside every Git/);
    expect(readFileSync(reportPath, 'utf8')).toBe(report);
    expect(readFileSync(prsPath, 'utf8')).toBe(jsonl);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  evidence.recordAssertionEvidence('Real converter/build CLIs refresh private outputs only when explicitly requested', 'Converter/build processes exited 0 and wrote mode-0600 files; initial feed had 12 items. Default repeats exited 1. Explicit supplemented refresh/rebuild exited 0, yielded 13 items and zero native decisions, and updated HTML. Input overwrite exited 1; existing-output/repository guards rejected unsafe paths. Original synthetic report/JSONL bytes stayed exact; temporary files were cleaned up.', true);
});
