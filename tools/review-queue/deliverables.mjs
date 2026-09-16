import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { validateFeed, deliveryOf, sessionRoute, isLocked } from './core.mjs';
import { privateDirectory, writePrivateText } from './protocol.mjs';

export function deliverableMarkdown(item) {
  const delivery = deliveryOf(item);
  if (!delivery) throw new Error('No structured delivery supplied');
  const quote = (text) => {
    const fence = '`'.repeat([...text.matchAll(/`+/g)].reduce((size, match) => Math.max(size, match[0].length + 1), 3));
    return `${fence}text\n${text}\n${fence}`;
  };
  return [`# Session deliverable`, quote(item.title), `Observed: ${delivery.observed_at}`, `Completeness: ${delivery.completeness}`, `Source: ${delivery.source}`, quote(delivery.provenance), `Session: ${item.id}`, `Workspace: ${item.workspace_id ?? 'unknown'}`, `OpenWork route: ${sessionRoute(item) ?? 'unknown — workspace identity not supplied'}`,
    ...delivery.exchanges.flatMap((exchange, index) => [`## Question ${index + 1}`, `Date: ${exchange.at ?? 'unknown'}`, quote(exchange.question), ...exchange.answers.flatMap((answer, number) => [`### Answer ${number + 1}`, `Date: ${answer.at ?? 'unknown'}`, quote(answer.text)])]),
    'Produced is not delivered to the user. Reading this file does not archive the session or authorize execution.\n'].join('\n\n');
}

export function writeDeliverables(feed, directory, { replace = false, inputs = [] } = {}) {
  const items = validateFeed(feed).items.filter((item) => deliveryOf(item) && !isLocked(item));
  if (!items.length) return [];
  const target = privateDirectory(join(directory, 'deliverables'));
  for (const item of items) {
    const path = join(target, `${item.id}.md`);
    if (inputs.some((input) => resolve(input) === path)) throw new Error('Deliverable output aliases an input');
    if (existsSync(path) && !replace) throw new Error('Deliverable output exists; use explicit replacement');
  }
  return items.map((item) => {
    writePrivateText(target, `${item.id}.md`, deliverableMarkdown(item));
    return join(target, `${item.id}.md`);
  });
}
