import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { startServer } from '../../tools/review-queue/serve.mjs';
import { next, result } from '../../tools/review-queue/executor.mjs';
import { readLog } from '../../tools/review-queue/protocol.mjs';
import { validateFeed } from '../../tools/review-queue/core.mjs';
import { buildHtml } from '../../tools/review-queue/build.mjs';

test('live review posts explicit decisions, polls correlated threads and keeps private data behind the token', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-live-browser-'));
  const feedPath = join(directory, 'feed.json');
  const base = { kind: 'session', group: 'openwork', purpose: 'Finish a synthetic explanation.', delivered: 'Synthetic report.', status_on_dev: 'Documentation only.', why: 'The explanation is complete.', if_approved: 'Recheck this synthetic session before archiving.', if_declined: 'Keep it unchanged.', protected: false, workspace_id: 'ws_fixture', evidence: [{ label: 'PR checks', value: 'build: SUCCESS\ntests: SUCCESS' }, { label: 'Diff stat', value: '2 files, +12 -4' }, { label: 'Spec results', value: '7 passed; 0 skipped' }, { label: 'Warden', value: 'Passed' }, { label: 'Conflicts', value: 'None observed' }, { label: 'Last assistant', value: 'Synthetic conclusion. <script>literal</script>' }] };
  await writeFile(feedPath, JSON.stringify({ items: [
    ...Array.from({ length: 3 }, (_, i) => ({ ...base, id: `ses_archive${i}`, title: `Archive fixture ${i}`, recommended_action: 'archive' })),
    { ...base, id: 'ses_review', title: 'Synthetic human question', recommended_action: 'review', question: 'Should we change the example?', if_approved: 'Ask the owner to revise the synthetic example.' },
    { ...base, id: 'ses_declined', title: 'Previously declined archive', recommended_action: 'archive' },
    { ...base, id: 'ses_reference', title: 'Private reference fixture', recommended_action: 'none' },
    { ...base, id: 'ses_external', title: 'External fixture', group: 'external-mission', recommended_action: 'review', question: 'Untouchable?' },
  ], decisions: [{ id: 'ses_declined', action: 'decline', comment: 'Keep it.', batch_id: 'prior-decline', decided_at: '2026-01-01T00:00:00.000Z' }] }), { mode: 0o600 });
  const live = await startServer({ feed: feedPath, dir: join(directory, 'queue') });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('dialog', (dialog) => dialog.accept());
  const errors: string[] = [];
  const outside: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (new URL(request.url()).origin !== live.origin) outside.push(request.url()); });
  try {
    await page.goto(live.origin);
    expect(await page.locator('#mode-badge').textContent()).not.toContain('LIVE');
    expect(await page.getByText('Private reference fixture').count()).toBe(0);
    expect(await page.getByTestId('queue-row').count()).toBe(0);
    await page.goto(live.url);
    await expect.poll(() => page.locator('#mode-badge').textContent()).toContain('LIVE');
    expect(await page.locator('#status').inputValue()).toBe('human');
    expect(await page.getByTestId('queue-row').count()).toBe(1);
    expect(await page.getByTestId('archive-batch').textContent()).toContain('Archive 3 concluded sessions');
    expect(await page.getByTestId('archive-batch').textContent()).not.toContain('Previously declined archive');
    await page.getByTestId('archive-batch').locator('summary').click();
    expect(await page.getByText('Private reference fixture').count()).toBe(0);
    expect(await page.locator('#undo').isDisabled()).toBe(true);
    await page.locator('[data-id="ses_review"] .row-open').click();
    expect(await page.locator('#detail > [data-field]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-field')))).toEqual(['purpose', 'status_on_dev', 'delivered', 'why', 'question', 'decision', 'evidence', 'raw_evidence', 'thread']);
    for (const label of ['PR checks', 'Diff stat', 'Spec results', 'Warden', 'Conflicts', 'Last assistant']) {
      expect(await page.locator('#detail [data-field="evidence"]').getByText(label, { exact: true }).count()).toBe(1);
    }
    expect(await page.locator('#detail [data-field="evidence"] table').count()).toBe(1);
    expect(await page.locator('#detail script').count()).toBe(0);
    await page.locator('#detail [data-action="approve"]').click();
    await expect.poll(() => page.getByTestId('action-log').textContent()).toContain('queued');
    await page.locator('#status').selectOption('decided');
    await page.locator('[data-id="ses_review"] .row-open').click();
    await expect.poll(() => page.getByTestId('thread-events').textContent()).toContain('Queued');
    const work = next(live.directory);
    expect(work?.action).toBe('approve');
    expect(work?.item_ids).toEqual(['ses_review']);
    await page.locator('#comment').fill('Preserve editor on result changes');
    await page.locator('#comment').focus();
    const editor = await page.locator('#comment').elementHandle();
    result(work.id, 'blocked', 'Synthetic recheck needs owner evidence.', live.directory);
    await expect.poll(() => page.getByTestId('thread-events').textContent(), { timeout: 10000 }).toContain('Blocked: Synthetic recheck needs owner evidence.');
    expect(await page.locator('[data-id="ses_review"] .row-meta').textContent()).toContain('blocked: Synthetic recheck');
    expect(await editor?.evaluate((node) => node.isConnected && node === document.activeElement)).toBe(true);
    expect(await page.locator('#comment').inputValue()).toBe('Preserve editor on result changes');
    await page.locator('#comment').fill('Please explain <script>literal</script>');
    await page.getByTestId('thread-send').click();
    await expect.poll(() => page.getByTestId('thread-events').textContent()).toContain('Please explain <script>literal</script>');
    const followup = next(live.directory);
    expect(followup?.action).toBe('message');
    await page.locator('#comment').fill('Keep this draft while polling');
    await page.locator('#comment').focus();
    result(followup.id, 'reply', 'Owner confirms: synthetic only.', live.directory);
    await expect.poll(() => page.getByTestId('thread-events').textContent(), { timeout: 10000 }).toContain('Reply from owner: Owner confirms: synthetic only.');
    expect(await page.locator('#comment').inputValue()).toBe('Keep this draft while polling');
    expect(await page.locator('#comment').evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await page.locator('[data-event-id]').count()).toBe(6);
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(2);
    expect(await page.locator('#detail script').count()).toBe(0);
    await page.reload();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toContain('LIVE');
    await page.locator('[data-id="ses_review"] .row-open').click();
    await expect.poll(() => page.getByTestId('thread-events').textContent()).toContain('Owner confirms: synthetic only.');
    expect(next(live.directory)).toBeNull();
    expect(await page.locator('#comment').inputValue()).toBe('Keep this draft while polling');
    expect(await page.locator('#decision-history .history').count()).toBe(2);
    for (const id of ['undo', 'import-feed', 'import-decisions']) expect(await page.locator(`#${id}`).isDisabled()).toBe(true);
    await page.getByTestId('archive-batch').getByRole('button', { name: 'Review archive batch' }).click();
    expect(await page.locator('#batch-preview li').allTextContents()).toEqual([0, 1, 2].map((i) => `Archive fixture ${i} — ses_archive${i}`));
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(2);
    await page.locator('#cancel-bulk').click();
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(2);
    await page.getByTestId('archive-batch').getByRole('button', { name: 'Review archive batch' }).click();
    await page.getByTestId('confirm-bulk').click();
    await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(3);
    const batch = next(live.directory);
    expect(batch.item_ids).toEqual(['ses_archive0', 'ses_archive1', 'ses_archive2']);
    expect(batch.decisions.every((entry: { batch_id: string }) => entry.batch_id === batch.id)).toBe(true);
    result(batch.id, 'archived', 'Synthetic sessions archived.', live.directory);
    expect(await page.getByTestId('archive-batch').count()).toBe(0);
    await page.locator('#status').selectOption('');
    await page.locator('[data-id="ses_archive0"] .row-open').click();
    await expect.poll(() => page.getByTestId('thread-events').textContent(), { timeout: 10000 }).toMatch(/Done · archived \d{2}:\d{2}/);
    await page.locator('[data-action="approve"]').click();
    expect(await page.locator('#message').textContent()).toContain('Archive approval unavailable');
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(3);
    for (const format of ['json', 'markdown']) {
      const waiting = page.waitForEvent('download');
      await page.locator(`#export-${format}`).click();
      const download = await waiting;
      const path = await download.path();
      if (!path) throw new Error('Missing audit download');
      const text = await readFile(path, 'utf8');
      expect(text).toContain('may already have executed');
      expect(text).toContain('Do not replay');
      expect(text).not.toMatch(/never executed|nothing (?:has been|was) executed|gh pr merge|session\.archive/i);
      if (format === 'json') {
        const audit = JSON.parse(text);
        expect(audit.mode).toBe('live-audit-only');
        expect(audit.events.some((event: { status: string; decision_id: string }) => event.status === 'archived' && event.decision_id === batch.id)).toBe(true);
        expect(audit.decisions).toHaveLength(6);
        expect(audit.original_feed.items).toHaveLength(7);
        expect(audit.local_pending).toEqual([]);
        expect(() => validateFeed(audit)).toThrow();
      }
    }
    await page.locator('#status').selectOption('human');
    expect(await page.locator('[data-id="ses_archive0"]').count()).toBe(0);
    expect(await page.getByTestId('archive-batch').count()).toBe(0);
    const stopResponse = await fetch(live.origin + '/threads/ses_review', { method: 'POST', headers: { Origin: live.origin, 'X-Review-Token': live.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), text: 'stop' }) });
    expect(stopResponse.status).toBe(200);
    await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(4);
    const stop = next(live.directory);
    expect(stop.action).toBe('stop');
    result(stop.id, 'stopped', 'Queue paused by human.', live.directory);
    await expect.poll(() => page.getByTestId('thread-events').textContent(), { timeout: 10000 }).toContain('Stopped');
    expect(next(live.directory)).toBeNull();
    await page.locator('#status').selectOption('');
    await page.locator('[data-id="ses_external"] .row-open').click();
    expect(await page.locator('#detail textarea, #detail [data-action], #detail [data-testid="thread-send"]').count()).toBe(0);
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
    evidence.recordAssertionEvidence('Live token bootstrap, explicit posting, local persistence and owner threads', 'Synthetic Chromium: unauthenticated shell reveals no feed; LIVE badge follows authenticated metadata/feed; needs-human default shows one question plus one three-session batch; evidence table rendered safely; one approval and one follow-up produce claimed correlated results, survive reload and never replay. No outbound requests or page errors.', true);
  } finally {
    await context.close();
    await browser.close();
    await new Promise<void>((resolve, reject) => { live.server.close((error) => error ? reject(error) : resolve()); live.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('uncertain delivery stays local, disables writes and never replays on poll or reload', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-live-drop-'));
  const feedPath = join(directory, 'feed.json');
  const source = { items: [{ id: 'ses_drop', kind: 'session', title: 'Synthetic drop test', recommended_action: 'review', question: 'Keep the synthetic result?', if_approved: 'Recheck with owner.' }], decisions: [] };
  await writeFile(feedPath, JSON.stringify(source));
  const live = await startServer({ feed: feedPath, dir: join(directory, 'queue') });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  const posts: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST') posts.push(request.url()); });
  try {
    await page.goto(live.url);
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    let releaseReceipt: () => void = () => {};
    const receiptGate = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    await page.route('**/decisions', async (route) => {
      await route.fetch();
      await receiptGate;
      await route.abort('connectionfailed');
    });
    await page.locator('[data-action="approve"]').click();
    await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(1);
    expect(await page.locator('#decision-history .history').count()).toBe(1);
    expect(await page.locator('[data-action="decline"]').isDisabled()).toBe(true);
    expect(await page.getByTestId('thread-send').isDisabled()).toBe(true);
    await page.locator('#detail').focus();
    await page.keyboard.press('d');
    expect(posts).toHaveLength(1);
    const input = readLog(live.directory, 'decisions.jsonl')[0];
    expect(input.request.body.snapshot).toBe(JSON.stringify({ ...validateFeed(source), decisions: [] }));
    expect(input.request.body.id).toBe(input.event.decisions[0].batch_id);
    releaseReceipt();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('CONNECTION LOST');
    expect(await page.locator('#message').textContent()).toContain('local only / delivery uncertain');
    expect(await page.getByTestId('thread-events').textContent()).toContain('No automatic retry');
    for (const id of ['undo', 'import-feed', 'import-decisions']) expect(await page.locator(`#${id}`).isDisabled()).toBe(true);
    await page.waitForTimeout(3500);
    expect(posts).toHaveLength(1);
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(1);
    await page.unroute('**/decisions');
    await page.reload();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    await page.locator('#status').selectOption('decided');
    expect(await page.locator('#decision-history .history').count()).toBe(1);
    expect(await page.getByTestId('thread-events').textContent()).toContain('Queued');
    expect(posts).toHaveLength(1);
    const work = next(live.directory);
    expect(work.id).toBe(input.event.id);
    expect(next(live.directory)).toBeNull();
    await new Promise<void>((resolve, reject) => { live.server.close((error) => error ? reject(error) : resolve()); live.server.closeAllConnections(); });
    await expect.poll(() => page.locator('#mode-badge').textContent(), { timeout: 10000 }).toBe('CONNECTION LOST');
    expect(await page.locator('#undo').isDisabled()).toBe(true);
    expect(await page.locator('[data-action="approve"]').isDisabled()).toBe(true);
    expect(posts).toHaveLength(1);
    evidence.recordAssertionEvidence('Lost receipt and dropped connection never replay work', 'The server accepts exactly one request while its receipt is withheld. Local history is immediate and all writes serialize. Lost receipt disables imports, undo and new writes, explicitly reports uncertainty, and does not retry. Reload reads one server decision without posting; later server shutdown retains the live-session safety locks.', true);
  } finally {
    await context.close(); await browser.close();
    if (live.server.listening) await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('unconfirmed local audit and both draft types survive reload without becoming server decisions', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-live-recovery-'));
  const feedPath = join(directory, 'feed.json');
  await writeFile(feedPath, JSON.stringify({ items: [{ id: 'ses_recovery', kind: 'session', title: 'Recovery fixture', recommended_action: 'review', question: 'Retain this fixture?', if_approved: 'Ask owner to recheck.' }], decisions: [] }));
  const live = await startServer({ feed: feedPath, dir: join(directory, 'queue') });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  let posts = 0;
  page.on('request', (request) => { if (request.method() === 'POST') posts++; });
  try {
    await page.goto(live.url);
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    await page.locator('#comment').fill('Unsent decision draft');
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((entry) => entry.startsWith('review-queue-live-'));
      if (!key) throw new Error('Missing synthetic audit');
      const saved = JSON.parse(localStorage.getItem(key) || '{}'); saved.threadDrafts = { ses_recovery: 'Unsent owner draft' }; localStorage.setItem(key, JSON.stringify(saved));
    });
    expect(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
    })).toBe(true);
    await page.reload();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.locator('#comment').inputValue()).toBe('Unsent decision draft');
    expect(await page.getByText('Legacy owner draft retained, not sent: Unsent owner draft', { exact: true }).count()).toBe(1);
    expect(posts).toBe(0);
    await page.route('**/decisions', (route) => route.abort('connectionfailed'));
    await page.locator('[data-action="approve"]').click();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('CONNECTION LOST');
    expect(await page.getByTestId('thread-events').textContent()).toContain('LOCAL ONLY / UNCERTAIN');
    expect(readLog(live.directory, 'decisions.jsonl')).toEqual([]);
    const saved = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((entry) => entry.startsWith('review-queue-live-'));
      if (!key) throw new Error('No live audit key');
      return { key, value: localStorage.getItem(key) };
    });
    expect(JSON.parse(saved.value || '{}').localRequests).toHaveLength(1);
    await page.unroute('**/decisions');
    await page.reload();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    await page.locator('#status').selectOption('');
    expect(await page.getByText('Legacy owner draft retained, not sent: Unsent owner draft', { exact: true }).count()).toBe(1);
    expect(await page.getByTestId('thread-events').textContent()).toContain('LOCAL ONLY / UNCERTAIN');
    expect(await page.locator('#decision-history').textContent()).toContain('Unsent decision draft');
    await page.waitForTimeout(3500);
    expect(posts).toBe(1);
    expect(readLog(live.directory, 'decisions.jsonl')).toEqual([]);
    const waiting = page.waitForEvent('download');
    await page.locator('#export-json').click();
    const download = await waiting; const path = await download.path();
    if (!path) throw new Error('No local audit export');
    const audit = JSON.parse(await readFile(path, 'utf8'));
    expect(audit.decisions).toEqual([]);
    expect(audit.events).toEqual([]);
    expect(audit.local_pending).toHaveLength(1);
    expect(audit.local_pending[0].state).toContain('UNCERTAIN');
    expect(audit.local_pending[0].text).toBe('Unsent decision draft');
    expect(audit.thread_drafts.ses_recovery).toBe('Unsent owner draft');
    expect(() => validateFeed(audit)).toThrow();
    const corrupted = await page.evaluate((key) => {
      const record = JSON.parse(localStorage.getItem(key) || '{}');
      record.localRequests[0].item_ids = ['ses_unknown'];
      const value = JSON.stringify(record); localStorage.setItem(key, value); return value;
    }, saved.key);
    await page.reload();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.locator('#message').textContent()).toContain('existing record was not overwritten');
    expect(await page.evaluate((key) => localStorage.getItem(key), saved.key)).toBe(corrupted);
    expect(posts).toBe(1);
    expect(await page.getByTestId('thread-events').textContent()).not.toContain('Unsent decision draft');
    evidence.recordAssertionEvidence('Draft recovery and uncertain audit never authorize replay', 'Both unsent drafts restore with a dirty warning. An unreceived POST restores only a separate uncertain local audit, remains absent from server decisions and receipts, and exports with its owner draft without posting. Invalid saved request scope is rejected without overwriting the saved record.', true);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('a polling receipt wins over a later failed POST response without retrying', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-live-receipt-race-'));
  const feedPath = join(directory, 'feed.json');
  await writeFile(feedPath, JSON.stringify({ items: [{ id: 'ses_race', kind: 'session', title: 'Receipt race fixture', recommended_action: 'review', question: 'Retain this fixture?', if_approved: 'Ask owner to recheck.' }], decisions: [] }));
  const live = await startServer({ feed: feedPath, dir: join(directory, 'queue') });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let posts = 0;
  page.on('request', (request) => { if (request.method() === 'POST') posts++; });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await page.goto(live.url);
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    await page.route('**/decisions', async (route) => { await route.fetch(); await gate; await route.abort('connectionfailed'); });
    await page.locator('[data-action="approve"]').click();
    await expect.poll(() => page.getByTestId('action-log').textContent(), { timeout: 8000 }).toContain('queued');
    await page.locator('#status').selectOption('decided');
    expect(await page.locator('[data-action="decline"]').isDisabled()).toBe(true);
    release();
    await expect.poll(() => page.locator('#message').textContent()).toContain('confirmed by polling');
    expect(await page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.getByTestId('thread-events').textContent()).not.toContain('UNCERTAIN');
    expect(await page.locator('#decision-history .history').count()).toBe(1);
    await page.waitForTimeout(3500);
    expect(posts).toBe(1);
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(1);
    expect(await page.locator('#mode-badge').textContent()).toBe('LIVE');
    evidence.recordAssertionEvidence('Polling acknowledgement resolves the lost-response race', 'POST is accepted with its response withheld. Polling confirms the same request before the POST rejects; the UI retains one authoritative receipt, stays live, clears uncertainty and never retries.', true);
  } finally {
    release(); await browser.close();
    await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('file mode ignores connection fragments, keeps the human default and renders curated evidence safely', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-offline-default-'));
  const root = fileURLToPath(new URL('../../tools/review-queue/', import.meta.url));
  const source = { items: [
    { id: 'ses_archive', kind: 'session', title: 'Offline archive', group: 'openwork', recommended_action: 'archive', if_approved: 'Recheck archive.' },
    { id: 'ses_keep', kind: 'session', title: 'Offline keep', recommended_action: 'keep' },
    { id: 'ses_question', kind: 'session', title: 'Offline human question', recommended_action: 'review', question: 'Revise the example?', if_approved: 'Recheck with owner.', evidence: [
      { label: 'PR checks', value: JSON.stringify([{ name: 'build', conclusion: 'SUCCESS' }, { name: '<script>literal</script>', status: 'FAILURE' }]) },
      { label: 'Last assistant', value: 'A'.repeat(900) },
      { label: 'Arbitrary raw code', value: 'NEVER_DISPLAY_THIS_IN_CARD' },
    ] },
  ], decisions: [] };
  const path = join(directory, 'index.html');
  await writeFile(path, buildHtml(source, await readFile(join(root, 'template.html'), 'utf8'), await readFile(join(root, 'core.mjs'), 'utf8'), await readFile(join(root, 'ui.js'), 'utf8')));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  const network: string[] = [];
  page.on('request', (request) => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  try {
    await page.goto(`${pathToFileURL(path).href}#token=synthetic-token-that-must-never-connect`);
    expect(await page.locator('#status').inputValue()).toBe('human');
    expect(await page.locator('#mode-badge').textContent()).toBe('OFFLINE');
    expect(await page.getByTestId('queue-row').count()).toBe(1);
    expect(await page.getByTestId('archive-batch').count()).toBe(1);
    expect(await page.getByTestId('detail-title').textContent()).toBe('Offline human question');
    const card = page.locator('#detail [data-field="evidence"]');
    expect(await card.locator('table tr').allTextContents()).toEqual(['CheckResult', 'buildSUCCESS', '<script>literal</script>FAILURE']);
    expect((await card.locator('.evidence').filter({ has: page.getByText('Last assistant', { exact: true }) }).locator('.evidence-value').textContent())?.length).toBe(800);
    expect(await card.getByText('Unverified — not supplied').count()).toBe(0);
    expect(await card.locator('.evidence-label').allTextContents()).toEqual(['PR checks', 'Last assistant']);
    expect(await card.innerText()).not.toContain('NEVER_DISPLAY_THIS_IN_CARD');
    expect(await page.locator('#detail script').count()).toBe(0);
    expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toContain("connect-src 'none'");
    await page.locator('[data-action="approve"]').click();
    await page.reload();
    expect(await page.locator('#status').inputValue()).toBe('human');
    expect(await page.getByTestId('queue-row').count()).toBe(0);
    expect(await page.locator('#mode-badge').textContent()).toBe('OFFLINE');
    await page.locator('#status').selectOption('');
    await page.locator('[data-id="ses_question"] .row-open').click();
    expect(await page.locator('#decision-history .history').count()).toBe(1);
    expect(await page.getByTestId('queue-row').count()).toBe(3);
    expect(await page.getByTestId('archive-batch').count()).toBe(0);
    expect(await page.getByTestId('item-select').count()).toBe(3);
    expect(network).toEqual([]);
    evidence.recordAssertionEvidence('Offline default and curated evidence retain their safety boundaries', 'File mode with a token fragment makes zero network requests across approval and reload. Needs-human shows one question plus one archive batch, All items restores ordinary selection, and saved decisions remain offline. JSON check rows display success and failure as literal text, last assistant is bounded to 800 characters, missing placeholder rows are omitted without inventing passes, arbitrary raw labels stay collapsed, and offline CSP stays connect-src none.', true);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('human filtering follows terminal dispositions and surfaces blocked archive and keep results', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-live-dispositions-'));
  const feedPath = join(directory, 'feed.json');
  const base = { kind: 'session', group: 'openwork', recommended_action: 'archive', if_approved: 'Ask owner to recheck.' };
  await writeFile(feedPath, JSON.stringify({ items: [
    ...['fresh', 'declined', 'deferred', 'approved'].map((name) => ({ ...base, id: `ses_${name}`, title: name })),
    { ...base, id: 'ses_keep', title: 'Keep reference', recommended_action: 'keep' },
    ...['decline', 'defer'].map((name) => ({ ...base, id: `ses_review${name}`, title: `Review ${name}`, recommended_action: 'review', question: 'Retain this fixture?' })),
  ], decisions: ['decline', 'defer', 'approve'].map((action, index) => ({ id: ['ses_declined', 'ses_deferred', 'ses_approved'][index], action, comment: '', batch_id: `prior-${index}`, decided_at: '2026-01-01T00:00:00.000Z' })) }));
  const live = await startServer({ feed: feedPath, dir: join(directory, 'queue') });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  try {
    await page.goto(live.url);
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.getByTestId('archive-batch').textContent()).toContain('Archive 1 concluded sessions');
    expect(await page.getByTestId('queue-row').count()).toBe(2);
    await page.getByTestId('archive-batch').locator('summary').click();
    await page.getByTestId('archive-batch').getByRole('button', { name: 'fresh', exact: true }).click();
    await page.locator('[data-action="approve"]').click();
    await expect.poll(() => page.getByTestId('action-log').textContent()).toContain('queued');
    expect(await page.getByTestId('archive-batch').count()).toBe(0);
    const archive = next(live.directory);
    result(archive.id, 'blocked', 'Missing archive evidence', live.directory);
    await expect.poll(() => page.locator('[data-id="ses_fresh"] .row-meta').textContent(), { timeout: 8000 }).toContain('blocked: Missing archive evidence');
    expect(await page.getByTestId('archive-batch').count()).toBe(0);
    await page.locator('[data-id="ses_fresh"] .row-open').click();
    await page.locator('#comment').fill('Draft kept as the row disappears');
    await page.locator('#comment').focus();
    const editor = await page.locator('#comment').elementHandle();
    result(archive.id, 'archived', 'Archive complete', live.directory);
    await expect.poll(() => page.locator('[data-id="ses_fresh"]').count(), { timeout: 8000 }).toBe(0);
    expect(await editor?.evaluate((node) => node.isConnected && node === document.activeElement)).toBe(true);
    expect(await page.getByTestId('detail-title').textContent()).toBe('fresh');
    expect(await page.locator('#comment').inputValue()).toBe('Draft kept as the row disappears');
    expect(await page.getByTestId('archive-batch').count()).toBe(0);
    await page.locator('#status').selectOption('');
    await page.locator('[data-id="ses_keep"] .row-open').click();
    await page.locator('#comment').fill('Please inspect the kept reference');
    await page.getByTestId('thread-send').click();
    await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(2);
    const keep = next(live.directory);
    await page.locator('#status').selectOption('human');
    result(keep.id, 'blocked', 'Owner decision needed', live.directory);
    await expect.poll(() => page.locator('[data-id="ses_keep"] .row-meta').textContent(), { timeout: 8000 }).toContain('blocked: Owner decision needed');
    result(keep.id, 'waiting', 'Waiting for reviewer', live.directory);
    await expect.poll(() => page.locator('[data-id="ses_keep"] .row-meta').textContent(), { timeout: 8000 }).toContain('waiting: Waiting for reviewer');
    result(keep.id, 'done', 'Reference resolved', live.directory);
    await expect.poll(() => page.locator('[data-id="ses_keep"]').count(), { timeout: 8000 }).toBe(0);
    for (const action of ['decline', 'defer']) {
      await page.locator(`[data-id="ses_review${action}"] .row-open`).click();
      await page.locator(action === 'decline' ? '[data-action="decline"]' : '[data-local-action="later"]').click();
      await expect.poll(() => page.locator(`[data-id="ses_review${action}"]`).count()).toBe(0);
    }
    expect(await page.getByTestId('queue-row').count()).toBe(0);
    expect(await page.getByTestId('archive-batch').count()).toBe(0);
    const list = await page.locator('#list').elementHandle();
    const child = await page.locator('#list > :first-child').elementHandle();
    await page.waitForTimeout(3500);
    expect(await list?.evaluate((node) => node.isConnected)).toBe(true);
    expect(await child?.evaluate((node) => node.isConnected)).toBe(true);
    evidence.recordAssertionEvidence('Effective dispositions govern archive and human views', 'Prior declined, deferred and approved sessions never enter archive batching. An approved archive becomes a human row when blocked, then disappears when archived without replacing its focused draft editor. A keep recommendation appears for blocked/waiting results and disappears on done; local decline and defer hide their rows immediately. Unchanged polling preserves list nodes.', true);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('mixed archive shapes fail closed, bulk merge is forbidden and origin mismatch cannot fetch a feed', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-live-guards-'));
  const feedPath = join(directory, 'feed.json');
  const base = { kind: 'session', group: 'openwork', recommended_action: 'archive', if_approved: 'Recheck before archive.', protected: false };
  await writeFile(feedPath, JSON.stringify({ items: [
    { ...base, id: 'ses_one', title: 'First archive shape' },
    { ...base, id: 'ses_two', title: 'Second archive shape', recommended_action: 'review_archive_eligibility' },
    { ...base, id: 'ses_protected', title: 'Protected archive', protected: true },
    { ...base, id: 'ses_archived', title: 'Already archived', archived: true },
    { ...base, id: 'ses_locked', title: 'Locked archive', locked: true },
    { ...base, id: 'ses_missing', title: 'No archive outcome', if_approved: '' },
    { ...base, id: 'pr-one', kind: 'pr', title: 'First merge', recommended_action: 'merge' },
    { ...base, id: 'pr-two', kind: 'pr', title: 'Second merge', recommended_action: 'merge' },
    { ...base, id: 'ses_keep', title: 'Reference keep', recommended_action: 'keep' },
  ], decisions: [] }));
  const live = await startServer({ feed: feedPath, dir: join(directory, 'queue') });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let feedRequests = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/feed') feedRequests++; });
  try {
    await page.route('**/server.json', (route) => route.fulfill({ json: { origin: 'http://127.0.0.1:1', token: live.token } }));
    await page.goto(live.url);
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('CONNECTION LOST');
    expect(feedRequests).toBe(0);
    expect(await page.getByTestId('queue-row').count()).toBe(0);
    await page.unroute('**/server.json');
    await page.reload();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.getByTestId('queue-row').count()).toBe(2);
    expect(await page.getByTestId('archive-batch').textContent()).toContain('Archive 2 concluded sessions');
    expect(await page.getByTestId('archive-batch').textContent()).toContain('Mixed archive groups or original recommendations');
    expect(await page.getByTestId('archive-batch').locator('[data-batch-approve]').isDisabled()).toBe(true);
    await page.locator('#recommendation').selectOption('archive');
    expect(await page.getByTestId('archive-batch').locator('[data-batch-approve]').isDisabled()).toBe(true);
    await page.locator('#search').fill('First archive shape');
    await page.getByTestId('archive-batch').locator('[data-batch-approve]').click();
    expect(await page.locator('#batch-preview li').allTextContents()).toEqual(['First archive shape — ses_one']);
    await page.locator('#cancel-bulk').click();
    await page.locator('#search').fill('');
    await page.locator('#recommendation').selectOption('merge');
    await page.locator('#status').selectOption('');
    await page.locator('#select-visible').check();
    expect(await page.locator('#bulk-apply').isDisabled()).toBe(true);
    expect(await page.locator('#bulk-shape').textContent()).toContain('Bulk merge approval is forbidden');
    expect(readLog(live.directory, 'decisions.jsonl')).toEqual([]);
    evidence.recordAssertionEvidence('Archive scope, merge and origin guards fail closed', 'Mismatched metadata origin never fetches feed. Default human view hides keep, locked and archive rows; the archive card excludes protected, archived, locked and no-outcome sessions, and refuses two different original archive shapes. Explicit search narrows the full confirmation scope. Two merge candidates cannot receive bulk approval. No requests were enqueued.', true);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
