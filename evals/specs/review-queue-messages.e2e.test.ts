import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { startServer } from '../../tools/review-queue/serve.mjs';
import { next, result } from '../../tools/review-queue/executor.mjs';
import { readLog } from '../../tools/review-queue/protocol.mjs';

test('Later is browser-local and messages do not replace approval', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-message-browser-'));
  const feed = join(directory, 'feed.json');
  await writeFile(feed, JSON.stringify({ items: ['A', 'B'].map((name) => ({ id: `ses_message${name}`, title: `Synthetic ${name}`, kind: 'session', recommended_action: 'review', question: 'Keep this example?', if_approved: 'Review the example.' })), decisions: [] }));
  const live = await startServer({ feed, dir: join(directory, 'queue') });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let posts = 0;
  page.on('request', (request) => { if (request.method() === 'POST') posts++; });
  page.on('dialog', (dialog) => dialog.accept());
  try {
    await page.goto(live.url);
    await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.locator('#detail textarea:not([readonly])').count()).toBe(1);
    await page.locator('#detail').focus(); await page.keyboard.press('l');
    expect(await page.getByTestId('detail-title').textContent()).toBe('Synthetic B');
    expect(await page.locator('#status option[value="later"]').textContent()).toBe('Later (1)');
    expect(posts).toBe(0); expect(next(live.directory)).toBeNull();
    await page.reload(); await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    expect(await page.getByTestId('queue-row').count()).toBe(1);
    await page.locator('#status').selectOption('later');
    expect(await page.getByTestId('detail-title').textContent()).toBe('Synthetic A');
    await page.getByRole('button', { name: 'Return to queue', exact: true }).click();
    expect(posts).toBe(0);
    await page.locator('[data-action="approve"]').click();
    await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(1);
    const approval = next(live.directory); result(approval.id, 'done', 'Synthetic verification complete', live.directory);
    await page.locator('#status').selectOption('decided');
    await page.getByRole('button', { name: 'Why…?', exact: true }).click();
    expect(await page.locator('#comment').inputValue()).toBe('Why ');
    expect(posts).toBe(1);
    await page.locator('#comment').fill('Why is this the recommended option?');
    await page.locator('#comment').press('Control+Enter');
    await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(2);
    const message = next(live.directory);
    expect(message.action).toBe('message');
    expect(message.text).toBe('Why is this the recommended option?');
    expect(await page.getByTestId('queue-row').count()).toBe(1);
    expect(await page.locator('#metrics').textContent()).toContain('1 approved');
    expect(await page.getByTestId('action-log').textContent()).toContain('Message');
    expect(posts).toBe(2);
    evidence.recordAssertionEvidence('Three actions and one orthogonal message editor', 'Later via l advances and persists through reload/filter/return without POST or ledger work. Only one editable textarea; template merely prefills. Approve then Control+Enter message yields two distinct inputs while approval and Decided membership remain intact.', true);
  } finally {
    await browser.close(); await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
