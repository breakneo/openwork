import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { startServer } from '../../tools/review-queue/serve.mjs';
import { readLog } from '../../tools/review-queue/protocol.mjs';

const at = '2026-01-01T12:00:00.000Z';
const safety = [{ label: 'Pinned', value: 'no' }, { label: 'Status', value: 'idle' }];
const authorization = (action: string, target_id: string) => ({ action, target_id, authorized: true, source: 'explicit-human', text: 'Reviewed permission for this exact synthetic target.', provenance: 'Synthetic human instruction', at });

test('recommendation-aware actions expose only safe archive and explicitly authorized destructive controls', async ({ evidence }) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-action-browser-'));
  const feed = join(directory, 'feed.json');
  const session = { kind: 'session', workspace_id: 'ws_fixture', recommended_action: 'review', question: 'Review this proposal?', if_approved: 'review this proposal', evidence: safety };
  const pr = { kind: 'pr', recommended_action: 'review', question: 'Approve this proposal?', if_approved: 'Discuss closing this PR.', pr_url: 'https://github.com/example/demo/pull/7', head_sha: 'a'.repeat(40), evidence: [{ label: 'State', value: 'OPEN' }] };
  const treePath = "/synthetic/tree's space";
  await writeFile(feed, JSON.stringify({ items: [
    { ...session, id: 'ses_safe', title: 'Synthetic safe proposal', delivery: { kind: 'chat-only', completeness: 'complete', source: 'session.read', provenance: 'Synthetic complete answers', observed_at: at, exchanges: [{ question: 'Explain?', at, answers: [{ text: 'Full synthetic answer.', at }] }] } },
    { ...session, id: 'ses_pinned', title: 'Synthetic pinned session', evidence: [{ label: 'Pinned', value: 'yes' }, { label: 'Status', value: 'idle' }] },
    { ...session, id: 'ses_busy', title: 'Synthetic busy session', evidence: [{ label: 'Pinned', value: 'no' }, { label: 'Status', value: 'busy' }] },
    { ...session, id: 'ses_archive', title: 'Synthetic archive proposal', recommended_action: 'archive', if_approved: 'Archive this session.' },
    { ...session, id: 'ses_nooutcome', title: 'Archive without narrative', recommended_action: 'archive', if_approved: '' },
    { ...pr, id: 'pr-unknown', title: 'Unpermitted PR closure' },
    { ...pr, id: 'pr-allowed', title: 'Permitted PR closure', action_authorizations: [authorization('close_pr', 'pr-allowed')] },
    { id: treePath, title: 'Permitted worktree reclaim', kind: 'worktree', recommended_action: 'review_worktree_removal', action_authorizations: [authorization('reclaim', treePath)] },
    { id: '/synthetic/locked', title: 'Locked worktree', kind: 'worktree', recommended_action: 'review_worktree_removal', locked: true, action_authorizations: [authorization('reclaim', '/synthetic/locked')] },
  ], decisions: [] }));
  const live = await startServer({ feed, dir: join(directory, 'queue') });
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  const open = async (title: string) => { await page.locator('#status').selectOption(''); await page.getByRole('button', { name: `Review ${title}`, exact: true }).click(); };
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(live.url); await expect.poll(() => page.locator('#mode-badge').textContent()).toBe('LIVE');
    await open('Synthetic safe proposal');
    expect(await page.getByRole('button', { name: 'Approve: review this proposal', exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Archive', exact: true }).isDisabled()).toBe(true);
    await page.getByTestId('delivery-answers').locator('summary').click(); await page.getByTestId('mark-read').click();
    await expect.poll(() => page.getByRole('button', { name: 'Archive', exact: true }).isDisabled()).toBe(false);
    const actionCard = page.locator('#detail [data-field="decision"]');
    expect(await actionCard.evaluate((node) => node.clientWidth > 600 && node.clientHeight > 200 && node.scrollWidth <= node.clientWidth)).toBe(true);
    const cardPng = await actionCard.screenshot({ path: join(evidence.dir, 'card-actions.png') });
    expect(cardPng.byteLength).toBeGreaterThan(5000);
    evidence.recordJsonArtifact('Synthetic card actions PNG', { file: 'card-actions.png', viewport: { width: 1440, height: 1000 }, state: 'Complete synthetic delivery marked read; Archive enabled; supplemental image for manual visual inspection.' });
    await page.locator('#detail').focus(); await page.keyboard.press('x');
    await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(2);
    expect(readLog(live.directory, 'decisions.jsonl').at(-1).event.action).toBe('archive');
    await open('Synthetic pinned session'); expect(await page.locator('[data-action="archive"]').count()).toBe(0);
    await page.locator('#detail').focus(); await page.keyboard.press('k');
    await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(3);
    expect(readLog(live.directory, 'decisions.jsonl').at(-1).event.action).toBe('decline');
    expect(await page.locator('#metrics').textContent()).toContain('1 kept');
    await open('Synthetic busy session'); expect(await page.locator('[data-action="archive"]').count()).toBe(0);
    await page.locator('#detail').focus(); await page.keyboard.press('ArrowUp'); expect(await page.getByTestId('detail-title').textContent()).toBe('Synthetic pinned session');
    await open('Synthetic archive proposal'); expect(await page.getByRole('button', { name: 'Approve: archive this session', exact: true }).count()).toBe(1); expect(await page.getByRole('button', { name: 'Archive', exact: true }).count()).toBe(0);
    await page.locator('#detail').focus(); await page.keyboard.press('a'); await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(4);
    expect(readLog(live.directory, 'decisions.jsonl').at(-1).event.action).toBe('approve');
    await open('Archive without narrative'); expect(await page.getByRole('button', { name: 'Approve: archive this session', exact: true }).count()).toBe(1); expect(await page.getByRole('button', { name: 'Archive', exact: true }).count()).toBe(0);
    await page.locator('#detail').focus(); await page.keyboard.press('a'); await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(5); expect(readLog(live.directory, 'decisions.jsonl').at(-1).event.action).toBe('archive');
    await open('Unpermitted PR closure'); expect(await page.getByRole('button', { name: 'Close PR', exact: true }).count()).toBe(0);
    await open('Permitted PR closure'); await page.getByRole('button', { name: 'Close PR', exact: true }).click(); await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(6);
    expect(readLog(live.directory, 'decisions.jsonl').at(-1).event.action).toBe('close_pr');
    await open('Permitted worktree reclaim'); expect(await page.getByTestId('reclaim-command').textContent()).toBe("git worktree remove -- '/synthetic/tree'\\''s space'");
    await page.getByRole('button', { name: 'Reclaim', exact: true }).click(); await expect.poll(() => readLog(live.directory, 'decisions.jsonl').length).toBe(7);
    expect(readLog(live.directory, 'decisions.jsonl').at(-1).event.action).toBe('approve');
    await open('Locked worktree'); expect(await page.getByRole('button', { name: 'Reclaim', exact: true }).count()).toBe(0);
    evidence.recordAssertionEvidence('Contextual actions retain explicit intent boundaries', 'Chromium proves labelled proposal approval, universal archive gated by full read, no Archive for pinned/busy sessions, x archive/k Keep/ArrowUp previous, absorbed archive approval, omitted unpermitted PR Close, typed authorized Close and safely quoted Reclaim with approve-only record. Hard locked worktree stays untouched; only synthetic ledger writes occur.', true);
  } finally { await browser.close(); await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); }
});
