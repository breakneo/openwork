import { constants, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, mkdirSync, lstatSync, realpathSync, unlinkSync, ftruncateSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chatOnly, deliveryOf, deliveryIdentity, isMessage, isArchiveAction } from './core.mjs';

export const PROTOCOL_VERSION = 4;
export const MAX_BODY = 8 * 1024 * 1024;
export const MAX_FEED = 4 * 1024 * 1024;
export const MAX_RECORD = 16 * 1024 * 1024;
export const MAX_LOG = 64 * 1024 * 1024;
export const STATES = ['rechecking', 'done', 'archived', 'merged', 'blocked', 'reply', 'deferred', 'declined', 'waiting', 'stopped', 'no_effect', 'sent', 'unarchived', 'cancelled', 'closed'];

export function fail(message, status = 400) {
  const error = new Error(message);
  Object.assign(error, { status });
  throw error;
}

export function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail('Invalid request fields');
}

export function requestId(value, uuid = false) {
  const pattern = uuid ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i : /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
  if (typeof value !== 'string' || !pattern.test(value)) fail('Invalid request id');
  return value;
}

export function boundedText(value, nonempty = true) {
  if (typeof value !== 'string' || value.length > 10000 || (nonempty && !value.trim()) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('Invalid text');
  return value;
}

export function privateDirectory(directory) {
  const path = resolve(directory);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 ||
      (process.getuid && stat.uid !== process.getuid())) fail('Queue directory must be owned, nonsymlink and mode 0700');
  const canonical = realpathSync(path);
  const fd = privateFile(join(canonical, '.gitignore'), constants.O_RDWR | constants.O_CREAT);
  try {
    if (fstatSync(fd).size === 0) {
      if (writeSync(fd, '*\n') !== 2) fail('Incomplete privacy marker', 503);
      fsyncSync(fd);
    } else if (readDescriptor(fd, 2) !== '*\n') fail('Queue directory must ignore all generated files');
  } finally { closeSync(fd); }
  return canonical;
}

function privateFile(path, flags) {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid())) fail('Queue files must be owned, single-link regular files and mode 0600');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readDescriptor(fd, limit) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > limit) fail('Input must be a bounded regular file');
  const buffer = Buffer.alloc(stat.size + 1);
  let size = 0;
  while (size < buffer.length) {
    const count = readSync(fd, buffer, size, buffer.length - size, size);
    if (!count) break;
    size += count;
  }
  if (size > stat.size || fstatSync(fd).size !== stat.size) fail('Input changed during read; retry after inspection', 503);
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
}

export function readBounded(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return readDescriptor(fd, limit); } finally { closeSync(fd); }
}

export function exclusiveFile(directory, name) {
  const path = join(directory, name);
  let fd;
  try { fd = privateFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL); }
  catch (error) {
    if (error.code === 'EEXIST') fail('Queue is locked; inspect uncertain work before manual recovery', 503);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    unlinkSync(path);
  };
}

export function withLedger(directory, callback) {
  const release = exclusiveFile(privateDirectory(directory), '.ledger.lock');
  try { return callback(); } finally { release(); }
}

export function readLog(directory, name, includeProtocol = false) {
  const fd = privateFile(join(directory, name), constants.O_RDONLY | constants.O_CREAT);
  try {
    if (fstatSync(fd).size > MAX_LOG) fail('Queue log is full', 507);
    const text = readDescriptor(fd, MAX_LOG);
    if (text && !text.endsWith('\n')) fail('Incomplete queue log; manual recovery required', 503);
    if (!text) return [];
    const lines = text.slice(0, -1).split('\n');
    if (lines.length > 100000) fail('Too many queue records', 507);
    const entries = lines.map((line) => {
      if (!line || Buffer.byteLength(line) > MAX_RECORD) fail('Invalid queue record; manual recovery required', 503);
      try { return JSON.parse(line); } catch { fail('Invalid queue JSON; manual recovery required', 503); }
    });
    return name === 'decisions.jsonl' && !includeProtocol ? entries.filter((entry) => entry.kind !== 'protocol') : entries;
  } finally { closeSync(fd); }
}

function lineFor(value) {
  const line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line) > MAX_RECORD) fail('Queue record is too large', 413);
  return line;
}

export function checkAppend(directory, name, value) {
  if (readLog(directory, name).length >= 100000) fail('Too many queue records', 507);
  const line = lineFor(value);
  const fd = privateFile(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
  try {
    if (fstatSync(fd).size + Buffer.byteLength(line) > MAX_LOG) fail('Queue log is full', 507);
  } finally { closeSync(fd); }
}

export function appendEvent(directory, name, value) {
  checkAppend(directory, name, value);
  const line = lineFor(value);
  const fd = privateFile(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
  try {
    if (fstatSync(fd).size + Buffer.byteLength(line) > MAX_LOG) fail('Queue log is full', 507);
    const bytes = Buffer.from(line);
    if (writeSync(fd, bytes) !== bytes.length) fail('Incomplete append; manual recovery required', 503);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function writeServerFile(directory, value, name = 'server.json') {
  return writePrivateText(directory, name, JSON.stringify(value) + '\n');
}
export function writePrivateText(directory, name, text) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) fail('Invalid private filename');
  const fd = privateFile(join(directory, name), constants.O_WRONLY | constants.O_CREAT);
  try {
    const bytes = Buffer.from(text);
    ftruncateSync(fd, 0);
    if (writeSync(fd, bytes) !== bytes.length) fail('Incomplete server metadata write', 503);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function queueProtocol(directory, initialize = false) {
  const markers = readLog(directory, 'decisions.jsonl', true).filter((entry) => entry.kind === 'protocol');
  if (markers.length > 1) fail('Multiple protocol epochs; manual inspection required', 503);
  const saved = existsSync(join(directory, 'protocol.json')) ? readLog(directory, 'protocol.json') : [];
  if (saved.length > 1) fail('Invalid protocol metadata', 503);
  const marker = markers[0];
  if (marker) {
    exactObject(marker, ['kind', 'protocol', 'epoch']); requestId(marker.epoch, true);
    if (marker.protocol !== PROTOCOL_VERSION) fail('Unsupported queue protocol epoch', 503);
    if (saved.length && !isDeepStrictEqual(saved[0], marker)) fail('Protocol epoch mismatch; do not downgrade or recreate ledgers', 503);
    if (!saved.length) {
      if (!initialize) fail('Missing protocol metadata; coordinated restart required', 503);
      writeServerFile(directory, marker, 'protocol.json');
    }
    return marker;
  }
  if (saved.length) fail('Protocol sentinel missing; ledger integrity is unknown', 503);
  if (!initialize) return null;
  const created = { kind: 'protocol', protocol: PROTOCOL_VERSION, epoch: randomUUID() };
  appendEvent(directory, 'decisions.jsonl', created);
  writeServerFile(directory, created, 'protocol.json');
  return created;
}

export function existingReceipt(directory, inputs, request) {
  const existing = inputs.find((entry) => entry.event.id === request.body?.id);
  if (!existing) return null;
  if (!isDeepStrictEqual(existing.request, request)) fail('Request id already used for a different body or route', 409);
  const published = readLog(directory, 'results.jsonl').find((event) => event.id === existing.event.id);
  if (published && !isDeepStrictEqual(published, existing.event)) fail('Inconsistent receipt; manual recovery required', 503);
  if (!published) fail('Publication must be reconciled under the shared ledger lock', 503);
  return existing.event;
}

export function enqueue(directory, request, event, children, snapshot) {
  const input = { request, event, ...(children ? { protocol: 2, children } : {}), ...(snapshot ? { snapshot } : {}) };
  checkAppend(directory, 'decisions.jsonl', input);
  for (const entry of [event, ...(children ?? [])]) checkAppend(directory, 'results.jsonl', entry);
  appendEvent(directory, 'decisions.jsonl', input);
  for (const entry of [event, ...(children ?? [])]) appendEvent(directory, 'results.jsonl', entry);
  return event;
}

export function readQueue(directory) {
  const version = queueProtocol(directory);
  const records = readLog(directory, 'decisions.jsonl');
  const events = readLog(directory, 'results.jsonl');
  const published = new Map();
  for (const event of events) {
    if (!event || typeof event.id !== 'string') fail('Invalid result record', 503);
    if (published.has(event.id) && !isDeepStrictEqual(published.get(event.id), event)) fail('Unequal duplicate result; manual recovery required', 503);
    published.set(event.id, event);
  }
  const entries = [];
  const ids = new Set();
  for (const record of records) {
    if (record.protocol !== undefined && record.protocol !== 2) fail('Unknown queue protocol', 503);
    if (record.protocol === 2) {
      if (!version) fail('Coordinated protocol upgrade required before controls can run', 503);
      if (!Array.isArray(record.children) || record.children.length > 2 || record.event.kind !== 'control') fail('Invalid control envelope', 503);
      const compensation = record.children.find((child) => child.kind === 'compensation');
      const replacement = record.children.find((child) => child.kind === 'decision');
      if ((compensation?.id ?? null) !== record.event.compensation_id || (replacement?.id ?? null) !== record.event.replacement_id || (record.children.length === 2 && record.children[0] !== compensation)) fail('Control children are not the frozen ordered plan', 503);
      for (const child of record.children) {
        if (!['compensation', 'decision'].includes(child.kind) || child.control_id !== record.event.id || child.target_id !== record.event.target_id || child.item_ids.some((id) => !record.event.item_ids.includes(id))) fail('Uncorrelated control child', 503);
        if (child.kind === 'decision' && child.depends_on !== compensation?.id) fail('Invalid replacement dependency', 503);
      }
    } else if (record.children !== undefined) fail('Unversioned child events', 503);
    for (const event of [record.event, ...(record.children ?? [])]) {
      if (!event || ids.has(event.id) || event.id !== event.decision_id || !Array.isArray(event.item_ids)) fail('Invalid or duplicate work input', 503);
      ids.add(event.id);
      if (published.has(event.id) && !isDeepStrictEqual(published.get(event.id), event)) fail('Inconsistent receipt; manual recovery required', 503);
      entries.push({ event, snapshot: record.snapshot ?? record.request.body.snapshot });
    }
  }
  for (const { event } of entries) {
    if (published.has(event.id)) continue;
    appendEvent(directory, 'results.jsonl', event); events.push(event); published.set(event.id, event);
  }
  return { records, entries, inputs: entries.map((entry) => entry.event), events };
}

export function requireDeliveryRead(items, entries, snapshot, action = 'approve') {
  for (const item of items) {
    if (!chatOnly(item) || !isArchiveAction(item, action)) continue;
    if (deliveryOf(item).completeness !== 'complete') fail('Read gate: chat-only delivery is incomplete or unknown; request complete answers', 409);
    if (!entries.some((entry) => entry.snapshot === snapshot && entry.event.kind === 'read' && entry.event.item_ids.length === 1 && entry.event.item_ids[0] === item.id && entry.event.deliverable === deliveryIdentity(item))) fail('Read gate: expand the complete answers and Mark read before archive', 409);
  }
}

export function workHistory(input, events) {
  return events.filter((event) => event.decision_id === input.id && event.id !== input.id);
}

export function executionResult(input, events) { return workHistory(input, events).filter((event) => event.kind === 'status' && event.status !== 'reply').at(-1); }

export function controlledIds(inputs) {
  return new Set(inputs.filter((input) => input.kind === 'control').map((input) => input.target_id));
}

export function outstandingInputs(inputs, events) {
  const controlled = controlledIds(inputs);
  return inputs.filter((input) => {
    if (input.kind === 'control' || controlled.has(input.id) || input.action === 'stop') return false;
    if (input.kind === 'compensation') return !compensationSucceeded(input, events);
    return input.kind === 'decision' && !isMessage(input.action);
  });
}

export function reversalPlan(input, inputs, events, mode = 'undo') {
  if (!input || !['decision', 'thread'].includes(input.kind) || input.action === 'stop') fail('This request cannot be controlled', 409);
  if (controlledIds(inputs).has(input.id)) fail('Already withdrawn or changed; inspect its linked requests', 409);
  const history = workHistory(input, events);
  const overlap = outstandingInputs(inputs, events).some((other) => other.id !== input.id && other.item_ids.some((id) => input.item_ids.includes(id)));
  if (mode === 'change' && overlap) fail('Other same-item work exists; reconcile all affected requests first', 409);
  if (history.some((event) => event.status === 'merged' || event.outcomes?.some((outcome) => outcome.status === 'merged'))) fail('Merge is not reversible', 409);
  if (history.some((event) => event.status === 'closed' || event.outcomes?.some((outcome) => outcome.status === 'closed'))) fail('PR closure needs separate reopen authorization; no automatic rollback', 409);
  const withdrawal = { action: 'withdraw', items: [] };
  if (!history.some((event) => event.status === 'rechecking')) return withdrawal;
  const last = executionResult(input, events);
  if (last.status === 'rechecking') fail('Running work cannot be interrupted; inspect its outcome first', 409);
  if (last.status === 'no_effect') return withdrawal;
  if (['decline', 'defer'].includes(input.action) && ['done', 'declined', 'deferred'].includes(last.status)) {
    if (history.some((event) => [event.status, ...(event.outcomes ?? []).map((outcome) => outcome.status)].some((status) => ['archived', 'sent', 'waiting', 'reply'].includes(status)))) fail('Unexpected external effects require manual reconciliation', 409);
    return withdrawal;
  }
  if (overlap && !isMessage(input.action)) fail('Other same-item work exists; reconcile all affected requests first', 409);
  if (input.items.length > 1 && !last.outcomes) fail('Bulk outcome needs complete per-target receipts before compensation; partial effects may exist', 409);
  const affected = [];
  let action = 'withdraw';
  for (const item of input.items) {
    const status = last.outcomes ? last.outcomes.find((outcome) => outcome.item_id === item.id)?.status : last.status;
    if (status === 'no_effect') continue;
    if (status === 'archived' && isArchiveAction(item, input.action)) action = 'unarchive';
    else if (isMessage(input.action) && ['sent', 'waiting', 'reply'].includes(status)) action = 'cancel_followup';
    else fail('Outcome is blocked, mixed or unknown; external effects may exist. Reconcile every target before undo/change', 409);
    affected.push(item);
  }
  return { action, items: affected };
}

export function compensationSucceeded(input, events) {
  const last = executionResult(input, events);
  const expected = input.action === 'unarchive' ? 'unarchived' : 'cancelled';
  return last?.status === expected && Array.isArray(last.outcomes) && last.outcomes.length === input.item_ids.length && new Set(last.outcomes.map((outcome) => outcome.item_id)).size === input.item_ids.length && last.outcomes.every((outcome) => input.item_ids.includes(outcome.item_id) && outcome.status === expected);
}
export function compensationCurrent(input, events) {
  if (input.kind !== 'compensation') return true;
  const index = events.findIndex((event) => event.id === input.effect_receipt_id && event.decision_id === input.target_id);
  if (index === -1) return false;
  const effect = events[index];
  const expected = input.action === 'unarchive' ? ['archived'] : ['sent', 'waiting', 'reply'];
  if (!input.item_ids.every((id) => expected.includes(effect.outcomes ? effect.outcomes.find((outcome) => outcome.item_id === id)?.status : effect.status))) return false;
  return input.action !== 'unarchive' || !events.slice(index + 1).some((event) => event.decision_id !== input.target_id && input.item_ids.some((id) => event.item_ids.includes(id) && (event.outcomes ? event.outcomes.some((outcome) => outcome.item_id === id && outcome.status === 'archived') : event.status === 'archived')));
}
export function dependencyReady(input, inputs, events) {
  if (!input.depends_on) return true;
  const dependency = inputs.find((entry) => entry.id === input.depends_on);
  if (!dependency || dependency.kind !== 'compensation') fail('Invalid compensation dependency', 503);
  return compensationSucceeded(dependency, events) && compensationCurrent(dependency, events);
}

export function validateOutcomes(input, status, outcomes) {
  if (outcomes === undefined) {
    if (input.kind === 'compensation' && ['unarchived', 'cancelled'].includes(status)) fail('Successful compensation requires complete structured per-target outcomes');
    return;
  }
  if (!Array.isArray(outcomes) || outcomes.length !== input.item_ids.length || new Set(outcomes.map((entry) => entry.item_id)).size !== outcomes.length) fail('Outcomes must cover every claimed target exactly once');
  for (const entry of outcomes) {
    exactObject(entry, ['item_id', 'status', 'text']); boundedText(entry.text);
    if (!input.item_ids.includes(entry.item_id) || !STATES.includes(entry.status) || entry.status === 'rechecking') fail('Invalid per-target outcome');
    if (!['done', 'blocked'].includes(status) && entry.status !== status) fail('Aggregate status contradicts per-target outcomes');
  }
}

export function blockedEvent(input, gate, who, unblock) {
  boundedText(gate); boundedText(who); boundedText(unblock);
  const event = statusEvent(input, 'blocked', unblock);
  return { ...event, verification: { gate, observed_at: event.at, who, unblock }, text: `gate=${gate}; observed_at=${event.at}; who=${who}; unblock=${unblock}` };
}

export function statusEvent(input, status, text) {
  if (!STATES.includes(status)) fail('Invalid result status');
  boundedText(text);
  return { id: randomUUID(), decision_id: input.id, item_ids: input.item_ids,
    kind: status === 'reply' ? 'thread' : 'status', action: input.action, status, text,
    at: new Date().toISOString(), author: 'agent' };
}

export function cliArgs(args, names) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const name = arg.slice(2);
    if (!names.includes(name) || Object.hasOwn(options, name) || !args[index + 1] || args[index + 1].startsWith('--')) fail('Invalid or duplicate CLI option');
    options[name] = args[++index];
  }
  return { options, positionals };
}
