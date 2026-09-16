import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { startServer } from '../../tools/review-queue/serve.mjs';
import { readLog } from '../../tools/review-queue/protocol.mjs';

test('review advances in displayed order after acceptance, preserves uncertain cards and reaches Decided', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-ux-'));
  const feed = join(directory, 'feed.json');
  await writeFile(feed, JSON.stringify({ items: Array.from({ length: 4 }, (_, index) => ({
    id: `ses_fixture${index}`, title: `Synthetic review ${index}`, kind: 'session', group: 'example',
    recommended_action: 'review', question: 'Keep this example?', if_approved: 'Recheck this example.',
  })), decisions: [] }));
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
    await page.locator('[data-action="ask_info"]').click();
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
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(3);
    await page.reload();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.getByTestId('queue-row').count()).toBe(0);
    await page.locator('#status').selectOption('decided');
    await page.locator('[data-id="ses_fixture2"] .row-open').click();
    await page.route('**/decisions', (route) => route.abort('connectionfailed'));
    await page.locator('[data-action="decline"]').click();
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('CONNECTION LOST');
    expect(await page.getByTestId('detail-title').textContent()).toBe('Synthetic review 2');
    expect(await page.getByTestId('thread-events').textContent()).toContain('UNCERTAIN');
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(3);
    expect(errors).toEqual([]);
    evidence.recordAssertionEvidence('Confirmed auto-advance, whole-batch scope and uncertainty', 'Isolated synthetic Chromium checks j/k, approve then ask progression, two-card bulk decline, all-decided empty state, Decided/reload persistence, and no advancement or retry after transport failure.', true);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
