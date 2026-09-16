import { constants, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, mkdirSync, lstatSync, realpathSync, unlinkSync, ftruncateSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const MAX_BODY = 8 * 1024 * 1024;
export const MAX_FEED = 4 * 1024 * 1024;
export const MAX_RECORD = 16 * 1024 * 1024;
export const MAX_LOG = 64 * 1024 * 1024;
export const STATES = ['rechecking', 'done', 'archived', 'merged', 'blocked', 'reply', 'deferred', 'declined', 'waiting', 'stopped'];

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
  const release = exclusiveFile(directory, '.ledger.lock');
  try { return callback(); } finally { release(); }
}

export function readLog(directory, name) {
  const fd = privateFile(join(directory, name), constants.O_RDONLY | constants.O_CREAT);
  try {
    if (fstatSync(fd).size > MAX_LOG) fail('Queue log is full', 507);
    const text = readDescriptor(fd, MAX_LOG);
    if (text && !text.endsWith('\n')) fail('Incomplete queue log; manual recovery required', 503);
    if (!text) return [];
    const lines = text.slice(0, -1).split('\n');
    if (lines.length > 100000) fail('Too many queue records', 507);
    return lines.map((line) => {
      if (!line || Buffer.byteLength(line) > MAX_RECORD) fail('Invalid queue record; manual recovery required', 503);
      try { return JSON.parse(line); } catch { fail('Invalid queue JSON; manual recovery required', 503); }
    });
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

export function writeServerFile(directory, value) {
  const fd = privateFile(join(directory, 'server.json'), constants.O_WRONLY | constants.O_CREAT);
  try {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    ftruncateSync(fd, 0);
    if (writeSync(fd, bytes) !== bytes.length) fail('Incomplete server metadata write', 503);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function existingReceipt(directory, inputs, request) {
  const existing = inputs.find((entry) => entry.event.id === request.body?.id);
  if (!existing) return null;
  if (!isDeepStrictEqual(existing.request, request)) fail('Request id already used for a different body or route', 409);
  const published = readLog(directory, 'results.jsonl').find((event) => event.id === existing.event.id);
  if (published && !isDeepStrictEqual(published, existing.event)) fail('Inconsistent receipt; manual recovery required', 503);
  if (!published) appendEvent(directory, 'results.jsonl', existing.event);
  return existing.event;
}

export function enqueue(directory, request, event) {
  const input = { request, event };
  checkAppend(directory, 'decisions.jsonl', input);
  checkAppend(directory, 'results.jsonl', event);
  appendEvent(directory, 'decisions.jsonl', input);
  appendEvent(directory, 'results.jsonl', event);
  return event;
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
