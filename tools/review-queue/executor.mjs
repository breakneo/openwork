import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { privateDirectory, withLedger, readQueue, readBounded, controlledIds, outstandingInputs, workHistory, dependencyReady, validateOutcomes, requireDeliveryRead, appendEvent, statusEvent, requestId, boundedText, STATES, fail, cliArgs } from './protocol.mjs';

function publishedInputs(directory) {
  const { inputs, events, entries } = readQueue(directory);
  for (const input of inputs) {
    const receipt = events.find((event) => event.id === input.id);
    if (!receipt || !isDeepStrictEqual(receipt, input)) fail('Unpublished or inconsistent input; manual recovery required', 503);
  }
  return { inputs, events, entries };
}

export function next(directory = 'reports/review-queue') {
  const dir = privateDirectory(directory);
  return withLedger(dir, () => {
    const { inputs, events, entries } = publishedInputs(dir);
    const claimed = new Set(events.filter((event) => event.kind === 'status' && event.status === 'rechecking').map((event) => event.decision_id));
    if (inputs.some((input) => input.action === 'stop' && claimed.has(input.id))) return null;
    const withdrawn = controlledIds(inputs);
    const pending = inputs.filter((input) => !['control', 'read'].includes(input.kind) && !claimed.has(input.id) && !withdrawn.has(input.id));
    const ordered = [...pending.filter((input) => input.action === 'stop'), ...pending.filter((input) => input.action !== 'stop')];
    for (const input of ordered) {
      if (!dependencyReady(input, inputs, events)) {
        if (!workHistory(input, events).some((event) => event.status === 'blocked')) appendEvent(dir, 'results.jsonl', statusEvent(input, 'blocked', 'Replacement cannot run until compensation explicitly succeeds for every target. Failure or uncertainty keeps it blocked.'));
        continue;
      }
      const state = JSON.parse(readBounded(join(dir, 'feed-state.json'), 16 * 1024 * 1024));
      const entry = entries.find((entry) => entry.event.id === input.id);
      const stale = entry.snapshot !== undefined ? entry.snapshot !== state.snapshot : input.items.some((item) => !state.items.some((current) => isDeepStrictEqual(current, item)));
      const overlap = input.kind === 'decision' && outstandingInputs(inputs, events).some((other) => other.id !== input.id && other.kind === 'decision' && other.item_ids.some((id) => input.item_ids.includes(id)));
      if (input.action === 'approve') requireDeliveryRead(input.items, entries, entry.snapshot);
      const running = inputs.some((other) => other.id !== input.id && claimed.has(other.id) && workHistory(other, events).at(-1)?.status === 'rechecking' && other.item_ids.some((id) => input.item_ids.includes(id)));
      if (running && input.action !== 'stop') continue;
      appendEvent(dir, 'results.jsonl', statusEvent(input, 'rechecking', 'Claimed before returning work; never automatically replay uncertain work.'));
      if ((stale || overlap) && input.action !== 'stop') {
        appendEvent(dir, 'results.jsonl', statusEvent(input, 'blocked', stale ? 'Stale feed: no external action attempted by this claim. Reconcile against the current snapshot.' : 'Multiple same-item decisions: no external action attempted by this claim. Reconcile instead of executing superseded work.'));
        continue;
      }
      return input;
    }
    return null;
  });
}

export function result(id, status, text, directory = 'reports/review-queue', ...outcomeArguments) {
  if (outcomeArguments.length > 1) fail('At most one outcomes array is accepted');
  const [outcomes] = outcomeArguments;
  requestId(id);
  boundedText(text);
  if (!STATES.includes(status)) fail('Invalid result status');
  const dir = privateDirectory(directory);
  return withLedger(dir, () => {
    const { inputs, events } = publishedInputs(dir);
    const input = inputs.find((entry) => entry.id === id);
    if (!input) fail('Unknown work id', 404);
    const history = events.filter((event) => event.decision_id === id && event.id !== id);
    if (!history.some((event) => event.kind === 'status' && event.status === 'rechecking')) fail('Work must be claimed before recording a result', 409);
    const last = history.at(-1);
    validateOutcomes(input, status, outcomes);
    if (last.status === status && last.text === text && isDeepStrictEqual(last.outcomes, outcomes)) return last;
    if (controlledIds(inputs).has(id)) fail('Controlled work is frozen; report on its compensation or replacement', 409);
    if (input.kind === 'compensation' && ['unarchived', 'cancelled'].includes(last.status)) fail('Successful compensation is final; do not invalidate a replacement dependency', 409);
    if ([status, ...(outcomes ?? []).map((entry) => entry.status)].some((value) => ['unarchived', 'cancelled'].includes(value) && (input.kind !== 'compensation' || value !== (input.action === 'unarchive' ? 'unarchived' : 'cancelled')))) fail('Result does not match the compensation action', 409);
    const noEffectIds = status === 'no_effect' ? input.item_ids : (outcomes ?? []).filter((entry) => entry.status === 'no_effect').map((entry) => entry.item_id);
    if (history.some((event) => noEffectIds.some((id) => ['archived', 'merged', 'sent', 'waiting', 'reply'].includes(event.outcomes ? event.outcomes.find((entry) => entry.item_id === id)?.status : event.status)))) fail('Known external effect cannot be relabeled no_effect', 409);
    const event = { ...statusEvent(input, status, text), ...(outcomes ? { outcomes } : {}) };
    appendEvent(dir, 'results.jsonl', event);
    return event;
  });
}

function main(args) {
  const { options, positionals } = cliArgs(args, ['dir']);
  const [command, id, status, text] = positionals;
  if (command === 'next' && positionals.length === 1) return next(options.dir);
  if (command === 'result' && [4, 5].includes(positionals.length)) return result(id, status, text, options.dir, positionals.length === 5 ? JSON.parse(positionals[4]) : undefined);
  fail('Usage: executor.mjs [--dir PATH] next | result ID STATUS TEXT [OUTCOMES_JSON]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
