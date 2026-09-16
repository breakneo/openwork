import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { buildHtml } from '../../tools/review-queue/build.mjs';
import { validateFeed, isLocked, recommendationVerb } from '../../tools/review-queue/core.mjs';

const realPage = process.env.REVIEW_QUEUE_PAGE;
const root = fileURLToPath(new URL('../../tools/review-queue/', import.meta.url));
const baseItem = {
  summary: 'Synthetic evidence only. No real account, customer or private session.',
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
    expect(await page.getByTestId('queue-row').count()).toBe(216);
    expect(await page.getByTestId('item-select').count()).toBe(214);
    expect(await page.locator('.locked-heading').textContent()).toContain('not yours to act on');
    expect(await page.locator('#metrics').textContent()).toContain('2 not yours to act on');
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
    await page.locator('#detail [data-action="ask_info"]').click();
    const followup = validateFeed((await exportJson(page)).data);
    expect(followup.decisions.at(-1)?.action).toBe('ask_info');
    expect(followup.decisions.at(-1)?.comment).toContain('<script>literal</script>');
    expect(await page.locator('#agent-plan').inputValue()).toContain('session.send');
    expect(await page.locator('#detail script').count()).toBe(0);
    await page.locator('#detail [data-action="comment"]').click();
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
    const counts = realPage ? { merge: 3, archive: 36, worktree: 71, review: 61, relaunch: 1, none: 117 } : { merge: 1, archive: 3, worktree: 1, review: 2, relaunch: 1, none: 1 };
    expect(await page.getByTestId('queue-row').count()).toBe(realPage ? 289 : 9);
    for (const [verb, count] of Object.entries(counts)) {
      expect(input.items.filter((item) => recommendationVerb(item) === verb).length).toBe(count);
      expect(await page.locator(`[data-testid="queue-row"][data-verb="${verb}"]`).count()).toBe(count);
      await page.locator('#recommendation').selectOption(verb);
      expect(await page.getByTestId('queue-row').count()).toBe(count);
      await page.locator('#recommendation').selectOption('');
    }
    await page.locator('#recommendation').selectOption('');
    if (realPage) {
      for (const [kind, count] of [['session', 84], ['pr', 134], ['worktree', 71]]) expect(input.items.filter((item) => item.kind === kind).length).toBe(count);
    }
    expect(await page.locator('#coverage').isVisible()).toBe(true);
    expect((await page.locator('#coverage').textContent())?.includes('unknown new root count: unknown (not reconciled)')).toBe(true);
    expect(await page.locator('#done-overnight .overnight-entry').count()).toBe(realPage ? 5 : 1);
    expect(await page.locator('#done-overnight button, #done-overnight input, #done-overnight textarea, #done-overnight script, #coverage script').count()).toBe(0);
    expect(await page.locator('[data-verb="worktree"] input').count()).toBe(0);
    await page.locator('[data-verb="worktree"] .row-open').first().click();
    expect(await page.locator('#detail [data-action]').count()).toBe(0);
    expect((await page.locator('#detail .recommendation-source').textContent())?.includes('review_worktree_removal')).toBe(true);
    expect(await page.locator('[data-verb="archive"] .recommendation-source').count()).toBe(counts.archive);
    const selectable = input.items.filter((item) => !isLocked(item) && recommendationVerb(item) === 'archive');
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
    evidence.recordAssertionEvidence('Reconciled source history, mapped counts and reversible approval', `${realPage ? 'Private real page: 289 items (84 sessions / 134 PRs / 71 worktrees), 5 history entries' : 'Synthetic page: 9 items, 1 history entry'}. Verb counts: ${JSON.stringify(counts)}. Unknown roots visibly remain unknown; worktrees and overnight history have no decision controls. Original recommendation sublabels, all six filters, exactly 3 same-batch approvals, export and complete undo verified. Original items/coverage/history retained. Zero external resource references, HTTP(S) requests or page errors. No private content captured.`, true);
  } finally {
    await context.close();
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
