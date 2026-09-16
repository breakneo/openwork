import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { privateDirectory, withLedger, readLog, appendEvent, statusEvent, requestId, boundedText, STATES, fail, cliArgs } from './protocol.mjs';

function publishedInputs(directory) {
  const inputs = readLog(directory, 'decisions.jsonl').map((input) => input.event);
  const events = readLog(directory, 'results.jsonl');
  for (const input of inputs) {
    const receipt = events.find((event) => event.id === input.id);
    if (!receipt || !isDeepStrictEqual(receipt, input)) fail('Unpublished or inconsistent input; manual recovery required', 503);
  }
  return { inputs, events };
}

export function next(directory = 'reports/review-queue') {
  const dir = privateDirectory(directory);
  return withLedger(dir, () => {
    const { inputs, events } = publishedInputs(dir);
    const claimed = new Set(events.filter((event) => event.kind === 'status' && event.status === 'rechecking').map((event) => event.decision_id));
    // A human stop is a durable latch, including after a crash or a new worker.
    // Resuming requires explicit human review and a fresh queue directory.
    if (inputs.some((input) => input.action === 'stop' && claimed.has(input.id))) return null;
    const pending = inputs.filter((input) => !claimed.has(input.id));
    const input = pending.find((entry) => entry.action === 'stop') ?? pending[0];
    if (!input) return null;
    appendEvent(dir, 'results.jsonl', statusEvent(input, 'rechecking', 'Claimed before returning work; never automatically replay uncertain work.'));
    return input;
  });
}

export function result(id, status, text, directory = 'reports/review-queue') {
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
    if (last.status === status && last.text === text) return last;
    const event = statusEvent(input, status, text);
    appendEvent(dir, 'results.jsonl', event);
    return event;
  });
}

function main(args) {
  const { options, positionals } = cliArgs(args, ['dir']);
  const [command, id, status, text] = positionals;
  if (command === 'next' && positionals.length === 1) return next(options.dir);
  if (command === 'result' && positionals.length === 4) return result(id, status, text, options.dir);
  fail('Usage: executor.mjs [--dir PATH] next | result ID STATUS TEXT');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
