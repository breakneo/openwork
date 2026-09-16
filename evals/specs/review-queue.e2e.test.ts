import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { buildHtml } from '../../tools/review-queue/build.mjs';
import { validateFeed, isLocked, recommendationVerb, canApprove, hasConcreteQuestion } from '../../tools/review-queue/core.mjs';

import { writePrivateOutput } from '../../tools/review-queue/convert.mjs';

const realPage = process.env.REVIEW_QUEUE_PAGE;
const realFeed = process.env.REVIEW_QUEUE_REAL_FEED;
const cardReport = process.env.REVIEW_QUEUE_CARD_REPORT;
const root = fileURLToPath(new URL('../../tools/review-queue/', import.meta.url));
const baseItem = {
  summary: 'Synthetic evidence only. No real account, customer or private session.',
  purpose: 'Explain a fictional setting.', delivered: 'A short explanation and next steps.', status_on_dev: 'No runtime change.',
  why: 'The requested explanation is complete.', if_approved: 'Record intent only, subject to current-state checks.',
  if_declined: 'Keep the current work unchanged.', question: 'Should this explanation be retained for follow-up?',
  raw_evidence: [{ label: 'Raw source', value: 'session.read {"sessionId":"ses_fictional"}' }],
  evidence: [{ label: 'Workspace', value: 'openwork' }, { label: 'Pinned', value: 'no' }, { label: 'Status', value: 'idle' }],
  recommended_action: 'archive', links: [], age: 'Captured in synthetic fixture', risk: 'low', group: 'openwork',
  workspace_id: 'ws_fixture', protected: false,
};
function fixture() {
  return validateFeed({
    metadata: { source: 'synthetic-fixture', collection_caveat: 'Synthetic offline proof; no live status.' },
    items: [
      ...Array.from({ length: 78 }, (_, index) => ({ ...baseItem, id: `ses_fixture${index}`, kind: 'session', title: `Session ${index}` })),
      { ...baseItem, id: 'ses_external', kind: 'session', title: 'External controller', group: 'external-mission', recommended_action: 'none' },
      { ...baseItem, id: 'ses_other', kind: 'session', title: 'Another owner', locked: true, lock_reason: 'Owned by a separate reviewer.' },
      ...Array.from({ length: 130 }, (_, index) => ({ ...baseItem, id: `pr-${index + 1}`, kind: 'pr', title: `Change ${index + 1}`, recommended_action: 'review', group: 'PR / OPEN' })),
      ...Array.from({ length: 6 }, (_, index) => ({ ...baseItem, id: `proposal-${index}`, kind: 'proposal', title: `Proposal ${index}`, recommended_action: 'review', group: 'decisions' })),
    ], decisions: [],
  });
}
function expectedProse(value: string, item: ReturnType<typeof validateFeed>['items'][number], items: ReturnType<typeof validateFeed>['items']) {
  let expected = value.replace(/\bses_[A-Za-z0-9]+\b/g, (id) => {
    if (id === item.id) return 'this session';
    const related = items.find((entry) => entry.id === id);
    return related ? `“${related.title.replace(/\bses_[A-Za-z0-9]+\b/g, 'related session')}”` : 'related session';
  }).replace(/\bOpenWork Chat session this session\b/g, 'this OpenWork Chat session').replace(/\bsession (this session|related session)\b/g, '$1');
  const phrases = {
    'session.search/read': 'session search and details', 'session.read': 'session details', 'session.send': 'session messaging', 'session.archive': 'session archiving', 'session.search': 'session search', 'session.activity': 'session activity', 'session.create': 'session creation', 'session.stop': 'session stopping',
    'gh pr merge': 'merge pull request', 'gh pr view': 'view pull request', 'gh pr checks': 'pull-request checks', 'gh pr diff': 'pull-request diff', 'gh pr list': 'list pull requests', 'gh pr status': 'pull-request status', 'gh pr review': 'review pull request', 'gh pr close': 'close pull request', 'gh pr reopen': 'reopen pull request', 'gh pr': 'pull requests',
    'git worktree add': 'create working copy', 'git worktree remove': 'remove working copy', 'git worktree list': 'list working copies', 'git worktree prune': 'clean up working-copy references', 'git worktree': 'working copy',
  };
  for (const [phrase, readable] of Object.entries(phrases).sort((a, b) => b[0].length - a[0].length)) expected = expected.replace(new RegExp(`\\b${phrase.replaceAll('.', '\\.')}\\b`, 'g'), readable);
  return expected.replace(/`+/g, '');
}
function expectedOutcome(item: ReturnType<typeof validateFeed>['items'][number], action: string, items: ReturnType<typeof validateFeed>['items']) {
  if (action === 'decline') return item.kind === 'session' && !item.archived ? 'leave this session open' : item.kind === 'pr' ? 'leave this PR unchanged' : 'leave this item unchanged';
  if (!canApprove(item)) return 'unavailable — no actionable approval outcome';
  if (item.kind === 'session' && recommendationVerb(item) === 'archive') return 'archive this session';
  if (item.kind === 'pr' && recommendationVerb(item) === 'merge') return 'merge this PR';
  const clause = expectedProse(item.if_approved || item.question, item, items).replace(/\s+/g, ' ').split(/;|\b(?:only after|subject to|provided that|otherwise)\b|(?<=[.!?])\s/i)[0].trim();
  return clause.length > 100 ? `${clause.slice(0, 99).replace(/\s+\S*$/, '')}…` : clause;
}
async function exportJson(page: Page) {
  const download = page.waitForEvent('download');
  await page.getByTestId('export-json').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^decisions-.*\.json$/);
  const path = await file.path();
  if (!path) throw new Error('No downloaded JSON file');
  return { data: JSON.parse(await readFile(path, 'utf8')), path };
}

test('offline review queue records a scoped batch, exports and restores it, and hard-locks other owners', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-queue-browser-'));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const requests: string[] = [];
  const errors: string[] = [];
  context.on('request', (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  // No prompt or private page is driven; this browser belongs only to this synthetic test.
  page.on('dialog', (dialog) => dialog.accept());
  try {
    const input = fixture();
    const html = buildHtml(input, await readFile(join(root, 'template.html'), 'utf8'), await readFile(join(root, 'core.mjs'), 'utf8'), await readFile(join(root, 'ui.js'), 'utf8'));
    const path = join(directory, 'index.html');
    await writeFile(path, html);
    await page.goto(pathToFileURL(path).href);
    await page.locator('#status').selectOption('');
    expect(await page.getByTestId('queue-row').count()).toBe(216);
    expect(await page.getByTestId('item-select').count()).toBe(214);
    expect(await page.locator('.locked-heading').textContent()).toContain('Nothing to decide');
    expect(await page.locator('#metrics').textContent()).toContain('2 nothing to decide');
    for (let index = 0; index < 3; index++) await page.locator(`[data-id="ses_fixture${index}"] input`).check();
    await page.getByTestId('bulk-approve').click();
    expect(await page.locator('#batch-preview li').count()).toBe(3);
    expect(await page.locator('#confirm-title').textContent()).toBe('Approve 3 items?');
    await page.getByTestId('confirm-bulk').click();
    const first = await exportJson(page);
    const exported = validateFeed(first.data);
    expect(exported.decisions.map((decision) => decision.id)).toEqual(['ses_fixture0', 'ses_fixture1', 'ses_fixture2']);
    expect(new Set(exported.decisions.map((decision) => decision.batch_id)).size).toBe(1);
    expect(exported.decisions.every((decision) => decision.action === 'approve')).toBe(true);
    expect(exported.items).toEqual(input.items);
    expect(await page.locator('#agent-plan').inputValue()).toContain('session.archive');
    evidence.recordAssertionEvidence('Three-item approval and portable export preserve scope', 'A real file:// Chromium page renders 216 synthetic items, confirms exactly three selected sessions and downloads valid JSON with three same-batch approvals. All source items survive unchanged; no other item has a decision.', true);

    const markdownDownload = page.waitForEvent('download');
    await page.getByTestId('export-markdown').click();
    const markdown = await markdownDownload;
    expect(markdown.suggestedFilename()).toMatch(/\.md$/);
    const markdownPath = await markdown.path();
    if (!markdownPath) throw new Error('No Markdown download');
    expect(await readFile(markdownPath, 'utf8')).toContain('Effective decisions (3)');
    await page.getByTestId('undo').click();
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(0);
    await page.locator('#import-decisions').setInputFiles(first.path);
    await expect.poll(async () => page.locator('#message').textContent()).toContain('Restored decision history');
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(3);
    await page.reload();
    await page.locator('#status').selectOption('');
    expect(await page.locator('#metrics').textContent()).toContain('3 approved');
    evidence.recordAssertionEvidence('Undo, JSON restore and browser restart retain explicit history', 'Undo removes the whole batch; importing its downloaded exact-snapshot JSON restores three decisions. Reload recovers the same decisions from browser storage. Markdown downloads separately.', true);

    await page.locator('#select-visible').check();
    expect(await page.getByTestId('bulk-approve').isDisabled()).toBe(true);
    expect(await page.locator('#selected-count').textContent()).toBe('214 selected');
    await page.locator('#kind').selectOption('session');
    expect(await page.locator('#bulk').isVisible()).toBe(false);
    await page.locator('#select-visible').check();
    expect(await page.locator('#selected-count').textContent()).toBe('78 selected');
    await page.locator('#clear-selection').click();
    await page.getByRole('button', { name: 'Review External controller', exact: true }).click();
    expect(await page.locator('#detail [data-action]').count()).toBe(0);
    expect(await page.locator('#comment').count()).toBe(0);
    expect(await page.locator('[data-id="ses_external"] input').count()).toBe(0);
    expect(await page.locator('.locked-banner').textContent()).toContain('Not yours to act on');
    await page.getByTestId('detail-title').click();
    await page.keyboard.press('Space');
    await page.keyboard.press('a');
    expect(await page.locator('#bulk').isVisible()).toBe(false);
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(3);
    await page.getByRole('button', { name: 'Review Another owner', exact: true }).click();
    expect(await page.locator('#detail [data-action]').count()).toBe(0);
    expect(await page.locator('.locked-banner').textContent()).toContain('separate reviewer');
    evidence.recordAssertionEvidence('Other-owner locks and homogeneous bulk boundaries are enforced', 'External-mission and generic locked items have no selection or decision controls. Select-visible excludes both; keyboard approval/selection cannot create decisions. A cross-kind selection is blocked, and changing filters clears selection.', true);

    await page.getByRole('button', { name: 'Review Session 4', exact: true }).click();
    await page.getByTestId('detail-title').click();
    await page.keyboard.press('j');
    expect(await page.getByTestId('detail-title').textContent()).toBe('Session 5');
    await page.keyboard.press('k');
    expect(await page.getByTestId('detail-title').textContent()).toBe('Session 4');
    await page.keyboard.press('c');
    await page.getByTestId('comment').fill('a d j k ? <script>literal</script>');
    await page.keyboard.press('Space');
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(3);
    await page.getByTestId('thread-send').click();
    const followup = validateFeed((await exportJson(page)).data);
    expect(followup.decisions.at(-1)?.action).toBe('message');
    expect(followup.decisions.at(-1)?.comment).toContain('<script>literal</script>');
    expect(await page.locator('#agent-plan').inputValue()).toContain('session.send');
    expect(await page.locator('#detail script').count()).toBe(0);
    await page.getByTestId('thread-send').click();
    expect(await page.locator('#message').textContent()).toContain('nonempty');
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(4);
    evidence.recordAssertionEvidence('Follow-up text and keyboard behavior are safe', 'j/k change the focused item; c focuses its text field. Typing action letters and Space records nothing. Ask-info stores literal script-shaped text without creating DOM script nodes, and blank comments are rejected.', true);

    const stale = { ...exported, items: exported.items.map((item, index) => index === 0 ? { ...item, summary: 'Evidence changed' } : item) };
    await page.locator('#import-decisions').setInputFiles({ name: 'stale.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(stale)) });
    await expect.poll(async () => page.locator('#message').textContent()).toContain('exact same items');
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(4);
    await page.locator('#import-decisions').setInputFiles({ name: 'inconsistent.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...first.data, audit: [] })) });
    await expect.poll(async () => page.locator('#message').textContent()).toContain('audit');
    const lockedEvent = { id: 'ses_external', action: 'approve', comment: '', batch_id: 'forged', decided_at: new Date().toISOString() };
    await page.locator('#import-decisions').setInputFiles({ name: 'locked.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ items: input.items, decisions: [lockedEvent] })) });
    await expect.poll(async () => page.locator('#message').textContent()).toContain('Locked');
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(4);
    await page.locator('#select-visible').check();
    await page.locator('#bulk-action').selectOption('decline');
    await page.getByTestId('bulk-approve').click();
    expect(await page.locator('#batch-preview li').count()).toBe(78);
    await page.getByTestId('confirm-bulk').click();
    const declined = validateFeed((await exportJson(page)).data);
    expect(declined.decisions.slice(-78).every((decision) => decision.action === 'decline')).toBe(true);
    expect(declined.decisions.some((decision) => ['ses_external', 'ses_other'].includes(decision.id))).toBe(false);
    await page.getByTestId('undo').click();
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(4);
    evidence.recordAssertionEvidence('Mass decline remains reversible and cannot import locked authority', 'A 78-session decline batch excludes both locked items and undoes back to the prior four events. Imports with inconsistent audits or locked-item approvals are rejected without changing decisions.', true);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
    evidence.recordAssertionEvidence('Stale backups are rejected and review has zero HTTP traffic', 'A backup with changed evidence cannot replace current decisions. Across load, bulk actions, exports, reload, locks and comments, Chromium observed zero HTTP(S) requests and zero page errors.', true);
  } finally {
    await context.close();
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// The optional private page is opened unchanged, in an isolated profile. Evidence
// records only counts/booleans, never source titles, IDs, screenshots or downloads.
test('ten seeded cards render readable prose in decision order with raw evidence collapsed', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-queue-cards-'));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  let requests = 0;
  let errors = 0;
  context.on('request', (request) => { if (/^https?:/.test(request.url())) requests++; });
  page.on('pageerror', () => errors++);
  try {
    let input: ReturnType<typeof validateFeed>;
    let originalSource: string;
    try {
      const source = realFeed || join(root, 'sample.json');
      if ((await stat(source)).size > 12 * 1024 * 1024) throw new Error('Feed too large');
      originalSource = await readFile(source, 'utf8');
      input = validateFeed(JSON.parse(originalSource));
    } catch {
      throw new Error('Card input failed validation; private source details withheld.');
    }
    expect(input.items.length >= 10).toBe(true);
    const selected: number[] = [];
    for (const verb of ['archive', 'merge', 'review']) {
      const index = input.items.findIndex((item) => !isLocked(item) && recommendationVerb(item) === verb && (verb !== 'review' || hasConcreteQuestion(item)));
      expect(index >= 0).toBe(true);
      selected.push(index);
    }
    let seed = 24681357;
    const remaining = input.items.map((_, index) => index).filter((index) => !selected.includes(index));
    while (selected.length < 10 && remaining.length) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      selected.push(...remaining.splice(seed % remaining.length, 1));
    }
    expect(new Set(selected).size).toBe(10);
    const html = buildHtml(input, await readFile(join(root, 'template.html'), 'utf8'), await readFile(join(root, 'core.mjs'), 'utf8'), await readFile(join(root, 'ui.js'), 'utf8'));
    const path = join(directory, 'index.html');
    await writeFile(path, html, { mode: 0o600 });
    await page.goto(pathToFileURL(path).href);
    await page.locator('#status').selectOption('');
    expect(await page.getByTestId('queue-row').count()).toBe(input.items.length);
    expect(await page.getByTestId('item-select').count()).toBe(input.items.filter((item) => !isLocked(item)).length);
    await page.locator('#status').selectOption('pending');
    const decided = new Set(input.decisions.map((decision) => decision.id));
    expect(await page.getByTestId('queue-row').count()).toBe(input.items.filter((item) => !isLocked(item) && !decided.has(item.id)).length);
    await page.locator('#status').selectOption('');
    expect(await page.locator('#guide > p').count()).toBe(3);
    expect(await page.locator('#guide').getAttribute('open')).toBeNull();
    const report: string[] = [];
    for (const index of selected) {
      const item = input.items[index];
      if (!item) throw new Error('Missing sampled card');
      const position = input.items.filter((entry) => !isLocked(entry)).concat(input.items.filter(isLocked)).findIndex((entry) => entry.id === item.id);
      await page.getByTestId('queue-row').nth(position).locator('.row-open').click();
      const card = page.locator('#detail');
      expect((await page.getByTestId('detail-title').textContent()) === item.title).toBe(true);
      const order = await card.locator(':scope > [data-field]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-field')));
      expect(order).toEqual(['purpose', 'status_on_dev', 'delivered', 'why', ...(item.question.trim() ? ['question'] : []), 'decision', 'evidence', 'raw_evidence']);
      expect(await card.locator(':scope > :first-child').getAttribute('data-testid')).toBe('detail-title');
      for (const [name, value] of Object.entries({ purpose: item.purpose, status_on_dev: item.status_on_dev, delivered: item.delivered, why: item.why })) {
        expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
        expect((await card.locator(`[data-field="${name}"] > p.summary`).textContent()) === expectedProse(value, item, input.items)).toBe(true);
      }
      expect(await card.locator('[data-field="why"] [data-field="recommendation"]').count()).toBe(1);
      expect(await card.locator('[data-field="delivered"] a').count()).toBe(item.links.length);
      expect(await card.locator('[data-field="question"]').count()).toBe(item.question.trim() ? 1 : 0);
      if (item.question.trim()) expect((await card.locator('[data-field="question"] > p').textContent()) === expectedProse(item.question, item, input.items)).toBe(true);
      const raw = card.locator('.raw-evidence');
      expect(await raw.getAttribute('open')).toBeNull();
      expect(await raw.locator('.detail-id').isVisible()).toBe(false);
      expect(await raw.locator('.recommendation-source').isVisible()).toBe(false);
      if (isLocked(item)) expect(await card.locator('[data-action],textarea').count()).toBe(0);
      else {
        expect(await card.locator('[data-action="approve"]').isDisabled()).toBe(!canApprove(item));
        for (const action of ['approve', 'decline']) {
          const field = action === 'approve' ? 'if_approved' : 'if_declined';
          expect(await card.locator(`.decision-action:has([data-action="${action}"]) [data-field="${field}"]`).count()).toBe(1);
          expect((await card.locator(`[data-field="${field}"]`).textContent()) === expectedOutcome(item, action, input.items)).toBe(true);
          expect(expectedOutcome(item, action, input.items).length).toBeGreaterThan(0);
          expect(expectedOutcome(item, action, input.items).length).toBeLessThanOrEqual(100);
          expect((await card.locator(`[data-prose-source="${field}"]`).textContent()) === item[field]).toBe(true);
          expect(await card.locator(`[data-field="${field}"]`).evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('nowrap');
        }
      }
      expect(await card.getByTestId('safety-gates').count()).toBe(1);
      expect(await card.getByTestId('safety-gates').getAttribute('open')).toBeNull();
      expect(await card.getByTestId('safety-gates').locator('p').isVisible()).toBe(false);
      const text = await card.innerText();
      const prose = (await card.locator('[data-field="purpose"] > p,[data-field="status_on_dev"] > p,[data-field="delivered"] > p,[data-field="why"] > p,[data-field="question"] > p,[data-field="if_approved"],[data-field="if_declined"]').allTextContents()).join('\n');
      expect(/session\.(?:read|send|archive)|gh pr |git worktree |\{\s*"|ses_[a-zA-Z0-9]{6,}|<script|`/.test(prose)).toBe(false);
      for (const entry of item.evidence.filter((entry) => ['last assistant', 'last message'].includes(entry.label.toLowerCase()))) {
        const value = entry.value?.trim() || 'Unverified — not supplied';
        if (!entry.url && /^(?:(?:unknown|unverified)(?:[.!]?$|\s*[—:–-]\s*(?:no\b|not\b|.*(?:not supplied|not applicable|unavailable)))|not (?:supplied|applicable)\b|n\/a\b)/i.test(value)) continue;
        const excerpt = value.length > 800 ? `${value.slice(0, 799)}…` : value;
        expect((await card.locator('[data-field="evidence"] .evidence-value').allTextContents()).includes(excerpt)).toBe(true);
      }
      expect(await card.locator('script,iframe,pre:visible').count()).toBe(0);
      for (const link of await card.locator('a:visible').all()) {
        expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(await link.getAttribute('referrerpolicy')).toBe('no-referrer');
      }
      report.push(`Card ${report.length + 1}\n${text}`);
    }
    expect(report.length).toBe(10);
    expect((await readFile(realFeed || join(root, 'sample.json'), 'utf8')) === originalSource).toBe(true);
    try {
      const output = cardReport || join(directory, 'cards.txt');
      writePrivateOutput(output, report.join('\n\n---\n\n') + '\n', [realFeed || join(root, 'sample.json'), path], { replace: true });
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect((await readFile(output, 'utf8')) === report.join('\n\n---\n\n') + '\n').toBe(true);
    } catch {
      throw new Error('Private card report could not be written safely outside Git; details withheld.');
    }
    expect(requests).toBe(0);
    expect(errors).toBe(0);
    evidence.recordAssertionEvidence('Ten seeded cards satisfy the prose-first contract', `${realFeed ? 'Private actual feed' : 'Synthetic sample'}: ten cards including archive, merge and a concrete review question checked. Field order, readable prose, outcome adjacency, safe links, lock exclusion, disabled approval, three-line Guide and collapsed raw verified. No raw code in prose or outcomes; curated last-message/assistant excerpts remain literal and bounded to 800 characters. Zero HTTP requests or page errors. ${cardReport ? 'Rendered card text written only to the private report.' : 'No card text persisted.'}`, true);
  } finally {
    await context.close();
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('display prose is readable without changing source identity, evidence excerpts or export data', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-queue-display-'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ acceptDownloads: true });
  const sourceProse = {
    purpose: 'Explain `session.read` for ses_displaySelf while retaining INC-104 and session.readiness.',
    delivered: 'Sent via session.send to ses_displayOther; report docs/guide.md remains.',
    status_on_dev: 'Not merged: `gh pr checks 42` failed; `git worktree list` showed two copies.',
    why: 'session.archive is conditional; unknown session ses_unknownFixture is not authorization.',
    if_approved: 'The audit archives session ses_displaySelf only after checks pass; never auto-run.',
    if_declined: 'Keep OpenWork Chat session ses_displaySelf untouched; do not run `gh pr merge 42`.',
    question: 'Use `git worktree add` or `session.search/read` before contacting ses_displayOther?',
  };
  const expected: Record<string, string> = {
    purpose: 'Explain session details for this session while retaining INC-104 and session.readiness.',
    delivered: 'Sent via session messaging to “Related synthetic task”; report docs/guide.md remains.',
    status_on_dev: 'Not merged: pull-request checks 42 failed; list working copies showed two copies.',
    why: 'session archiving is conditional; unknown related session is not authorization.',
    if_approved: 'The audit archives this session only after checks pass; never auto-run.',
    if_declined: 'Keep this OpenWork Chat session untouched; do not run merge pull request 42.',
    question: 'Use create working copy or session search and details before contacting “Related synthetic task”?',
  };
  const excerpt = 'Literal session.send to ses_displayOther: `<script>quoted only</script>` ' + 'context '.repeat(120);
  const input = validateFeed({ items: [
    { ...baseItem, ...sourceProse, id: 'ses_displaySelf', kind: 'session', title: 'Synthetic normalization task', evidence: [{ label: 'Last assistant', value: excerpt }] },
    { ...baseItem, id: 'ses_displayOther', kind: 'session', title: 'Related synthetic task', recommended_action: 'keep' },
  ], decisions: [] });
  const requests: string[] = [];
  page.on('request', (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  try {
    const path = join(directory, 'index.html');
    await writeFile(path, buildHtml(input, await readFile(join(root, 'template.html'), 'utf8'), await readFile(join(root, 'core.mjs'), 'utf8'), await readFile(join(root, 'ui.js'), 'utf8')));
    await page.goto(pathToFileURL(path).href);
    await page.locator('#status').selectOption('');
    for (const [name, value] of Object.entries(sourceProse)) {
      const field = page.locator(`#detail [data-field="${name}"]${name.startsWith('if_') ? '' : ' > p.summary'}`);
      expect(await field.textContent()).toBe(name === 'if_approved' ? 'archive this session' : name === 'if_declined' ? 'leave this session open' : expected[name]);
      expect(expectedProse(value, input.items[0], input.items)).toBe(expected[name]);
      expect(await page.locator(`[data-prose-source="${name}"]`).textContent()).toBe(value);
      expect(await page.locator(`[data-prose-source="${name}"]`).isVisible()).toBe(false);
    }
    expect(await page.locator('[data-id="ses_displaySelf"] .row-summary').textContent()).toBe(expected.purpose);
    expect(await page.locator('#detail [data-field="evidence"] .evidence-value').allTextContents()).toContain(`${excerpt.slice(0, 799)}…`);
    expect(await page.locator('#detail script, #detail iframe').count()).toBe(0);
    expect(await page.locator('#detail > [data-field]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-field')))).toEqual(['purpose', 'status_on_dev', 'delivered', 'why', 'question', 'decision', 'evidence', 'raw_evidence']);
    expect(validateFeed((await exportJson(page)).data)).toEqual(input);
    await page.locator('#detail [data-action="approve"]').click();
    const approved = validateFeed((await exportJson(page)).data);
    expect(approved.items).toEqual(input.items);
    expect(approved.decisions.map((entry) => entry.id)).toEqual(['ses_displaySelf']);
    expect(requests).toEqual([]);
    evidence.recordAssertionEvidence('Display normalization preserves meaning and immutable source', 'Seven prose/outcome fields have exact independently specified readable text: self/known/unknown session references, tool names and command phrases are normalized while issue identifiers, report paths, conditional wording and unrelated API names remain. Raw prose and exported items retain exact originals; last-assistant code is a literal bounded excerpt. Field order, action identity and zero network traffic verified.', true);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('short actions have one collapsed safety footer and evidence distinguishes non-code from unverified PRs', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-queue-presentation-'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const placeholders = ['PR checks', 'Diff stat', 'Spec results', 'Warden', 'Conflicts'].map((label) => ({ label, value: 'Unknown — not supplied' }));
  const input = validateFeed({ items: [
    { ...baseItem, id: 'ses_note', kind: 'session', title: 'Synthetic Notion note', purpose: 'Retain the Notion page.', status_on_dev: 'No runtime change.', if_approved: 'Archive this session only after LIVE ownership, permissions, workspace identity, running work and clean-worktree checks pass; otherwise leave unchanged.', evidence: [...placeholders, { label: 'Last message', value: '2026-09-16 09:30 EDT' }, { label: 'Last assistant', value: 'Literal session.send example retained.' }] },
    { ...baseItem, id: 'pr-unknown', kind: 'pr', title: 'Unverified synthetic PR', recommended_action: 'merge', evidence: placeholders },
    { ...baseItem, id: 'ses_revise', kind: 'session', title: 'Specific revision', recommended_action: 'review', if_approved: 'Ask the owner to revise the example only after fresh authorization; otherwise retain the old text.' },
    { ...baseItem, id: 'ses_retry', kind: 'session', title: 'Specific relaunch', recommended_action: 'relaunch', if_approved: 'Relaunch the failed synthetic run only after checking its current state.' },
  ], decisions: [] });
  try {
    const path = join(directory, 'index.html');
    await writeFile(path, buildHtml(input, await readFile(join(root, 'template.html'), 'utf8'), await readFile(join(root, 'core.mjs'), 'utf8'), await readFile(join(root, 'ui.js'), 'utf8')));
    await page.goto(pathToFileURL(path).href);
    await page.locator('#status').selectOption('');
    await page.locator('[data-id="ses_note"] .row-open').click();
    expect(await page.locator('[data-field="if_approved"]').textContent()).toBe('archive this session');
    expect(await page.locator('[data-field="if_declined"]').textContent()).toBe('leave this session open');
    for (const field of ['if_approved', 'if_declined']) {
      expect(await page.locator(`[data-field="${field}"]`).evaluate((node) => node.getBoundingClientRect().height < 30 && getComputedStyle(node).whiteSpace === 'nowrap')).toBe(true);
    }
    expect(await page.getByTestId('safety-gates').count()).toBe(1);
    expect(await page.getByTestId('safety-gates').getAttribute('open')).toBeNull();
    expect(await page.getByTestId('safety-gates').locator('p').isVisible()).toBe(false);
    expect(await page.locator('#detail').innerText()).not.toContain('clean-worktree checks');
    expect(await page.locator('[data-prose-source="if_approved"]').textContent()).toBe(input.items[0].if_approved);
    const checks = page.locator('[data-field="evidence"]');
    expect(await checks.locator('.evidence-label').allTextContents()).toEqual(['Last message', 'Last assistant']);
    expect(await checks.innerText()).toContain('No code checks apply to this item');
    expect(await checks.innerText()).toContain('2026-09-16 09:30 EDT');
    expect(await checks.innerText()).toContain('Literal session.send example retained.');
    expect(await checks.innerText()).not.toContain('Unknown');
    await page.getByTestId('safety-gates').locator('summary').click();
    expect(await page.getByTestId('safety-gates').locator('p').isVisible()).toBe(true);
    expect(await page.getByTestId('safety-gates').textContent()).toContain('Never automatically archive OpenWork Chat');
    await page.locator('[data-id="pr-unknown"] .row-open').click();
    expect(await page.locator('[data-field="if_approved"]').textContent()).toBe('merge this PR');
    expect(await checks.innerText()).toContain('Code checks not supplied — recheck before approving');
    expect(await checks.innerText()).not.toContain('No code checks apply');
    expect(await checks.locator('.evidence').count()).toBe(0);
    expect(await page.getByTestId('safety-gates').textContent()).toContain('exact head and base');
    for (const [id, action] of [['ses_revise', 'Ask the owner to revise the example'], ['ses_retry', 'Relaunch the failed synthetic run']]) {
      await page.locator(`[data-id="${id}"] .row-open`).click();
      expect(await page.locator('[data-field="if_approved"]').textContent()).toBe(action);
      expect(await page.getByTestId('safety-gates').getAttribute('open')).toBeNull();
    }
    expect(validateFeed((await exportJson(page)).data)).toEqual(input);
    evidence.recordAssertionEvidence('Concise actions, collapsed gates and applicable evidence', 'Archive and decline outcomes occupy one short line; full outcomes remain in collapsed raw originals. Exactly one collapsed kind-specific safety footer is expandable. Non-code Notion notes omit five unknown code rows while preserving a dated last message and literal assistant quote. Missing PR checks produce an explicit recheck warning, never a no-checks claim. Review and relaunch retain their specific source actions; exports are unchanged.', true);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('approval guards cover keyboard, batch and restore while focused controls cannot act on another card', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-queue-guards-'));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('dialog', (dialog) => dialog.accept());
  try {
    const input = validateFeed(JSON.parse(await readFile(join(root, 'sample.json'), 'utf8')));
    const path = join(directory, 'index.html');
    await writeFile(path, buildHtml(input, await readFile(join(root, 'template.html'), 'utf8'), await readFile(join(root, 'core.mjs'), 'utf8'), await readFile(join(root, 'ui.js'), 'utf8')));
    await page.goto(pathToFileURL(path).href);
    await page.locator('#status').selectOption('');
    await page.locator('[data-id="proposal-no-outcome"] .row-open').click();
    expect(await page.locator('[data-action="approve"]').isDisabled()).toBe(true);
    await page.locator('#detail').focus();
    await page.keyboard.press('a');
    expect(await page.locator('#message').textContent()).toContain('if_approved');
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(0);
    await page.locator('[data-id="proposal-no-outcome"] input').check();
    expect(await page.locator('[data-id="proposal-no-outcome"] input').evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press('a');
    expect(await page.locator('#bulk-apply').isDisabled()).toBe(true);
    await page.locator('#bulk-action').selectOption('decline');
    expect(await page.locator('#bulk-apply').isDisabled()).toBe(false);
    await page.locator('#bulk-apply').click();
    await page.keyboard.press('a');
    expect(await page.locator('#confirm-dialog').getAttribute('open')).not.toBeNull();
    await page.locator('#cancel-bulk').click();
    expect(await page.locator('#bulk-apply').evaluate((node) => node === document.activeElement)).toBe(true);
    await page.locator('#clear-selection').click();
    const invalid = { ...input, decisions: [{ id: 'proposal-no-outcome', action: 'approve', comment: '', batch_id: 'forged', decided_at: new Date().toISOString() }] };
    for (const control of ['#import-decisions', '#import-feed']) {
      await page.locator(control).setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
      await expect.poll(async () => page.locator('#message').textContent()).toContain('if_approved');
      expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(0);
    }
    await page.locator('[data-id="ses_exampleA"] .row-open').click();
    expect(await page.locator('[data-id="ses_exampleA"] .row-open').evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press('a');
    await page.keyboard.press('j');
    expect(await page.getByTestId('detail-title').textContent()).toBe('Completed documentation explanation');
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(0);
    await page.locator('#detail').focus();
    await page.keyboard.press('j');
    expect(await page.locator('#detail').evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await page.getByTestId('detail-title').textContent()).toBe('Completed reference lookup');
    await page.keyboard.press('c');
    await page.getByTestId('comment').fill('Literal a d j k text');
    await page.keyboard.press('a');
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(0);
    await page.locator('#detail .raw-evidence > summary').focus();
    await page.keyboard.press('a');
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(0);
    const original = (await exportJson(page)).data;
    for (const field of ['purpose', 'delivered', 'status_on_dev', 'why', 'if_approved', 'if_declined', 'question', 'raw_evidence']) {
      const changed = { ...original, items: original.items.map((item: ReturnType<typeof validateFeed>['items'][number], index: number) => index ? item : { ...item, [field]: field === 'raw_evidence' ? [{ label: 'Changed', value: 'new source' }] : 'Changed prose' }) };
      await page.locator('#import-decisions').setInputFiles({ name: 'changed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(changed)) });
      await expect.poll(async () => page.locator('#message').textContent()).toContain('exact same items');
    }
    for (const id of ['worktree-example', 'ses_externalExample', 'ses_nightExample', 'pr-example-none']) {
      await page.locator(`[data-id="${id}"] .row-open`).click();
      expect(await page.locator('#detail [data-action],#comment').count()).toBe(0);
      await page.locator('#detail').focus();
      await page.keyboard.press('a');
      await page.keyboard.press('d');
      await page.keyboard.press('Space');
      expect(await page.locator('#bulk').isVisible()).toBe(false);
    }
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(0);
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) => name.startsWith('review-queue-v1-'));
      if (!key) throw new Error('Missing synthetic storage key');
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      saved.drafts = { 'ses_nightExample': 'Forbidden stored draft' };
      localStorage.setItem(key, JSON.stringify(saved));
    });
    await page.reload();
    await page.locator('#status').selectOption('');
    expect(await page.locator('#message').textContent()).toContain('Locked item cannot have a draft');
    expect(await page.locator('#comment').inputValue()).toBe('');
    expect(validateFeed((await exportJson(page)).data).decisions).toHaveLength(0);
    evidence.recordAssertionEvidence('Approval and focus guards hold across every UI entry point', 'No-outcome approval rejected via keyboard, bulk, feed and decision imports. Button/summary/text focus and modal shortcuts cannot decide or navigate another card. All four read-only categories reject shortcuts. Changed prose/raw snapshots and locked saved drafts cannot restore authority; no decisions were added.', true);
  } finally {
    await context.close();
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconciled night feed shows coverage and read-only history with scoped reversible decisions', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-queue-night-'));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  let networkRequests = 0;
  let pageErrors = 0;
  context.on('request', (request) => { if (/^https?:/.test(request.url())) networkRequests++; });
  page.on('pageerror', () => pageErrors++);
  page.on('dialog', (dialog) => dialog.accept());
  try {
    const synthetic = validateFeed({
      schema_version: 1, status: 'final-with-caveats', as_of: '2026-01-01T00:00:00Z',
      coverage: { known_session_items: 3, unknown_new_root_count: null, caveat: 'Synthetic coverage <script>untrusted</script>' },
      actions_taken: [{ id: 'history-example', kind: 'session', target_id: 'ses_old', action: 'relaunch', status: 'incomplete', summary: '<script>history is data</script>' }],
      items: [
        ...Array.from({ length: 3 }, (_, i) => ({ ...baseItem, id: `ses_night${i}`, kind: 'session', title: `Synthetic ${i}`, recommended_action: 'review_archive_eligibility' })),
        { ...baseItem, id: '/example/tree', kind: 'worktree', title: 'Read only tree', recommended_action: 'review_worktree_removal' },
        ...['review_merge_candidate', 'review_blockers', 'review_decision', 'review_repeatability_followup', 'none'].map((action, i) => ({ ...baseItem, id: `pr-${i + 1}`, kind: 'pr', title: `Synthetic PR ${i}`, recommended_action: action })),
      ], decisions: [],
    });
    const html = realPage ? await readFile(realPage, 'utf8') : buildHtml(synthetic, await readFile(join(root, 'template.html'), 'utf8'), await readFile(join(root, 'core.mjs'), 'utf8'), await readFile(join(root, 'ui.js'), 'utf8'));
    const embedded = html.match(/id="queue-feed">([\s\S]*?)<\/script>/)?.[1];
    if (!embedded) throw new Error('Missing embedded queue feed');
    const input = validateFeed(JSON.parse(embedded));
    const path = realPage || join(directory, 'index.html');
    if (!realPage) await writeFile(path, html);
    await page.goto(pathToFileURL(path).href);
    await page.locator('#status').selectOption('');
    const counts: Record<string, number> = {};
    for (const item of input.items) counts[recommendationVerb(item)] = (counts[recommendationVerb(item)] ?? 0) + 1;
    expect(await page.getByTestId('queue-row').count()).toBe(input.items.length);
    for (const [verb, count] of Object.entries(counts)) {
      expect(input.items.filter((item) => recommendationVerb(item) === verb).length).toBe(count);
      expect(await page.locator(`[data-testid="queue-row"][data-verb="${verb}"]`).count()).toBe(count);
      await page.locator('#recommendation').selectOption(verb);
      expect(await page.getByTestId('queue-row').count()).toBe(count);
      await page.locator('#recommendation').selectOption('');
    }
    await page.locator('#recommendation').selectOption('');
    expect(await page.locator('#coverage').isVisible()).toBe(true);
    expect((await page.locator('#coverage').textContent())?.includes('unknown new root count: unknown (not reconciled)')).toBe(true);
    expect(await page.locator('#done-overnight .overnight-entry').count()).toBe(input.actions_taken?.length ?? 0);
    expect(await page.locator('#done-overnight button, #done-overnight input, #done-overnight textarea, #done-overnight script, #coverage script').count()).toBe(0);
    expect(await page.locator('[data-verb="worktree"] input').count()).toBe(0);
    await page.locator('[data-verb="worktree"] .row-open').first().click();
    expect(await page.locator('#detail [data-action]').count()).toBe(0);
    expect((await page.locator('#detail .recommendation-source').textContent())?.includes('review_worktree_removal')).toBe(true);
    expect(await page.locator('[data-verb="archive"] .recommendation-source').count()).toBe(0);
    expect(await page.locator('#detail .raw-evidence').getAttribute('open')).toBeNull();
    const selectable = input.items.filter((item) => canApprove(item) && recommendationVerb(item) === 'archive');
    const first = selectable[0];
    if (!first) throw new Error('No selectable archive group');
    const selected = selectable.filter((item) => item.kind === first.kind && item.group === first.group && item.recommended_action === first.recommended_action).slice(0, 3);
    expect(selected.length).toBe(3);
    for (const item of selected) await page.locator(`[data-id="${item.id}"] input`).check();
    await page.getByTestId('bulk-approve').click();
    expect(await page.locator('#batch-preview li').count()).toBe(3);
    await page.getByTestId('confirm-bulk').click();
    const exported = validateFeed((await exportJson(page)).data);
    expect(exported.decisions.length).toBe(3);
    expect(exported.decisions.every((entry) => entry.action === 'approve' && selected.some((item) => item.id === entry.id))).toBe(true);
    expect(new Set(exported.decisions.map((entry) => entry.batch_id)).size).toBe(1);
    expect(JSON.stringify(exported.items) === JSON.stringify(input.items)).toBe(true);
    expect(JSON.stringify(exported.actions_taken) === JSON.stringify(input.actions_taken)).toBe(true);
    expect(JSON.stringify(exported.coverage) === JSON.stringify(input.coverage)).toBe(true);
    for (const changed of [
      { ...exported, coverage: { ...exported.coverage, unknown_new_root_count: 0 } },
      { ...exported, actions_taken: [] },
    ]) {
      await page.locator('#import-decisions').setInputFiles({ name: 'changed-provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(changed)) });
      await expect.poll(async () => (await page.locator('#message').textContent())?.includes('including provenance and overnight history')).toBe(true);
      expect(validateFeed((await exportJson(page)).data).decisions.length).toBe(3);
    }
    await page.getByTestId('undo').click();
    const undone = validateFeed((await exportJson(page)).data);
    expect(undone.decisions.length).toBe(0);
    expect(JSON.stringify(undone) === JSON.stringify(input)).toBe(true);
    expect(await page.locator('script[src], link[href], img[src], iframe[src], source[src], video[src], audio[src]').count()).toBe(0);
    expect(/@import|url\s*\(/i.test(html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '')).toBe(false);
    expect(networkRequests).toBe(0);
    expect(pageErrors).toBe(0);
    evidence.recordAssertionEvidence('Reconciled source history, mapped counts and reversible approval', `${realPage ? 'Private real page' : 'Synthetic page'}: ${input.items.length} items. Verb counts: ${JSON.stringify(counts)}. Unknown roots visibly remain unknown; worktrees and overnight history have no decision controls. Source recommendations are collapsed, all filters, exactly 3 same-batch approvals, export and complete undo verified. Original items/coverage/history retained. Zero external resource references, HTTP(S) requests or page errors. No private content captured.`, true);
  } finally {
    await context.close();
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
