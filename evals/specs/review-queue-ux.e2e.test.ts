import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { startServer } from '../../tools/review-queue/serve.mjs';
import { next, result } from '../../tools/review-queue/executor.mjs';
import { readLog } from '../../tools/review-queue/protocol.mjs';

const fullAnswer = 'Full synthetic answer ' + 'x'.repeat(1600);

test('chat-only answers expand in full and a persisted read acknowledgement unlocks archive', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-read-browser-'));
  const feed = join(directory, 'feed.json');
  await writeFile(feed, JSON.stringify({ items: [{ id: 'ses_read', workspace_id: 'ws_fixture', title: 'Read synthetic answers', kind: 'session', group: 'example', recommended_action: 'archive', if_approved: 'Archive after reading.', delivery: {
    kind: 'chat-only', completeness: 'complete', source: 'session.read', provenance: 'Synthetic full transcript', observed_at: '2026-01-01T00:00:00.000Z', exchanges: [
      { question: 'First question?', at: null, answers: [{ text: fullAnswer, at: null }] },
      { question: 'Second question?', at: null, answers: [{ text: 'Second full answer.', at: null }] },
    ],
  } }], decisions: [] }));
  const live = await startServer({ feed, dir: join(directory, 'queue') });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(live.url);
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.getByTestId('archive-batch').count()).toBe(0);
    expect(await page.locator('[data-action="approve"]').isDisabled()).toBe(true);
    expect(await page.getByTestId('delivery-answers').getAttribute('open')).toBeNull();
    await page.getByTestId('delivery-answers').locator('summary').click();
    expect(await page.getByTestId('delivery-answers').innerText()).toContain(fullAnswer);
    expect(await page.getByTestId('delivery-answers').innerText()).toContain('Second full answer.');
    expect(await page.locator('[data-action="approve"]').isDisabled()).toBe(true);
    await page.getByTestId('mark-read').click();
    await expect.poll(() => page.locator('[data-action="approve"]').isDisabled()).toBe(false);
    expect(next(live.directory)).toBeNull();
    await page.reload();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.getByTestId('archive-batch').count()).toBe(1);
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(1);
    evidence.recordAssertionEvidence('Read before archive means the full delivered answers', 'Collapsed-by-default two-question transcript reveals full long answer and second answer. Expansion alone does not authorize archive; explicit durable Mark read unlocks it, is never claimed as work, survives reload and admits the session to the archive batch.', true);
  } finally {
    await browser.close(); await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('review advances in displayed order after acceptance, preserves uncertain cards and reaches Decided', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-ux-'));
  const feed = join(directory, 'feed.json');
  await writeFile(feed, JSON.stringify({ items: [...Array.from({ length: 4 }, (_, index) => ({
    id: `ses_fixture${index}`, title: `Synthetic review ${index}`, kind: 'session', group: 'example',
    recommended_action: 'review', question: 'Keep this example?', if_approved: 'Recheck this example.',
  })), { id: 'ses_uncertain', title: 'Uncertain fixture', kind: 'session', recommended_action: 'keep' }], decisions: [] }));
  const live = await startServer({ feed, dir: join(directory, 'queue') });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  try {
    await page.goto(live.url);
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    await page.locator('#detail').focus();
    await page.keyboard.press('j');
    expect(await page.getByTestId('detail-title').textContent()).toBe('Synthetic review 1');
    await page.keyboard.press('k');
    expect(await page.getByTestId('detail-title').textContent()).toBe('Synthetic review 0');
    await page.locator('[data-action="approve"]').click();
    await expect.poll(() => page.getByTestId('detail-title').textContent()).toBe('Synthetic review 1');
    expect(await page.locator('[data-id="ses_fixture0"]').count()).toBe(0);
    await page.getByTestId('comment').fill('Explain the synthetic choice.');
    await page.getByTestId('thread-send').click();
    await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(2);
    expect(await page.getByTestId('detail-title').textContent()).toBe('Synthetic review 1');
    await page.locator('[data-action="decline"]').click();
    await expect.poll(() => page.getByTestId('detail-title').textContent()).toBe('Synthetic review 2');
    await page.locator('#select-visible').check();
    await page.locator('#bulk-action').selectOption('decline');
    await page.locator('#bulk-apply').click();
    expect(await page.locator('#batch-preview li').count()).toBe(2);
    await page.getByTestId('confirm-bulk').click();
    await expect.poll(() => page.getByTestId('queue-row').count()).toBe(0);
    expect(await page.locator('#detail').textContent()).toContain('No more cards');
    await page.locator('#status').selectOption('decided');
    expect(await page.getByTestId('queue-row').count()).toBe(4);
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(4);
    expect(await page.locator('[data-log-id]').count()).toBe(4);
    const work = next(live.directory);
    result(work.id, 'done', 'Synthetic completion receipt', live.directory);
    await expect.poll(() => page.getByTestId('action-log').textContent(), { timeout: 8000 }).toContain('Synthetic completion receipt');
    expect(await page.getByTestId('action-log').textContent()).toContain('running / rechecking');
    await page.getByTestId('action-log').getByRole('button', { name: 'Synthetic review 0 · ses_fixture0', exact: true }).click();
    expect(await page.getByTestId('detail-title').textContent()).toBe('Synthetic review 0');
    await page.reload();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.getByTestId('queue-row').count()).toBe(0);
    expect(await page.locator('[data-log-id]').count()).toBe(4);
    expect(await page.getByTestId('action-log').textContent()).toContain('Synthetic completion receipt');
    await page.locator('#status').selectOption('');
    await page.locator('[data-id="ses_uncertain"] .row-open').click();
    await page.route('**/decisions', (route) => route.abort('connectionfailed'));
    await page.locator('[data-action="decline"]').click();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('CONNECTION LOST');
    expect(await page.getByTestId('detail-title').textContent()).toBe('Uncertain fixture');
    expect(await page.getByTestId('thread-events').textContent()).toContain('UNCERTAIN');
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(4);
    expect(errors).toEqual([]);
    evidence.recordAssertionEvidence('Confirmed auto-advance, whole-batch scope and uncertainty', 'Isolated synthetic Chromium checks j/k, approve then ask progression, two-card bulk decline, all-decided empty state, Decided/reload persistence, and no advancement or retry after transport failure.', true);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('undo and change are accessible from log and card, show non-interruptible work and gate compensation', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-ux-controls-'));
  const feed = join(directory, 'feed.json');
  await writeFile(feed, JSON.stringify({ items: ['A', 'B'].map((name) => ({ id: `ses_archive${name}`, title: `Synthetic archive ${name}`, kind: 'session', group: 'example', recommended_action: 'archive', if_approved: 'Recheck before archive.' })), decisions: [] }));
  const live = await startServer({ feed, dir: join(directory, 'queue') });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(live.url);
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    await page.getByTestId('archive-batch').getByRole('button', { name: 'Review archive batch' }).click();
    await page.getByTestId('confirm-bulk').click();
    await expect.poll(() => page.locator('[data-log-id]').count()).toBe(1);
    const original = readLog(live.directory, 'decisions.jsonl')[0].event;
    const row = page.locator(`[data-log-id="${original.id}"]`);
    await row.getByRole('button', { name: 'Undo decision', exact: true }).click();
    expect(await page.locator('#control-items li').count()).toBe(2);
    expect(await page.locator('#control-effect').textContent()).toContain('whole batch only');
    await page.locator('#cancel-control').click();
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(1);
    await row.getByRole('button', { name: 'Undo decision', exact: true }).click();
    await page.locator('#confirm-control').click();
    await expect.poll(() => row.textContent()).toContain('Withdrawn / changed');
    expect(next(live.directory)).toBeNull();
    expect(await page.getByTestId('action-log').textContent()).toContain('withdrawn');
    await page.reload();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.locator('[data-log-id]').count()).toBe(2);
    await page.getByTestId('archive-batch').getByRole('button', { name: 'Review archive batch' }).click();
    await page.getByTestId('confirm-bulk').click();
    await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(3);
    const running = next(live.directory);
    await page.locator('#status').selectOption('decided');
    await page.locator('[data-id="ses_archiveA"] .row-open').click();
    await expect.poll(() => page.locator('#card-controls').textContent(), { timeout: 8000 }).toContain('Running — cannot interrupt');
    expect(await page.locator('#card-controls [data-control-mode="undo"]').isDisabled()).toBe(true);
    result(running.id, 'archived', 'Both synthetic sessions archived', live.directory, ['ses_archiveA', 'ses_archiveB'].map((item_id) => ({ item_id, status: 'archived', text: 'Synthetic archive confirmed' })));
    await expect.poll(() => page.locator('#card-controls').textContent(), { timeout: 8000 }).toContain('Undo queues unarchive');
    await page.locator('#card-controls [data-control-mode="change"]').click();
    await page.locator('#replacement-action').selectOption('decline');
    await page.locator('#confirm-control').click();
    await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(4);
    const control = readLog(live.directory, 'decisions.jsonl').at(-1).event;
    const compensation = next(live.directory);
    expect(compensation.id).toBe(control.compensation_id);
    expect(compensation.action).toBe('unarchive');
    expect(next(live.directory)).toBeNull();
    result(compensation.id, 'blocked', 'Synthetic partial outcome: inspect target B', live.directory);
    await expect.poll(() => page.getByTestId('action-log').textContent(), { timeout: 8000 }).toContain('Synthetic partial outcome');
    expect(next(live.directory)).toBeNull();
    result(compensation.id, 'unarchived', 'Both targets reconciled and unarchived', live.directory, ['ses_archiveA', 'ses_archiveB'].map((item_id) => ({ item_id, status: 'unarchived', text: 'Synthetic unarchive confirmed' })));
    expect(next(live.directory).id).toBe(control.replacement_id);
    await page.reload();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.getByTestId('action-log').textContent()).toContain('Both targets reconciled and unarchived');
    expect(await page.getByTestId('action-log').textContent()).toContain(`depends_on: ${compensation.id}`);
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(4);
    expect(errors).toEqual([]);
    evidence.recordAssertionEvidence('Log and decided-card controls disclose exact safety semantics', 'Synthetic browser confirms entire two-card batch scope, cancel without write, log undo before claim with reload persistence, disabled running undo on decided card, archive change dialog, compensation-before-replacement, partial outcome blocked and linked durable history. No live external actions.', true);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
