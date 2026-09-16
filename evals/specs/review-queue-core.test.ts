import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, statSync, symlinkSync, linkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { validateFeed, applyDecision, undoLast, latestDecisions, exportDecisions, safeUrl, isLocked } from '../../tools/review-queue/core.mjs';
import { convertReport, supplementReport, privateOutputPath, writePrivateOutput, parseQueueArgs, tableCells } from '../../tools/review-queue/convert.mjs';
import { buildHtml } from '../../tools/review-queue/build.mjs';

const time = '2026-01-01T12:00:00.000Z';
const later = '2026-01-01T12:01:00.000Z';
const sourceDirectory = fileURLToPath(new URL('../../tools/review-queue/', import.meta.url));
function item(id = 'ses_exampleA') {
  return { id, kind: 'session', title: 'Synthetic task', summary: 'Fictional evidence only',
    evidence: [{ label: 'Workspace', value: 'openwork' }, { label: 'Pinned', value: 'no' }, { label: 'Status', value: 'idle' }],
    recommended_action: 'archive', links: [], age: 'an arbitrary age label', risk: 'low', group: 'openwork',
    workspace_id: 'ws_example', protected: false };
}
function feed() {
  return validateFeed({ items: [item(), item('ses_exampleB')], decisions: [], metadata: { source: 'synthetic', collection_caveat: 'Not live; original snapshot only.' } });
}
function prItem() {
  return { id: 'pr-7', kind: 'pr', title: 'Synthetic PR', recommended_action: 'merge', group: 'PR / OPEN',
    pr_url: 'https://github.com/example/demo/pull/7', head_sha: 'a'.repeat(40), evidence: [{ label: 'State', value: 'OPEN' }] };
}
function instructions(candidate: object, action = 'approve', comment = '') {
  const source = validateFeed({ items: [candidate] });
  return exportDecisions(applyDecision(source, [source.items[0].id], action, comment, time, 'batch-1'), later).instructions;
}
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
  expect(sample.items).toHaveLength(6);
  expect(sample.decisions).toEqual([]);
  expect(JSON.parse(readFileSync(join(sourceDirectory, 'review-queue.schema.json'), 'utf8')).$defs.item.properties.locked.type).toBe('boolean');
  evidence.recordAssertionEvidence('Normalization copies input without creating decisions', `Sample items: ${sample.items.length}; sample decisions: ${sample.decisions.length}. Arbitrary age text preserved; mutating normalized evidence did not change source evidence. Schema declares locked as boolean.`, true);
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

test('last event wins including comment; undo drops exactly one complete batch', async ({ evidence }) => {
  const original = feed();
  const first = applyDecision(original, ['ses_exampleA', 'ses_exampleB'], 'approve', '', time, 'bulk');
  const second = applyDecision(first, ['ses_exampleA'], 'comment', 'Still a question', later, 'followup');
  expect(latestDecisions(second).map((event) => event.action)).toEqual(['comment', 'approve']);
  expect(second.decisions).toHaveLength(3);
  expect(undoLast(second)).toEqual(first);
  expect(undoLast(first)).toEqual(original);
  expect(undoLast(original)).toEqual(original);
  expect(second.decisions).toHaveLength(3);
  evidence.recordAssertionEvidence('Latest comment wins and undo removes only the last batch', `Effective actions: ${JSON.stringify(latestDecisions(second).map((event) => event.action))}; audit remains ${second.decisions.length} events. Undo restored the preceding bulk, then the original empty history; undo on empty history was a no-op and did not mutate the three-event input.`, true);
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
    expect(JSON.parse(call!.slice('session.send '.length))).toEqual({ sessionId: 'ses_exampleA', text: comment });
    expect(result).not.toMatch(/^gh pr /m);
  }
  expect(instructions(prItem(), 'ask_info', 'Please clarify')).toContain('BLOCKED');
  const externalOwner = validateFeed({ items: [{ ...item(), locked: true }, { ...prItem(), owner_session_id: 'ses_exampleA' }] });
  const blocked = exportDecisions(applyDecision(externalOwner, ['pr-7'], 'comment', 'Do not send', time, 'batch'), later).instructions;
  expect(blocked).toContain('target owner is locked');
  expect(blocked).not.toMatch(/^session\.send /m);
  for (const kind of ['proposal', 'worktree']) {
    const result = instructions({ id: 'example', title: 'Example', kind, recommended_action: 'remove' });
    expect(result).toContain('MANUAL AUTHORIZATION REQUIRED');
    expect(result).not.toMatch(/^git |^rm |^session\./m);
  }
  evidence.recordAssertionEvidence('Follow-ups are exact JSON data, never arbitrary commands', 'Session and PR-owner follow-ups parsed back to the exact synthetic target/comment containing quotes, newline, shell substitution and HTML; no PR command was emitted. Missing and locked owners were blocked. Proposal/worktree approval required manual authorization and emitted no git, rm or session mutation.', true);
});

test('exports preserve exact normalized items, metadata, full audit and effective decisions for restore', async ({ evidence }) => {
  const first = applyDecision(feed(), ['ses_exampleA', 'ses_exampleB'], 'approve', '', time, 'bulk');
  const last = applyDecision(first, ['ses_exampleA'], 'comment', '<script>alert(1)</script> | quote', later, 'followup');
  const result = exportDecisions(last, later);
  const parsed = JSON.parse(result.json);
  expect(JSON.stringify(parsed.items)).toBe(JSON.stringify(last.items));
  expect(parsed.decisions).toHaveLength(3);
  expect(parsed.audit).toEqual(last.decisions);
  expect(parsed.effective_decisions.map((event: { action: string }) => event.action)).toEqual(['comment', 'approve']);
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
  expect(converted.metadata.collection_caveat).toContain('Inventory is multi-call, not atomic');
  expect(converted.metadata.collected_at).toBeUndefined();
  expect(converted.items.find((entry) => entry.id === 'ses_exampleA')).toMatchObject({ recommended_action: 'archive', protected: false, workspace_id: 'ws_example' });
  for (const id of ['ses_exampleB', 'ses_exampleC', 'ses_chatExample']) expect(converted.items.find((entry) => entry.id === id).protected).toBe(true);
  expect(converted.items.find((entry) => entry.id === 'pr-7')).toMatchObject({ recommended_action: 'merge', owner_session_id: 'ses_exampleB', head_sha: 'a'.repeat(40) });
  expect(converted.items.find((entry) => entry.id === 'pr-7').summary).toContain('Passed synthetic only');
  expect(converted.items.find((entry) => entry.id === 'pr-8')).toMatchObject({ recommended_action: 'keep', protected: true });
  expect(converted.items.find((entry) => entry.id === 'pr-9').summary).toContain('verification unknown');
  expect(convertReport(report, jsonl, 'synthetic.md')).toEqual(converted);
  evidence.recordAssertionEvidence('Report conversion preserves counts and historical caveats', `Converted ${converted.items.length} synthetic items: six sessions, three PRs and three stable proposals, with zero decisions and no collected_at invented. Preserved non-atomic caveat, exact workspace/owner/head, protected pinned/running/Chat rows, closed PR keep recommendation, and unknown proof on the unverified historical PR.`, true);
});

test('converter locks explicit external mission and exact controller without broad title inference', async ({ evidence }) => {
  const converted = convertReport(report, jsonl);
  for (const id of ['ses_externalA', 'ses_controller']) {
    const entry = converted.items.find((entry) => entry.id === id);
    expect(entry).toMatchObject({ locked: true, group: 'external-mission', recommended_action: 'none' });
    expect(entry.summary).toContain('External mission (untouched)');
  }
  expect(isLocked(converted.items.find((entry) => entry.id === 'ses_chatExample'))).toBe(false);
  const externalProposal = converted.items.find((entry) => entry.kind === 'proposal' && entry.owner_session_id === 'ses_controller');
  expect(isLocked(externalProposal)).toBe(true);
  expect(() => applyDecision(converted, ['ses_controller'], 'comment', 'hello', time, 'batch')).toThrow(/Locked/);
  evidence.recordAssertionEvidence('Converter locks exact external identities without broad title guesses', 'Synthetic SUPAUD-prefixed session and exact controller were locked with external-mission/none and untouched summaries; a dependent proposal was locked. An innocent meeting-coordinator title was not locked. A comment to the controller was rejected.', true);
});

test('converter deduplicates sessions and JSONL entries, retains escaped pipes and refuses malformed input', async ({ evidence }) => {
  const duplicated = report.replace('| O01 | ses_exampleA', '| O00 | ses_exampleA | Duplicate title | 01-01 10:00 | 01-01 11:00 | unknown | —; i | C | A; older detail |\n| O01 | ses_exampleA');
  const converted = convertReport(duplicated, jsonl + '\n' + JSON.stringify({ number: 9, title: 'last row', state: 'MERGED' }));
  expect(converted.items.filter((entry) => entry.kind === 'session')).toHaveLength(6);
  expect(converted.items.filter((entry) => entry.kind === 'pr')).toHaveLength(3);
  expect(converted.items.find((entry) => entry.id === 'pr-9').title).toContain('last row');
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
  const session = supplemented.items.find((entry) => entry.id === 'ses_exampleA');
  expect(session.title).toBe(original.items.find((entry) => entry.id === 'ses_exampleA').title);
  expect(session.evidence).toEqual(expect.arrayContaining(original.items.find((entry) => entry.id === 'ses_exampleA').evidence));
  expect(session.evidence).toContainEqual({ label: 'Native summary', value: 'Supplement observation' });
  const pr = supplemented.items.find((entry) => entry.id === 'pr-7');
  expect(pr.head_sha).toBe('a'.repeat(40));
  expect(pr.evidence).toContainEqual({ label: 'Native head_sha', value: 'f'.repeat(40) });
  expect(supplemented.decisions).toEqual([]);
  expect(JSON.stringify(supplemented)).not.toContain('DO_NOT_IMPORT');
  expect(supplemented.metadata.collection_time).toBe(original.metadata.collection_time);
  expect(supplemented.metadata.collected_at).toBeUndefined();
  expect(supplemented.metadata.collection_caveat).toContain(`original_collection (native snapshot, NOT refreshed): {"as_of":"${time}"`);
  expect(supplemented.metadata.collection_caveat).toContain('Title-only coverage; one root unknown');
  const worktree = supplemented.items.find((entry) => entry.kind === 'worktree');
  expect(worktree.id).toMatch(/^worktree-[a-f0-9]{16}$/);
  expect(worktree).toMatchObject({ locked: true, protected: true, recommended_action: 'review' });
  expect(supplementReport(original, { ...raw, items: [...raw.items, raw.items[3]] }).items).toHaveLength(supplemented.items.length);
  expect(exportDecisions(supplemented, later).instructions).not.toMatch(/worktree remove|DO_NOT_IMPORT/);
  evidence.recordAssertionEvidence('Native supplement adds evidence without importing authority', `Item count grew from ${original.items.length} to ${supplemented.items.length}; native/source inputs remained unchanged, canonical title/head/evidence won, differing native observations remained evidence, and duplicate worktree rows deduplicated. No decisions or DO_NOT_IMPORT command extras survived. Collection time stayed unchanged; original as_of/coverage were retained. Worktree ID was hashed, locked/review-only and emitted no removal instruction.`, true);
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
    expect(isLocked(supplemented.items.find((entry) => entry.id === id))).toBe(true);
    expect(() => applyDecision(supplemented, [id], 'comment', 'No action', time, 'batch')).toThrow(/Locked/);
  }
  expect(supplemented.items.find((entry) => entry.id === 'ses_exampleA').group).toBe('external-mission');
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
  expect(JSON.parse(embedded!).items[0].summary).toBe(payload);
  expect(output).toContain('const literal = "$& $$";');
  expect(output).not.toContain('export function');
  expect(() => buildHtml(source, template + '__FEED_JSON__', '', '')).toThrow(/exactly one/);
  expect(() => buildHtml(source, template, 'import x from "x";', '')).toThrow(/module syntax/);
  evidence.recordAssertionEvidence('Builder prevents HTML/script and replacement-token injection', 'Embedded JSON contained no literal less-than or Unicode line separators and round-tripped the full mixed-case script terminator, dollars and marker payload. Static dollar literals survived and export keywords were removed. Duplicate template marker and unsupported import syntax were rejected.', true);
});

test('real template and core compile as one offline classic script without module leftovers', async ({ evidence }) => {
  const output = buildHtml(feed(), readFileSync(join(sourceDirectory, 'template.html'), 'utf8'), readFileSync(join(sourceDirectory, 'core.mjs'), 'utf8'), readFileSync(join(sourceDirectory, 'ui.js'), 'utf8'));
  const scripts = [...output.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(2);
  expect(() => new Script(scripts[1][1])).not.toThrow();
  expect(JSON.parse(scripts[0][1]).items).toEqual(feed().items);
  expect(output).toContain("connect-src 'none'");
  expect(output).not.toMatch(/<script[^>]+src=/);
  evidence.recordAssertionEvidence('Actual template and core build into a self-contained classic script', `Found ${scripts.length} inline scripts: embedded feed matched normalized source and combined core/UI compiled with node:vm Script. CSP retained connect-src none and no external script src appeared. This proves compilation/offline structure, not browser interaction.`, true);
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
