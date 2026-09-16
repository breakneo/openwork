import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { test } from '@openwork/testkit';
import { validateFeed, validateDelivery, deliveryOf, deliveryIdentity, deliveryClassification, sessionRoute } from '../../tools/review-queue/core.mjs';
import { enrichFeed } from '../../tools/review-queue/enrich.mjs';
import { startServer } from '../../tools/review-queue/serve.mjs';
import { next } from '../../tools/review-queue/executor.mjs';
import { readLog } from '../../tools/review-queue/protocol.mjs';

export function syntheticDelivery() {
  return { kind: 'chat-only', completeness: 'complete', source: 'session.read', provenance: 'Synthetic full authorized transcript', observed_at: '2026-01-01T00:00:00.000Z', exchanges: [
    { question: 'First synthetic question?', at: null, answers: [{ text: 'First full answer. ' + 'A'.repeat(1200), at: null }, { text: 'Continuation of the first answer.', at: null }] },
    { question: 'Second synthetic question?', at: '2026-01-01T00:00:00.000Z', answers: [{ text: 'Second complete answer <script>literal text</script>.', at: null }] },
  ] };
}

test('structured session delivery preserves all supplied questions and answers without inferring completeness', async ({ evidence }) => {
  const base = { items: [{ id: 'ses_delivery', workspace_id: 'ws_fixture', kind: 'session', title: 'Synthetic delivery', recommended_action: 'archive', if_approved: 'Archive after reading.' }] };
  const options = { report: '', summaries: { items: [{ id: 'ses_delivery', delivery: syntheticDelivery() }] } };
  const feed = enrichFeed(base, options);
  expect(deliveryOf(feed.items[0])).toEqual(syntheticDelivery());
  expect(deliveryClassification(feed.items[0])).toBe('Read → archive');
  expect(sessionRoute(feed.items[0])).toBe('/workspace/ws_fixture/session/ses_delivery');
  expect(deliveryClassification(validateFeed(base).items[0])).toBe('Delivery type unknown');
  expect(validateDelivery({ ...syntheticDelivery(), completeness: undefined }).completeness).toBe('unknown');
  expect(() => validateDelivery({ ...syntheticDelivery(), exchanges: [] })).toThrow();
  expect(() => validateDelivery({ ...syntheticDelivery(), source: 'engine-database' })).toThrow();
  expect(() => validateDelivery({ ...syntheticDelivery(), exchanges: [{ question: 'Q?', at: null, answers: [{ text: 'x'.repeat(1000001), at: null }] }] })).toThrow();
  expect(deliveryIdentity(feed.items[0])).not.toBe(deliveryIdentity(validateFeed(base).items[0]));
  evidence.recordAssertionEvidence('Produced is not delivered to the user', 'Full two-question/three-answer transcript survives enrichment byte-for-byte, including long text. Explicit chat-only classification and safe copyable route; absent completeness remains unknown, invalid source/empty complete/oversize text rejected rather than truncated.', true);
});

test('read acknowledgement binds the exact delivery and snapshot, gates archive server-side, and is never work', async ({ evidence }) => {
  const root = mkdtempSync(join(tmpdir(), 'queue-delivery-'));
  const path = join(root, 'feed.json');
  const feed = validateFeed({ items: [{ id: 'ses_delivery', workspace_id: 'ws_fixture', kind: 'session', title: 'Synthetic delivery', recommended_action: 'archive', if_approved: 'Archive after reading.', delivery: syntheticDelivery() }] });
  writeFileSync(path, JSON.stringify(feed));
  const live = await startServer({ feed: path, dir: join(root, 'queue') });
  const snapshot = JSON.stringify({ ...feed, decisions: [] });
  const post = async (route: string, body: object) => fetch(live.origin + route, { method: 'POST', headers: { Origin: live.origin, 'X-Review-Token': live.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const decision = () => ({ id: randomUUID(), ids: ['ses_delivery'], action: 'approve', comment: '', decided_at: new Date().toISOString(), snapshot });
  try {
    expect((await post('/decisions', decision())).status).toBe(409);
    const read = { id: randomUUID(), item_id: 'ses_delivery', snapshot, deliverable: deliveryIdentity(feed.items[0]) };
    expect((await post('/reads', { ...read, snapshot: 'stale' })).status).toBe(409);
    expect((await post('/reads', { ...read, deliverable: 'not-the-answer' })).status).toBe(409);
    expect((await post('/reads', read)).status).toBe(200);
    expect((await post('/reads', read)).status).toBe(200);
    expect(next(live.directory)).toBeNull();
    expect(readLog(live.directory, 'decisions.jsonl')).toHaveLength(1);
    const approved = decision();
    expect((await post('/decisions', approved)).status).toBe(200);
    expect(next(live.directory).id).toBe(approved.id);
    const mdPath = join(live.directory, 'deliverables', 'ses_delivery.md');
    const markdown = readFileSync(mdPath, 'utf8');
    for (const exchange of syntheticDelivery().exchanges) for (const answer of exchange.answers) expect(markdown).toContain(answer.text);
    expect(markdown).toContain('/workspace/ws_fixture/session/ses_delivery');
    expect(statSync(mdPath).mode & 0o777).toBe(0o600);
    expect((await fetch(live.origin + '/deliverables/ses_delivery.md')).status).toBe(401);
    const file = await fetch(live.origin + '/deliverables/ses_delivery.md', { headers: { 'X-Review-Token': live.token } });
    expect((await file.json()).markdown).toBe(markdown);
    expect((await fetch(live.origin + '/deliverables/ses_other.md', { headers: { 'X-Review-Token': live.token } })).status).toBe(404);
    evidence.recordAssertionEvidence('Read gate is durable, exact and non-executable', 'Archive denied before read; stale snapshot/delivery rejected; duplicate read produces one nonclaimable ledger entry; subsequent approval claims once. Private Markdown preserves every answer and route; unauthenticated/unknown downloads denied.', true);
  } finally {
    await new Promise<void>((resolve) => { live.server.close(() => resolve()); live.server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});
