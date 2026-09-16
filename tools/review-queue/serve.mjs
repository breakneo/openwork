import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFeed, applyDecision, isLocked, recommendationVerb } from './core.mjs';
import { buildHtml } from './build.mjs';
import { MAX_BODY, MAX_FEED, boundedText, requestId, exactObject, fail, privateDirectory, readBounded, exclusiveFile, withLedger, readLog, writeServerFile, existingReceipt, enqueue, cliArgs } from './protocol.mjs';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function singleHeader(request, name) {
  let value;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() !== name) continue;
    if (value !== undefined) fail('Duplicate security header', 403);
    value = request.rawHeaders[index + 1];
  }
  return value;
}

function authenticate(request, token) {
  const value = singleHeader(request, 'x-review-token');
  if (typeof value !== 'string' || Buffer.byteLength(value) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(token))) fail('Unauthorized', 401);
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') ||
      request.headers['content-encoding'] !== undefined) fail('Use unencoded application/json', 415);
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) fail('Request is too large', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) fail('Request is too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail('Invalid JSON'); }
}

function routeFor(method, path) {
  if (method === 'GET' && ['/', '/index.html', '/server.json', '/feed'].includes(path)) return path;
  if (method === 'GET' && /^\/results(?:\?since=(?:0|[1-9]\d*))?$/.test(path)) return '/results';
  if (method === 'POST' && path === '/decisions') return path;
  if (method === 'POST' && /^\/threads\/[^/?#]+$/.test(path)) return '/threads';
  fail('Not found', 404);
}

export async function startServer({ feed: feedPath, dir = 'reports/review-queue', token = randomBytes(32).toString('base64url') }) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token)) fail('Token must contain 32–512 printable non-space ASCII characters');
  if (typeof feedPath !== 'string' || !feedPath) fail('--feed is required');
  const feed = freeze(validateFeed(JSON.parse(readBounded(resolve(feedPath), MAX_FEED))));
  const snapshot = JSON.stringify({ ...feed, decisions: [] });
  const template = readBounded(join(sourceDirectory, 'template.html'), 10_000_000);
  const offlineDirective = "connect-src 'none'";
  if (template.split(offlineDirective).length !== 2) fail('Template must contain one offline connection policy');
  // The unauthenticated bootstrap contains no private source data; /feed requires the token.
  const html = buildHtml({ items: [], decisions: [] }, template.replace(offlineDirective, "connect-src 'self'"),
    readBounded(join(sourceDirectory, 'core.mjs'), 10_000_000), readBounded(join(sourceDirectory, 'ui.js'), 10_000_000));
  const directory = privateDirectory(dir);
  const release = exclusiveFile(directory, '.server.lock');
  let origin;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 1000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', CSP);
    const send = (status, value, isHtml = false) => {
      response.writeHead(status, { 'Content-Type': isHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
      response.end(isHtml ? value : JSON.stringify(value));
    };
    try {
      if (singleHeader(request, 'host') !== origin.slice('http://'.length)) fail('Invalid Host', 403);
      const requestOrigin = singleHeader(request, 'origin');
      if ((requestOrigin !== undefined && requestOrigin !== origin) || (request.method === 'POST' && requestOrigin !== origin)) fail('Invalid Origin', 403);
      const site = singleHeader(request, 'sec-fetch-site');
      if (site !== undefined && !['same-origin', 'none'].includes(site)) fail('Cross-site request denied', 403);
      const path = request.url;
      const route = routeFor(request.method, path);
      if (route === '/' || route === '/index.html') { send(200, html, true); return; }
      authenticate(request, token);
      if (route === '/server.json') { send(200, { origin, token }); return; }
      if (route === '/feed') { send(200, feed); return; }
      if (route === '/results') {
        const since = path.includes('?') ? Number(path.slice(path.indexOf('=') + 1)) : 0;
        if (!Number.isSafeInteger(since)) fail('Invalid cursor');
        const result = withLedger(directory, () => {
          const events = readLog(directory, 'results.jsonl');
          if (since > events.length) fail('Cursor is beyond the log', 409);
          return { cursor: events.length, events: events.slice(since) };
        });
        send(200, result);
        return;
      }
      const body = await readBody(request);
      const receipt = withLedger(directory, () => {
        const inputs = readLog(directory, 'decisions.jsonl');
        const events = readLog(directory, 'results.jsonl');
        const savedRequest = { route: path, body };
        const existing = existingReceipt(directory, inputs, savedRequest);
        if (existing) return existing;
        if (events.some((event) => event.id === body?.id)) fail('Request id conflicts with an existing event', 409);
        if (route === '/decisions') {
          exactObject(body, ['id', 'ids', 'action', 'comment', 'decided_at', 'snapshot']);
          requestId(body.id);
          boundedText(body.comment, false);
          if (typeof body.snapshot !== 'string') fail('Invalid snapshot');
          if (body.snapshot !== snapshot) fail('Stale snapshot; restart for feed updates and review again', 409);
          const previous = [...feed.decisions, ...inputs.filter((input) => input.event.kind === 'decision' && input.request.body.snapshot === snapshot).flatMap((input) => input.event.decisions)];
          const next = applyDecision({ ...feed, decisions: previous }, body.ids, body.action, body.comment, body.decided_at, body.id);
          const items = body.ids.map((id) => feed.items.find((item) => item.id === id));
          if (body.action === 'approve' && items.length > 1 && items.some((item) => recommendationVerb(item).toLowerCase().trim() === 'merge')) fail('Bulk merge approval is forbidden');
          return enqueue(directory, savedRequest, { id: body.id, decision_id: body.id, item_ids: body.ids,
            kind: 'decision', action: body.action, status: 'queued', text: body.comment, at: next.decisions.at(-1).decided_at,
            items, decisions: next.decisions.slice(previous.length) });
        }
        exactObject(body, ['id', 'text']);
        requestId(body.id, true);
        boundedText(body.text);
        let itemId;
        try { itemId = decodeURIComponent(path.slice('/threads/'.length)); } catch { fail('Invalid encoded item id'); }
        if (encodeURIComponent(itemId) !== path.slice('/threads/'.length)) fail('Item id must use canonical encodeURIComponent encoding');
        const item = feed.items.find((entry) => entry.id === itemId);
        if (!item) fail('Unknown item', 404);
        if (isLocked(item)) fail('Locked item cannot have threads');
        return enqueue(directory, savedRequest, { id: body.id, decision_id: body.id, item_ids: [item.id],
          kind: 'thread', action: body.text.trim().toLowerCase() === 'stop' ? 'stop' : 'ask_info', status: 'queued',
          text: body.text, at: new Date().toISOString(), items: [item], decisions: [], author: 'human' });
      });
      send(200, receipt);
    } catch (error) {
      if (response.destroyed) return;
      response.setHeader('Connection', 'close');
      const status = Number.isInteger(error.status) ? error.status : 400;
      send(status, { error: ['EACCES', 'EIO', 'ENOSPC', 'ELOOP'].includes(error.code) ? 'Queue storage unavailable; manual inspection required' : error.code ? 'Queue storage error' : error.message });
    }
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  server.on('close', release);
  try {
    withLedger(directory, () => { readLog(directory, 'decisions.jsonl'); readLog(directory, 'results.jsonl'); });
    await new Promise((ready, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); ready(); });
    });
    const address = server.address();
    origin = `http://127.0.0.1:${address.port}`;
    writeServerFile(directory, { origin, token });
    return { server, origin, token, directory, url: `${origin}/#token=${encodeURIComponent(token)}` };
  } catch (error) {
    if (server.listening) await new Promise((done) => server.close(done));
    else release();
    throw error;
  }
}

async function main(args) {
  const { options, positionals } = cliArgs(args, ['feed', 'dir', 'token']);
  if (positionals.length || !options.feed) fail('Usage: serve.mjs --feed PATH [--dir PATH] [--token TOKEN]');
  const live = await startServer({ feed: options.feed, dir: options.dir, token: options.token });
  console.log(live.url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { live.server.close(); live.server.closeAllConnections(); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
