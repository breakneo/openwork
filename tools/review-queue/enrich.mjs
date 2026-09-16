import { readFileSync, existsSync, copyFileSync, chmodSync, constants } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFeed, safeUrl, isLocked, recommendationVerb, hasConcreteQuestion } from './core.mjs';
import { tables, linksIn, parseQueueArgs, privateOutputPath, writePrivateOutput } from './convert.mjs';

const fields = ['purpose', 'delivered', 'status_on_dev', 'why', 'if_approved', 'if_declined', 'question'];
const defaults = new Set(['Purpose not supplied.', 'No delivery summary supplied.', 'Not verified on dev.', 'No rationale supplied.']);
const clean = (text) => text.replace(/\[([^\]]+)\]\((?:https?:\/\/)[^\s)]+\)/g, '$1').replace(/\*\*|`/g, '').trim();
const bounded = (text, max = 20000) => text.length > max ? text.slice(0, max - 14) + ' … [truncated]' : text;
const fact = (label, value) => ({ label, value: bounded(String(value ?? 'Unknown — not supplied.')) });
const useful = (value) => typeof value === 'string' && value.trim() && !defaults.has(value) && !value.startsWith('No rationale supplied.');
const unique = (entries) => [...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values()];
const rawFacts = (entries) => {
  const result = unique(entries);
  return result.length <= 100 ? result : [...result.slice(0, 99), fact('Additional source facts', `${result.length - 99} omitted; consult original inputs.`)];
};
function textInput(value, label, max = 20000000) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`${label} must be bounded text`);
  return value;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be an object`);
  return value;
}
function evidenceList(value, label) {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be a bounded evidence array`);
  return validateFeed({ items: [{ id: 'validation', kind: 'proposal', title: 'Validation', recommended_action: 'keep', evidence: value }] }).items[0].evidence;
}
function prNumber(item) {
  const url = item.pr_url ?? (item.kind === 'pr' && item.id.startsWith('https://') ? item.id : undefined);
  if (url) {
    const parsed = new URL(url);
    if (parsed.hostname === 'github.com') return Number(parsed.pathname.match(/\/pull\/(\d+)\/?$/)?.[1]) || undefined;
  }
  return item.kind === 'pr' ? Number(item.id.match(/^pr-(\d+)$/)?.[1]) || undefined : undefined;
}
export function parsePrRecords(jsonl = '') {
  textInput(jsonl, 'PR JSONL', 50000000);
  const records = new Map();
  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid PR JSONL at line ${index + 1}`); }
    object(value, `PR line ${index + 1}`);
    if (!Number.isSafeInteger(value.number) || value.number < 1) throw new Error(`Invalid PR identity at line ${index + 1}`);
    for (const key of ['state', 'title', 'headRefOid', 'baseRefName', 'headRefName', 'mergeStateStatus', 'mergeable', 'reviewDecision', 'capturedAt', 'mergedAt']) {
      if (value[key] !== undefined && value[key] !== null) textInput(value[key], `PR ${key}`, 20000);
    }
    for (const key of ['isDraft', 'wardenAtHead']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`PR ${key} must be boolean`);
    for (const key of ['failingChecks', 'pendingChecks']) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 1000)) throw new Error(`PR ${key} must be a bounded array`);
    if (value.url !== undefined) {
      const safe = safeUrl(value.url);
      if (!safe) throw new Error('PR URL must be safe');
      const url = new URL(safe);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.search || url.hash || !new RegExp(`^/[^/]+/[^/]+/pull/${value.number}/?$`).test(url.pathname)) throw new Error('PR URL disagrees with its identity');
    }
    const previous = records.get(value.number);
    if (previous?.url && value.url && previous.url.toLowerCase() !== value.url.toLowerCase()) throw new Error('PR number collides across repositories');
    const before = Date.parse(previous?.capturedAt);
    const after = Date.parse(value.capturedAt);
    if (!Number.isFinite(before) || !Number.isFinite(after) || after >= before) records.set(value.number, value);
  }
  return records;
}
function reportIndex(markdown) {
  const sessions = new Map();
  const prs = new Map();
  const models = new Map();
  const rowNames = new Map();
  for (const table of tables(markdown)) {
    const headers = table.headers;
    const session = headers.findIndex((header) => /^Session(?: ID)?$/i.test(header));
    const pr = headers.findIndex((header) => /^PR$/i.test(header));
    const key = headers.findIndex((header) => /^Key$/i.test(header));
    for (const row of table.rows) {
      const values = Object.fromEntries(headers.map((header, index) => [header, clean(row.cells[index])]));
      if (key >= 0 && headers.includes('providerId') && headers.includes('modelId')) models.set(clean(row.cells[key]), values);
      if (session >= 0) {
        const id = clean(row.cells[session]);
        if (!/^ses_[A-Za-z0-9]+$/.test(id)) continue;
        if (values.Row && values.Title) rowNames.set(values.Row, { id, title: values.Title });
        const previous = sessions.get(id) ?? [];
        sessions.set(id, [...previous, { values, line: row.line, heading: table.heading, links: linksIn(row.cells.join(' ')) }]);
      }
      if (pr >= 0) {
        const number = Number(clean(row.cells[pr]).match(/^#?(\d+)\b/)?.[1]);
        if (number) prs.set(number, [...(prs.get(number) ?? []), { values, line: row.line, heading: table.heading, links: linksIn(row.cells.join(' ')) }]);
      }
    }
  }
  const prose = new Map();
  let excluded = false;
  for (const block of markdown.split(/\r?\n\s*\r?\n/)) {
    if (/^#{1,6} /.test(block)) excluded = /External mission|prior .*findings|STALE-BOUND|reclaimable candidates/i.test(block);
    if (excluded || block.trim().startsWith('|') || block.includes('```')) continue;
    for (const line of block.split(/\r?\n/)) {
      if (/^#{1,6} /.test(line)) continue;
      const owners = new Set([...line.matchAll(/\bses_[A-Za-z0-9]+\b/g)].map((match) => match[0]));
      for (const match of line.matchAll(/\b[OC]\d{2}\b/g)) if (rowNames.has(match[0])) owners.add(rowNames.get(match[0]).id);
      if (owners.size !== 1) continue;
      const [id] = owners;
      prose.set(id, [...(prose.get(id) ?? []), clean(line.replace(/^\s*[-*]\s*/, ''))]);
    }
  }
  const dateContext = markdown.match(/session dates(?: below)? are\s+(\d{4})\s+(EDT|EST|UTC|GMT)\b/i);
  return { sessions, prs, models, rowNames, prose, year: dateContext?.[1], timeZone: dateContext?.[2].toUpperCase() };
}
function human(text, index) {
  return bounded(clean(text).replace(/^(?:[ADL]|Archive|Decision|Relaunch|Keep);\s*/i, '').replace(/\b[OC]\d{2}\b/g, (key) => index.rowNames.get(key)?.title ?? 'another report row').replace(/\bSTALE-BOUND\b/g, 'bound to a stale provider').replace(/\bCONCLUDED\b/g, 'conversation concluded (not product certification)').replace(/\bINTERRUPTED\b/g, 'conversation interrupted').replace(/\bDIRTY\b/g, 'conflicting').replace(/\bBLOCKED\b/g, 'blocked on merge or review gates').replace(/\bMERGED\b/g, 'merged').replace(/\bCLOSED\b/g, 'closed').replace(/\bOPEN\b/g, 'open'));
}
function changeTitle(title, index) {
  return human(title.replace(/^#\d+\s*(?:[—–-]\s*)?/, '').replace(/^(?:feat|fix|chore|docs|test|ci)(?:\([^)]*\))?:\s*/, ''), index);
}
function cells(rows, pattern) {
  return rows.flatMap((row) => Object.entries(row.values).filter(([key]) => pattern.test(key)).map(([, value]) => value));
}
function friendlyModel(value, index, stale) {
  const code = typeof value === 'string' ? value.match(/(?:^|;\s*)(IC|IA|IY|BP)\s*(?:\/|$)/)?.[1] ?? value.split(/\s*\/\s*/)[0].trim() : undefined;
  const model = typeof value === 'object' && value !== null ? value : index.models.get(code);
  if (stale || model?.providerId?.startsWith('lpr_') || (typeof value === 'string' && /\blpr_/.test(value))) return 'Stale provider — deleted 09-11; no new provider test was made.';
  if (['IC', 'IA', 'IY'].includes(code)) return 'Organization default GPT — exact alias not established.';
  if (code === 'BP' || model?.modelId === 'big-pickle') return 'Big Pickle';
  if (code === 'null' || value === null) return 'No model binding in the snapshot.';
  if (model?.displayName) return model.displayName;
  if (model?.providerId?.startsWith('ipr_') || model?.modelId?.startsWith('gwm_')) return 'Organization-provided model — friendly name unknown.';
  if (model?.modelId) return `${model.modelId}${model.providerId ? ` (${model.providerId})` : ''}`;
  return 'Unknown — no readable model binding supplied.';
}
function summaryItems(raw) {
  object(raw, 'Summaries');
  const items = raw.items === undefined ? Object.entries(raw).map(([id, entry]) => ({ ...object(entry, 'Summary entry'), id })) : raw.items;
  if (!Array.isArray(items) || items.length > 10000) throw new Error('Summaries items must be a bounded array');
  return items;
}
export function combineSummaries(documents) {
  if (!Array.isArray(documents) || documents.length > 1000) throw new Error('Summary documents must be a bounded array');
  const items = documents.flatMap(summaryItems);
  if (items.length > 10000) throw new Error('Combined summaries exceed the item limit');
  const ids = new Set();
  for (const item of items) {
    object(item, 'Summary entry');
    textInput(item.id, 'Summary ID', 4096);
    if (ids.has(item.id)) throw new Error('Duplicate summary ID across supplied documents');
    ids.add(item.id);
  }
  return { items };
}
function summariesIndex(raw, ids) {
  if (raw === undefined) return new Map();
  const items = summaryItems(raw);
  const result = new Map();
  for (const entry of items) {
    object(entry, 'Summary entry');
    textInput(entry.id, 'Summary ID', 4096);
    if (!ids.has(entry.id)) throw new Error('Summary ID is not in the input feed');
    if (result.has(entry.id)) throw new Error('Duplicate summary ID');
    const selected = {};
    for (const key of [...fields, 'last_user', 'last_assistant', 'source', 'observed_at']) if (entry[key] !== undefined) selected[key] = textInput(entry[key], `Summary ${key}`, key.startsWith('last_') ? 200000 : 20000);
    for (const key of ['evidence', 'raw_evidence']) if (entry[key] !== undefined) selected[key] = evidenceList(entry[key], `Summary ${key}`);
    if (entry.links !== undefined) selected.links = validateFeed({ items: [{ id: 'validation', kind: 'proposal', title: 'Validation', recommended_action: 'keep', links: entry.links }] }).items[0].links;
    if (entry.options !== undefined) {
      if (!Array.isArray(entry.options) || entry.options.length > 12 || !selected.question?.trim()) throw new Error('Summary options require a question and at most 12 text choices');
      selected.options = entry.options.map((option) => textInput(option, 'Summary option', 2000));
    }
    if (entry.model !== undefined) {
      if (entry.model === null || typeof entry.model === 'string') selected.model = entry.model === null ? null : textInput(entry.model, 'Summary model', 2000);
      else {
        object(entry.model, 'Summary model');
        selected.model = {};
        for (const key of ['providerId', 'modelId', 'displayName', 'variant']) if (entry.model[key] !== undefined && entry.model[key] !== null) selected.model[key] = textInput(entry.model[key], `Summary model ${key}`, 2000);
      }
    }
    result.set(entry.id, selected);
  }
  return result;
}
function checks(pr) {
  if (!pr) return 'Unknown — no PR check snapshot supplied.';
  const names = (values) => values.map((value) => typeof value === 'string' ? value : value?.name ?? 'unnamed check').join(', ');
  const failing = Array.isArray(pr.failingChecks) ? pr.failingChecks : undefined;
  const pending = Array.isArray(pr.pendingChecks) ? pr.pendingChecks : undefined;
  if (!failing || !pending) return 'Unknown — failing and pending check inventories were not both supplied.';
  return `${failing.length ? `Failing: ${names(failing)}` : 'No failing checks recorded'}; ${pending.length ? `pending: ${names(pending)}` : 'no pending checks recorded'}. Snapshot only; not proof of required-test coverage.`;
}
function warden(pr) {
  if (pr?.wardenAtHead === true) return 'Approved at the captured PR head (source register). Not human approval.';
  if (pr?.wardenAtHead === false) return 'No Warden approval at the captured PR head.';
  return 'Unknown — exact-head Warden approval not supplied.';
}
function reportProof(rows, pr) {
  return rows.flatMap((row) => {
    const results = cells([row], /Fresh local result|Actual final.head checks|Remaining gate|Fresh verification/i);
    const heads = cells([row], /^(?:Exact head|Published head|Head)$/i).filter((value) => /^[a-f0-9]{7,40}$/i.test(value));
    const mismatch = pr?.headRefOid && heads.some((head) => !pr.headRefOid.startsWith(head));
    return results.map((result) => `${mismatch ? 'Historical proof at a different head; not verification of this head: ' : 'Report: '}${result}`);
  }).join('\n');
}
function prStatus(pr, rows) {
  const result = reportProof(rows, pr);
  if (!pr) return `Unknown — no PR state snapshot supplied.${result ? ` Report says: ${result}` : ''}`;
  const collected = typeof pr.capturedAt === 'string' ? ` Captured ${pr.capturedAt}; not live.` : ' Collection time unknown; not live.';
  if (pr.state === 'MERGED') return `Merged ${typeof pr.mergedAt === 'string' ? pr.mergedAt : '(date unknown)'} into ${pr.baseRefName ?? 'an unknown base'}.${pr.baseRefName === 'dev' ? ' Recorded as landed on dev; deployment and current behavior are not verified.' : ' Presence on dev is unknown.'}${collected}`;
  if (pr.state === 'CLOSED') return `Closed without a recorded merge; do not treat this PR as landed on dev.${collected}`;
  if (pr.state !== 'OPEN') return `Unknown PR state; presence on dev is not verified.${collected}`;
  const gates = [];
  if (pr.isDraft === true) gates.push('draft, not ready for merge');
  else if (pr.isDraft !== false) gates.push('draft status unknown');
  if (pr.mergeStateStatus === 'DIRTY' || pr.mergeable === 'CONFLICTING') gates.push('conflicts at the captured base');
  else if (pr.mergeStateStatus && pr.mergeStateStatus !== 'CLEAN') gates.push(`merge gate: ${pr.mergeStateStatus.toLowerCase().replaceAll('_', ' ')}`);
  if (pr.baseRefName !== 'dev') gates.push(pr.baseRefName ? `stacked on ${pr.baseRefName}; dev integration not implied` : 'base unknown');
  if (pr.wardenAtHead !== true) gates.push(warden(pr));
  if (pr.reviewDecision === 'REVIEW_REQUIRED') gates.push('review required');
  if (pr.reviewDecision === 'CHANGES_REQUESTED') gates.push('changes requested');
  const green = Array.isArray(pr.failingChecks) && !pr.failingChecks.length && Array.isArray(pr.pendingChecks) && !pr.pendingChecks.length;
  return bounded(`Open${green ? ' with no failing or pending checks recorded' : ''}; not recorded as merged. ${checks(pr)}${gates.length ? ` Remaining gates: ${gates.join('; ')}.` : ''}${result ? ` Applicable proof/report: ${result}` : ' Applicable spec results unknown.'}${collected}`);
}
function historicalTracker(markdown, number) {
  if (!number) return [];
  const result = [];
  for (const line of markdown.split(/\r?\n/)) {
    const refs = [...line.matchAll(/#(\d+)\b/g)];
    for (let index = 0; index < refs.length; index++) {
      if (Number(refs[index][1]) !== number) continue;
      const fragment = clean(line.slice(refs[index].index, refs[index + 1]?.index));
      if (fragment.length > String(number).length + 2) result.push(fragment);
    }
  }
  return result;
}
function diffStat(pr, historical) {
  if (Number.isSafeInteger(pr?.additions) && pr.additions >= 0 && Number.isSafeInteger(pr?.deletions) && pr.deletions >= 0) return `+${pr.additions} / −${pr.deletions}${Number.isSafeInteger(pr.changedFiles) ? `; ${pr.changedFiles} files` : ''} (captured PR diff).`;
  const entry = historical.findLast((line) => /\+[\d,]+\s*\/\s*[−-][\d,]+/.test(line));
  return entry ? `${entry.match(/\+[\d,]+\s*\/\s*[−-][\d,]+/)[0]} — historical tracker; current-head diff not verified.` : 'Unknown — diff counts were not supplied.';
}
function lastMessageDate(extra, oldFacts, rows, index) {
  const entries = [...(extra.evidence ?? []), ...oldFacts];
  const supplied = entries.find((entry) => /^Last message date$/i.test(entry.label) && entry.value?.trim());
  if (supplied && /^(?:\d{4}-\d{2}-\d{2}(?:T|\s|$)|unknown\b)/i.test(supplied.value)) return { ...supplied, label: 'Last message' };
  const existingDate = entries.find((entry) => /^Last message$/i.test(entry.label) && /^\d{4}-\d{2}-\d{2}(?:T|\s|$)/.test(entry.value ?? ''));
  if (existingDate) return { ...existingDate, label: 'Last message' };
  for (const row of [...rows].reverse()) {
    for (const [header, value] of Object.entries(row.values)) {
      const zone = header.match(/^Updated\s+(EDT|EST|UTC|GMT)$/i)?.[1].toUpperCase();
      if (!zone) continue;
      const full = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/.test(value);
      const partial = /^\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/.test(value);
      if (full || (partial && index.year && index.timeZone === zone)) return fact('Last message', `${full ? value : `${index.year}-${value}`} ${zone} (report Updated ${zone}; snapshot metadata, not an independently established message timestamp)`);
    }
  }
  return fact('Last message', 'Unknown — last-message date with explicit year/timezone was not supplied.');
}
function prRationale(pr, rows, action, question) {
  if (pr?.state === 'MERGED') return 'This PR is recorded as merged, so it is a read-only delivery reference rather than a pending decision.';
  if (pr?.state === 'CLOSED') return 'This PR is recorded as closed without a merge, so retain its work as a read-only reference rather than offer a merge decision.';
  if (pr?.state !== 'OPEN') return 'Retain this PR for reference because its recorded status and current merge eligibility are unknown.';
  if (recommendationVerb({ recommended_action: action }) === 'none') return 'This open PR is marked read-only by its source, so no decision or automatic action is available from this queue.';
  const gates = [];
  if (pr.isDraft === true) gates.push('it is still a draft');
  if (pr.mergeStateStatus === 'DIRTY' || pr.mergeable === 'CONFLICTING') gates.push('the captured base has conflicts');
  if (pr.failingChecks?.length) gates.push(`captured checks fail (${pr.failingChecks.map((check) => typeof check === 'string' ? check : check?.name ?? 'unnamed check').join(', ')})`);
  if (pr.pendingChecks?.length) gates.push('captured checks are pending');
  if (pr.baseRefName && pr.baseRefName !== 'dev') gates.push('its stack base is not dev');
  if (pr.wardenAtHead === false) gates.push('exact-head Warden approval is absent');
  else if (pr.wardenAtHead !== true) gates.push('exact-head Warden approval is unknown');
  if (!Array.isArray(pr.failingChecks) || !Array.isArray(pr.pendingChecks)) gates.push('the check inventory is incomplete');
  if (pr.reviewDecision === 'REVIEW_REQUIRED' || pr.reviewDecision === 'CHANGES_REQUESTED') gates.push('required review remains unresolved');
  const boundRows = rows.filter((row) => {
    const heads = cells([row], /^(?:Exact head|Published head|Head)$/i).filter((head) => /^[a-f0-9]{7,40}$/i.test(head));
    return typeof pr.headRefOid === 'string' && heads.length && heads.every((head) => pr.headRefOid.startsWith(head));
  });
  const proof = reportProof(boundRows, pr);
  if (/\bincomplete\b|\bnot run\b|\bskipped\b|\d+\s+skip\b|unvalidated|outcome[:\s]+unknown|typecheck failed/i.test(proof)) gates.push('the captured-head report leaves proof incomplete');
  if (!proof) gates.push('applicable proof at the captured head is not established');
  if (action === 'keep' && !hasConcreteQuestion({ question })) gates.push('no concrete human question was supplied');
  if (gates.length) return bounded(`Keep this open PR under review because ${gates.join('; ')}; historical results at other heads are not current failures.`);
  if (recommendationVerb({ recommended_action: action }) === 'merge') return 'The captured checks and same-head report support reviewing this merge candidate, but LIVE gates and explicit per-PR authorization must still pass before a squash merge.';
  return 'The captured checks and same-head report support review of this open PR, while the human decision and LIVE merge eligibility remain separate.';
}
function conversationStatus(text) {
  if (/\bno (?:code|implementation) (?:change|work|was|is|requested)|\b(?:explanation|explainer|advice|book list|diagram|meeting note|email draft|gmail draft|research list|recap)\b/i.test(text)) return 'The supplied scope describes a conversation, research or document deliverable rather than a code delivery; dev integration is not applicable to that reported outcome, and any external-service completion remains a source claim.';
  return 'No associated PR is supplied for this conversation; code scope and dev integration are unknown, not a failed delivery.';
}
function sourceQuestion(text) {
  return text.split(/\n|(?<=[.!])\s+/).find((line) => /\?\s*$/.test(line) && /\b(should|would you|do you want|which|shall|can you confirm)\b/i.test(line)) ?? '';
}
export function enrichFeed(input, { report = '', reportSource, prs = '', tracker = '', summaries } = {}) {
  textInput(report, 'Report');
  if (reportSource !== undefined) textInput(reportSource, 'Report source', 4096);
  textInput(tracker, 'Tracker');
  const normalized = validateFeed(input);
  if (normalized.decisions.length || input.audit?.length || input.effective_decisions?.length || Object.keys(input.drafts ?? {}).length) throw new Error('Enrichment requires an undecided source feed; preserve decision exports separately and never replay them into changed evidence');
  const index = reportIndex(report);
  const records = parsePrRecords(prs);
  const details = summariesIndex(summaries, new Set(normalized.items.map((item) => item.id)));
  const items = normalized.items.map((item, position) => {
    const original = input.items[position];
    const external = item.group.toLowerCase().trim() === 'external-mission' || /^SUPAUD-\d{8}-/i.test(item.title) || /external mission|owned elsewhere/i.test(item.lock_reason ?? '');
    const locked = external || isLocked(item);
    const nightReview = /^NIGHT[\s_-]+REVIEW\b/i.test(item.title.trim());
    const extra = external ? {} : details.get(item.id) ?? {};
    const rows = external ? [] : index.sessions.get(item.id) ?? [];
    const number = prNumber(item);
    const pr = external ? undefined : records.get(number);
    if (pr?.url && item.pr_url && safeUrl(pr.url) !== safeUrl(item.pr_url)) throw new Error('PR metadata belongs to a different repository or identity');
    const prRows = external ? [] : index.prs.get(number) ?? [];
    const historical = external ? [] : historicalTracker(tracker, number);
    const linkedNumbers = external ? [] : [...item.links, ...(extra.links ?? [])].flatMap((link) => {
      const url = new URL(link.url);
      const linked = url.hostname === 'github.com' ? Number(url.pathname.match(/\/pull\/(\d+)\/?$/)?.[1]) : undefined;
      const record = records.get(linked);
      return linked && (!record?.url || new URL(record.url).pathname.replace(/\/$/, '') === url.pathname.replace(/\/$/, '')) ? [linked] : [];
    });
    const worktreeScope = item.kind === 'worktree' ? `Retain the local working copy${linkedNumbers.length === 1 && records.get(linkedNumbers[0])?.title ? ` for “${changeTitle(records.get(linkedNumbers[0]).title, index)}”` : ` named “${item.title}”`} until a separate ownership and removal review.` : '';
    const reportText = cells(rows, /deliverable|decision|recommendation/i).map((value) => human(value, index)).join('\n');
    const prose = external ? [] : index.prose.get(item.id) ?? [];
    const ownSummary = human(item.summary, index);
    const prDelivery = item.kind === 'pr' ? `PR change: ${changeTitle(pr?.title ?? item.title, index)}. ${pr?.state === 'MERGED' ? 'The register records this as merged, not independently verified in production.' : pr?.state === 'CLOSED' ? 'The register records this as closed without a merge.' : 'This is a proposed change, not a verified delivery on dev.'}` : '';
    const delivered = nightReview && !external ? report ? `Supplied night-review report${reportSource ? `: ${reportSource}` : ''}; historical findings and recommendations, not live verification.` : 'Night-review report not supplied; deliverable path and findings are unknown.' : extra.delivered ?? (useful(original.delivered) ? original.delivered : extra.last_assistant ? `Assistant reported: ${bounded(extra.last_assistant, 800)}` : reportText || [prDelivery, reportProof(prRows, pr)].filter(Boolean).join('\n') || ownSummary);
    const purpose = nightReview && !external ? 'Review overnight sessions and PRs and report what needs a human decision' : extra.purpose ?? (useful(original.purpose) ? original.purpose : extra.last_user ? `Last recorded request: ${bounded(extra.last_user, 800)}` : worktreeScope || `Scope: ${changeTitle(pr?.title ?? item.title, index)}.`);
    const raw = [...item.raw_evidence, ...item.evidence, ...(extra.raw_evidence ?? []), ...(extra.evidence ?? [])];
    for (const row of [...rows, ...prRows]) raw.push(fact('Report source', `${row.heading}, line ${row.line}`), ...Object.entries(row.values).map(([key, value]) => fact(key, value)));
    for (const text of prose) raw.push(fact('Report prose', text));
    for (const text of historical) raw.push(fact('Historical tracker', text));
    if (pr) raw.push(fact('PR snapshot', JSON.stringify(pr)));
    if (extra.status_on_dev) raw.push(fact('Summary dev-status claim', extra.status_on_dev));
    if (extra.why) raw.push(fact('Summary rationale', extra.why));
    if (extra.source) raw.push(fact('Summary source', extra.source));
    if (extra.observed_at) raw.push(fact('Summary observed at', extra.observed_at));
    const modelValue = extra.model !== undefined ? extra.model : cells(rows, /^Model|Observed state/i)[0] ?? item.evidence.find((entry) => /^Model(?: \/ variant)?$/i.test(entry.label))?.value;
    if (modelValue !== undefined) {
      raw.push(fact('Model binding', typeof modelValue === 'string' ? modelValue : JSON.stringify(modelValue)));
      const binding = typeof modelValue === 'string' ? index.models.get(modelValue.split(/\s*\/\s*/)[0]) : undefined;
      if (binding) raw.push(fact('Model key', JSON.stringify(binding)));
    }
    const oldFacts = [...item.evidence, ...item.raw_evidence];
    const guardFacts = unique([...oldFacts, ...(extra.evidence ?? [])].filter((entry) => /^(?:Workspace|Pinned|Status|State)$/i.test(entry.label)));
    if (pr && ['OPEN', 'MERGED', 'CLOSED'].includes(pr.state) && !guardFacts.some((entry) => entry.label === 'State' && entry.value === pr.state)) guardFacts.push(fact('State', pr.state));
    const sourceStates = guardFacts.filter((entry) => entry.label === 'State').map((entry) => entry.value?.toUpperCase());
    const completedPr = item.kind === 'pr' && (pr ? ['MERGED', 'CLOSED'].includes(pr.state) : sourceStates.some((state) => ['MERGED', 'CLOSED'].includes(state)));
    const chatWorkspace = item.group === 'OpenWork Chat' || guardFacts.some((entry) => entry.label === 'Workspace' && entry.value === 'OpenWork Chat') || rows.some((row) => /^OpenWork Chat\s*[—–-]/.test(row.heading));
    const suppliedFact = (label) => extra.evidence?.find((entry) => entry.label.toLowerCase() === label.toLowerCase()) ?? oldFacts.find((entry) => entry.label.toLowerCase() === label.toLowerCase());
    const readEvidence = (label, fallback) => suppliedFact(label) ?? fact(label, fallback);
    const specEvidence = (record, proofRows) => {
      const proof = reportProof(proofRows, record);
      if (proof) return proof;
      const historicalProof = historicalTracker(tracker, record?.number).findLast((line) => /\b(?:spec|tests?|typechecks?|assertions|skips?)\b/i.test(line));
      return historicalProof ? `Historical tracker, not current-head verification: ${bounded(historicalProof, 2000)}` : 'Unknown — applicable spec results not supplied.';
    };
    const specResults = reportProof(prRows, pr);
    const related = [...new Set([...linkedNumbers, ...[...(reportText + '\n' + ownSummary + '\n' + (extra.delivered ?? '')).matchAll(/#(\d+)\b/g)].map((match) => Number(match[1]))])];
    const associated = related.map((id) => ({ id, record: records.get(id) }));
    let status = prStatus(pr, prRows);
    if (item.kind !== 'pr') status = associated.length ? associated.map(({ id, record }) => `Referenced PR #${id}: ${prStatus(record, index.prs.get(id) ?? [])}`).join('\n') : item.kind === 'worktree' ? 'Worktree reference only. Dev inclusion and safe removal are not independently verified.' : conversationStatus([reportText, ownSummary, purpose, delivered, extra.status_on_dev].filter(Boolean).join('\n'));
    const associatedFact = (describe) => associated.map(({ id, record }) => `Referenced PR #${id}: ${describe(record, index.prs.get(id) ?? [])}`).join('\n');
    const currentEvidence = (label, describe, fallback) => pr ? fact(label, describe(pr, prRows)) : associated.length ? fact(label, associatedFact(describe)) : readEvidence(label, fallback);
    const conflicts = (record) => record?.mergeStateStatus === 'DIRTY' || record?.mergeable === 'CONFLICTING' ? 'Conflicts reported at the captured PR base.' : record?.mergeStateStatus === 'CLEAN' ? `No GitHub merge conflict at captured base ${record.baseRefName ?? '(unknown)'}. This is not a dev integration test.` : 'Unknown — current dev conflict check not supplied.';
    let question = extra.question ?? (hasConcreteQuestion(item) ? item.question : sourceQuestion(reportText || ownSummary));
    if (extra.options?.length) question += `\nOptions from source: ${extra.options.join(' / ')}`;
    let action = original.recommended_action ?? item.recommended_action;
    let why = extra.why ?? (useful(original.why) ? original.why : delivered ? `The source reports: ${delivered}` : 'There is no per-item outcome in the supplied sources; retain this item until its owner supplies a summary.');
    let approved = extra.if_approved ?? (useful(original.if_approved) ? original.if_approved : '');
    if (/^(?:unknown\b|not supplied\b|tbd\b|n\/?a\b|none[.!]?$)/i.test(approved.trim())) approved = '';
    let declined = extra.if_declined ?? (useful(original.if_declined) ? original.if_declined : 'Leave the item and its deliverables unchanged. Declining does not close a PR, delete files, or send a message.');
    const verb = recommendationVerb({ recommended_action: action });
    if (verb === 'review' && !hasConcreteQuestion({ question })) {
      action = 'keep'; question = ''; approved = '';
      why += ' Kept for reference: no concrete human question or source-backed choices were supplied. A coordinator summary is needed before review.';
    } else if (verb === 'review' && !approved.trim()) {
      approved = '';
      why += ' Approval is disabled: the source supplies a question but no concrete approval outcome.';
    } else if (verb === 'archive') {
      const outcome = chatWorkspace ? `Human-only archive decision for OpenWork Chat session ${item.id}; the audit must not archive this session.` : `Conditional audit.archive for session ${item.id} only after LIVE ownership, workspace identity, pin, running/descendant work, captured learnings, pending-decision and clean-worktree checks pass and current human authorization permits archival; otherwise leave it unchanged, with no automatic action.`;
      approved = [approved.trim(), outcome].filter(Boolean).join(' ');
    } else if (verb === 'merge') {
      approved = number ? [approved.trim(), `The audit may squash-merge PR #${number} only after LIVE exact-head/base/stack, OPEN/non-draft state, conflicts, required checks, applicable proof and reviews pass, plus explicit current per-PR human merge authorization; no automatic merge or bypass.`].filter(Boolean).join(' ') : '';
    } else if (!approved && verb === 'relaunch') approved = 'Record interest in the described follow-up. Confirm it has not already run and agree a separate scoped instruction before starting work.';
    if (item.kind === 'pr' && !completedPr) declined = `PR ${number ? `#${number}` : item.id} ${pr?.state === 'OPEN' ? 'stays open' : 'is left unchanged; its current state is unknown'}; no merge, closure, branch deletion or message is performed.`;
    if (item.kind !== 'pr' && associated.length && useful(extra.why)) why = `Source-summary rationale (not current PR verification): ${why}`;
    if (locked || completedPr) {
      question = ''; approved = '';
      declined = 'No decision is available; leave this read-only reference untouched.';
      why = item.lock_reason ?? (external ? 'External mission owned elsewhere; title/identity inventory only. No transcript enrichment or follow-up.' : 'Read-only reference. No approval, clarification, archive, relaunch or removal is allowed from this queue.');
    }
    if (completedPr) action = 'none';
    if (item.kind === 'pr' && !external) why = prRationale(pr ?? { state: sourceStates.find((state) => ['MERGED', 'CLOSED'].includes(state)) }, prRows, action, question);
    if (nightReview && !external) why = 'This is the reviewer’s own report of overnight findings, not a human decision; keep it read-only.';
    const curated = external ? [fact('Ownership', 'External mission; metadata only. No transcript reads or actions.')] : [
      currentEvidence('PR checks', checks, checks()),
      pr ? fact('Diff stat', diffStat(pr, historical)) : readEvidence('Diff stat', diffStat(undefined, historical)),
      currentEvidence('Spec results', specEvidence, specResults || 'Unknown — no applicable per-item spec results supplied. Changed spec filenames alone are not results.'),
      currentEvidence('Warden', warden, warden()),
      currentEvidence('Conflicts', conflicts, conflicts()),
      lastMessageDate(extra, oldFacts, rows, index),
      extra.last_assistant ? fact('Last assistant', bounded(extra.last_assistant, 800)) : readEvidence('Last assistant', 'Unknown — last assistant reply not supplied; report prose is not a transcript.'),
      ...(item.kind === 'session' ? [fact('Model', friendlyModel(modelValue, index, item.stale_bound))] : []),
      ...guardFacts,
      ...(extra.evidence ?? []).filter((entry) => !/^(?:PR checks|Diff stat|Spec results|Warden|Conflicts|Last message(?: date)?|Last assistant|Workspace|Pinned|Status|State)$/i.test(entry.label)),
    ];
    const links = [...item.links];
    for (const link of [...(extra.links ?? []), ...rows.flatMap((row) => row.links), ...prRows.flatMap((row) => row.links)]) if (!links.some((existing) => existing.url === link.url && existing.label === link.label)) links.push(link);
    const enriched = { ...item, purpose: bounded(purpose), delivered: bounded(external ? 'Identity/title inventory only; mission deliverables deliberately not inspected.' : delivered || 'Unknown — no deliverable summary supplied.'), status_on_dev: bounded(external ? 'Not inspected; external mission is read-only.' : nightReview ? 'Review report only; no implementation or dev deployment is asserted.' : pr || associated.some(({ record }) => record) ? status : extra.status_on_dev ?? (useful(original.status_on_dev) ? original.status_on_dev : status)), why: bounded(why), question: bounded(question), if_approved: bounded(approved), if_declined: bounded(declined), recommended_action: action, evidence: unique(curated).map((entry) => /^(?:Last message|Last assistant)$/i.test(entry.label) && entry.value !== undefined ? { ...entry, value: bounded(entry.value, 800) } : entry), raw_evidence: rawFacts(raw), links };
    if (locked || completedPr) { enriched.locked = true; enriched.protected = true; }
    if (external) { enriched.group = 'external-mission'; enriched.recommended_action = 'none'; }
    if (pr) {
      if (typeof pr.headRefOid === 'string') enriched.head_sha = pr.headRefOid;
      else delete enriched.head_sha;
      if (pr.state !== 'OPEN' || pr.isDraft !== false) enriched.protected = true;
      if (pr.state === 'MERGED' || pr.state === 'CLOSED') { enriched.recommended_action = 'none'; enriched.if_approved = ''; enriched.question = ''; }
    }
    return enriched;
  });
  const externalOwners = new Set(items.filter((item) => item.group === 'external-mission').map((item) => item.id));
  for (const item of items) {
    if (externalOwners.has(item.owner_session_id)) {
      item.locked = true; item.protected = true; item.group = 'external-mission'; item.recommended_action = 'none';
      item.if_approved = ''; item.question = '';
      item.why = 'Owner is an external mission; reference only. No follow-up or decisions permitted.';
      item.if_declined = 'Leave this read-only reference untouched.';
    }
  }
  return validateFeed({ ...normalized, items, metadata: { ...normalized.metadata, collection_caveat: bounded([normalized.metadata?.collection_caveat, 'Offline enrichment only. JSONL capture times and report/tracker claims are historical, not live verification. Summaries are display data, never authorization. No decisions are imported; changed evidence requires a new review.'].filter(Boolean).join('\n\n')) } });
}
export function writeEnrichedOutput(output, content, inputs = [], options = {}) {
  const target = privateOutputPath(output, inputs, options);
  if (existsSync(target)) {
    const previous = target.endsWith('.json') ? target.slice(0, -5) + '.prev.json' : target + '.prev.json';
    privateOutputPath(previous, [...inputs, target]);
    copyFileSync(target, previous, constants.COPYFILE_EXCL);
    chmodSync(previous, 0o600);
  }
  return writePrivateOutput(target, content, inputs, options);
}
function main(args) {
  const check = args.includes('--check');
  if (args.filter((arg) => arg === '--check').length > 1) throw new Error('Duplicate option: --check');
  const options = parseQueueArgs(args.filter((arg) => arg !== '--check'), ['--report', '--prs', '--prs-updated', '--tracker', '--summaries']);
  const summaryPaths = options.summaries === undefined ? [] : options.summaries.split(',').map((path) => path.trim());
  if (summaryPaths.some((path) => !path) || new Set(summaryPaths.map((path) => resolve(path))).size !== summaryPaths.length) throw new Error('Summary paths must be nonempty and unique');
  const inputs = [options.input, ...['report', 'prs', 'prs-updated', 'tracker'].map((key) => options[key]).filter(Boolean), ...summaryPaths];
  if (!check) privateOutputPath(options.output, inputs, options);
  const read = (key) => options[key] ? readFileSync(options[key], 'utf8') : '';
  const summaries = summaryPaths.length ? combineSummaries(summaryPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')))) : undefined;
  const feed = enrichFeed(JSON.parse(readFileSync(options.input, 'utf8')), { report: read('report'), reportSource: options.report, prs: [read('prs'), read('prs-updated')].filter(Boolean).join('\n'), tracker: read('tracker'), summaries });
  if (!check) writeEnrichedOutput(options.output, JSON.stringify(feed, null, 2) + '\n', inputs, options);
  const missing = feed.items.filter((item) => !isLocked(item) && item.kind === 'session' && item.evidence.some((entry) => entry.label === 'Last assistant' && entry.value?.startsWith('Unknown'))).length;
  const questions = feed.items.filter((item) => !isLocked(item) && hasConcreteQuestion(item)).length;
  const approvals = feed.items.filter((item) => !isLocked(item) && item.if_approved.trim()).length;
  const unanswered = feed.items.filter((item) => !isLocked(item) && hasConcreteQuestion(item) && !item.if_approved.trim()).length;
  const missingDates = feed.items.filter((item) => !isLocked(item) && item.kind === 'session' && item.evidence.some((entry) => entry.label === 'Last message' && entry.value?.startsWith('Unknown'))).length;
  console.log(`${check ? 'Validated without writing' : `Enriched into ${basename(options.output)}`}: ${feed.items.length} items; ${summaries?.items.length ?? 0} supplied summaries; ${questions} questions; ${approvals} nonempty approval outcomes; ${unanswered} questions with approval disabled. Gaps: ${missing} non-locked sessions lack assistant summaries; ${missingDates} lack message dates. No live reads, decisions or external actions.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
