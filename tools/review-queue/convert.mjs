import { readFileSync, writeFileSync, existsSync, realpathSync, lstatSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { validateFeed, safeUrl, isLocked } from './core.mjs';

const clean = (value) => value.replace(/\*\*|`/g, '').trim();
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const evidence = (label, value) => ({ label, value: String(value ?? 'unknown') });
const describe = (value) => value === undefined || value === null ? 'unknown' : typeof value === 'string' ? value : JSON.stringify(value);

/** Pipe tables, including escaped pipes; keep source cells as evidence, not instructions. */
export function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}
export function tables(markdown) {
  const lines = markdown.split(/\r?\n/);
  const result = [];
  let heading = '';
  let workspace;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) {
      heading = clean(line.replace(/^#+\s*/, ''));
      const match = heading.match(/^(openwork|OpenWork Chat)\s*[—–-].*?\b(ws_[A-Za-z0-9]+)\b/);
      if (match) workspace = { name: match[1], id: match[2] };
    }
    if (!line.trim().startsWith('|') || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) continue;
    const headers = tableCells(line).map(clean);
    const rows = [];
    i += 2;
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      const cells = tableCells(lines[i]);
      if (cells.length !== headers.length) throw new Error(`Malformed table at line ${i + 1}: expected ${headers.length} cells, got ${cells.length}`);
      rows.push({ cells, line: i + 1 });
      i++;
    }
    i--;
    result.push({ heading, workspace, headers, rows });
  }
  return result;
}
export function linksIn(value) {
  const links = [];
  for (const match of value.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const url = safeUrl(match[2]);
    if (url && !links.some((link) => link.url === url)) links.push({ label: clean(match[1]), url });
  }
  return links;
}
function column(headers, pattern) {
  return headers.findIndex((header) => pattern.test(header));
}
function externalSession(title) {
  return /^SUPAUD-20260915-A\S*/.test(title) ||
    ['Identify inquiry / meeting coordinator', 'Identify client making initial inquiry'].includes(title);
}
function collectionMetadata(markdown, source) {
  // Preserve literal collection language; a conversion timestamp must never imply refresh.
  const paragraphs = markdown.split(/\r?\n\s*\r?\n/);
  const caveats = paragraphs.filter((paragraph) => /collection window|not a .*snapshot|not atomic|not verifiable|not observable|not been.*refresh|not be presented later|not a live|snapshot.*(?:as of|collected)|as.of.*(?:EDT|UTC)/i.test(paragraph) && !paragraph.trim().startsWith('|'));
  const followups = markdown.split(/^## /m).filter((section) => /^(?:Actions taken|External mission \(untouched\))/.test(section));
  const original = [...caveats, ...followups].join('\n\n');
  return {
    source,
    collection_time: clean(paragraphs.find((paragraph) => /collection window|snapshot.*(?:as of|collected)|as.of.*(?:EDT|UTC)/i.test(paragraph)) ?? 'unknown — original report does not identify a collection window'),
    collection_caveat: (original || 'Original collection time/freshness unknown.') + '\n\nOffline conversion only. No live status, GitHub check, ownership, or authorization was refreshed. Missing facts remain unknown. Recheck every execution gate. External missions are read-only and untouched.',
  };
}

/** No network, git, engine database, commands, or writes. PR JSONL is optional. */
export function convertReport(markdown, prsJsonl = '', source = 'report.md') {
  if (typeof markdown !== 'string' || markdown.length > 20_000_000 || typeof prsJsonl !== 'string' || prsJsonl.length > 50_000_000) throw new Error('Report input must be bounded text');
  const parsedTables = tables(markdown);
  const items = new Map();
  const rowOwners = new Map();
  const prDetails = new Map();
  const mergeCandidates = new Set();
  for (const table of parsedTables) {
    const sessionIndex = column(table.headers, /^Session(?: ID)?$/i);
    const titleIndex = column(table.headers, /^Title$/i);
    if (sessionIndex >= 0 && titleIndex >= 0) {
      for (const row of table.rows) {
        const id = clean(row.cells[sessionIndex]);
        if (!/^ses_[A-Za-z0-9]+$/.test(id)) throw new Error(`Invalid session identity at line ${row.line}`);
        const title = clean(row.cells[titleIndex]);
        const pinIndex = column(table.headers, /Pin/i);
        const statusIndex = column(table.headers, /^Status$/i);
        const classIndex = column(table.headers, /^Class$/i);
        const actionIndex = column(table.headers, /Column|deliverable|decision|recommend/i);
        const updatedIndex = column(table.headers, /Updated/i);
        const rawStatus = pinIndex >= 0 ? clean(row.cells[pinIndex]) : statusIndex >= 0 ? clean(row.cells[statusIndex]) : 'unknown';
        const classification = classIndex >= 0 ? clean(row.cells[classIndex]) : 'unknown';
        const pinned = /(?:^|[,;\s])(?:P|K)(?:$|[,;\s])|\bpinned\b/i.test(rawStatus) && !/not pinned|unpinned/i.test(rawStatus);
        const idle = /(?:^|;\s*)i$|\bidle\b/i.test(rawStatus);
        const running = classification === 'R' || /(?:^|;\s*)b$|\bbusy\b|\brunning\b|working\s*true/i.test(rawStatus);
        const detail = actionIndex >= 0 ? clean(row.cells[actionIndex]) : 'unknown — no recommendation column';
        const tag = detail.split(';')[0].trim();
        const recommendation = ({ A: 'archive', Archive: 'archive', D: 'review', Decision: 'review', L: 'relaunch', Relaunch: 'relaunch', Keep: 'keep' })[tag] ?? 'review';
        const groupIndex = column(table.headers, /^group$/i);
        const external = externalSession(title) || (groupIndex >= 0 && clean(row.cells[groupIndex]).toLowerCase() === 'external-mission') || /^External mission\b/i.test(table.heading);
        const group = external ? 'external-mission' : table.workspace?.name ?? 'unknown workspace';
        const item = {
          id, kind: 'session', title,
          summary: detail + (external ? '\nExternal mission (untouched). Source reference only; not yours to act on. No archive, nudge, relaunch, comment or decision.' : ''),
          evidence: [
            evidence('Workspace', table.workspace?.name), evidence('Pinned', pinIndex < 0 ? 'unknown' : pinned ? 'yes' : 'no'),
            evidence('Status', running ? 'running' : idle ? 'idle' : 'unknown'), evidence('Class', classification),
            ...table.headers.map((header, index) => evidence(header, row.cells[index])), evidence('Source line', row.line),
          ],
          recommended_action: external ? 'none' : recommendation,
          links: linksIn(row.cells.join(' ')),
          age: updatedIndex >= 0 ? `Updated ${clean(row.cells[updatedIndex])} (source timezone; not live)` : 'unknown',
          risk: pinned || running || external ? 'high' : recommendation === 'archive' ? 'low' : 'unknown', group,
          ...(table.workspace ? { workspace_id: table.workspace.id } : {}),
          protected: pinned || running || !idle || pinIndex < 0 || table.workspace?.name !== 'openwork' || external,
          ...(external ? { locked: true, lock_reason: 'External mission owned elsewhere. Reference only; all decisions forbidden.' } : {}),
        };
        const previous = items.get(id);
        if (previous) {
          item.evidence = [...previous.evidence, ...item.evidence.filter((entry) => !previous.evidence.some((old) => old.label === entry.label && old.value === entry.value))];
          item.protected = previous.protected || item.protected;
          if (previous.locked) { item.locked = true; item.group = 'external-mission'; item.recommended_action = 'none'; item.lock_reason = previous.lock_reason; }
        }
        items.set(id, item);
        const rowIndex = column(table.headers, /^Row$/i);
        if (rowIndex >= 0) rowOwners.set(clean(row.cells[rowIndex]), id);
      }
    }
    const prIndex = column(table.headers, /^PR$/i);
    if (prIndex >= 0) {
      for (const row of table.rows) {
        const match = clean(row.cells[prIndex]).match(/(?:^|#)(\d+)/);
        if (!match) continue;
        const number = Number(match[1]);
        const previous = prDetails.get(number) ?? [];
        prDetails.set(number, [...previous, evidence('Report section', table.heading), ...table.headers.map((header, index) => evidence(header, row.cells[index]))]);
        if (/^Merge column\b/i.test(table.heading)) mergeCandidates.add(number);
      }
    }
  }
  const prs = new Map();
  for (const [index, line] of prsJsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let pr;
    try { pr = JSON.parse(line); } catch { throw new Error(`Invalid PR JSONL at line ${index + 1}`); }
    if (!pr || typeof pr !== 'object' || Array.isArray(pr) || !Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error(`Invalid PR record at line ${index + 1}`);
    // Deduplication follows file order, not a claim that the last row was freshly fetched.
    prs.set(pr.number, pr);
  }
  for (const [number, pr] of prs) {
    const state = ['OPEN', 'MERGED', 'CLOSED'].includes(pr.state) ? pr.state : 'unknown';
    const detail = prDetails.get(number) ?? [];
    const url = safeUrl(pr.url);
    const ownerCandidates = [...items.values()].filter((item) => item.kind === 'session' && new RegExp(`#${number}(?![0-9])`).test(item.summary));
    const explicitlyMerge = state === 'OPEN' && pr.isDraft === false && mergeCandidates.has(number);
    const item = {
      id: `pr-${number}`, kind: 'pr', title: `#${number} — ${typeof pr.title === 'string' ? pr.title : 'unknown title'}`,
      summary: detail.length ? detail.filter((entry) => /Fresh|verification|local result/i.test(entry.label)).map((entry) => `${entry.label}: ${entry.value}`).join('\n') || `Historical report detail available below. State at collection: ${state}.` : `State at collection: ${state}. No per-PR report detail; verification unknown.`,
      evidence: [evidence('State', state), ...['baseRefName', 'headRefName', 'headRefOid', 'isDraft', 'mergeStateStatus', 'reviewDecision', 'wardenAtHead', 'wardenReviews', 'failingChecks', 'pendingChecks', 'changedSpecs', 'behindDev', 'aheadDev', 'mergedAt'].map((key) => evidence(key, describe(pr[key]))), ...detail,
        evidence('Owner', ownerCandidates.length === 1 ? ownerCandidates[0].id : 'unknown or ambiguous — do not infer an owner'),
        ...(!url ? [evidence('Rejected source URL', describe(pr.url))] : []),
      ],
      recommended_action: explicitlyMerge ? 'merge' : state === 'OPEN' ? 'review' : 'keep',
      links: url ? [{ label: `PR #${number}`, url }] : [],
      age: 'unknown — use original collection caveat', risk: state === 'OPEN' ? 'high' : 'unknown', group: `PR / ${state}`,
      ...(url ? { pr_url: url } : {}), ...(typeof pr.headRefOid === 'string' ? { head_sha: pr.headRefOid } : {}),
      ...(ownerCandidates.length === 1 ? { owner_session_id: ownerCandidates[0].id } : {}),
      protected: state !== 'OPEN' || pr.isDraft !== false,
    };
    // A referenced external mission also protects its PR from this queue's actions.
    if (ownerCandidates.some((owner) => owner.locked)) {
      item.locked = true; item.group = 'external-mission'; item.recommended_action = 'none';
      item.lock_reason = 'PR referenced by an external mission; leave ownership and all actions to that mission.';
    }
    items.set(item.id, item);
  }
  let decisionSection = false;
  let decisionDepth = 0;
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (/^Decision column\b/i.test(clean(heading[2]))) { decisionSection = true; decisionDepth = heading[1].length; }
      else if (heading[1].length <= decisionDepth) decisionSection = false;
    }
    if (!decisionSection) continue;
    const match = lines[index].match(/^\s*(\d+)\.\s+(.+)$/);
    if (!match) continue;
    let body = match[2];
    while (/^\s{2,}\S/.test(lines[index + 1] ?? '')) body += '\n' + lines[++index].trim();
    const summary = clean(body);
    const owners = [...new Set([...summary.matchAll(/\b[OC]\d{2}\b/g)].map((match) => rowOwners.get(match[0])).filter(Boolean))];
    const id = `proposal-${hash(source + '\n' + match[1] + '\n' + summary)}`;
    items.set(id, {
      id, kind: 'proposal', title: summary.length > 180 ? summary.slice(0, 177) + '…' : summary,
      summary, evidence: [evidence('Decision number', match[1]), evidence('Source line', index + 1), evidence('Owner', owners.length === 1 ? owners[0] : 'unknown or multiple — manual routing required')],
      recommended_action: 'review', links: linksIn(body), age: 'unknown — source decision, not newly collected', risk: 'unknown', group: 'decisions',
      ...(owners.length === 1 ? { owner_session_id: owners[0] } : {}),
      ...(owners.some((owner) => items.get(owner)?.locked) ? { locked: true, group: 'external-mission', recommended_action: 'none', lock_reason: 'References an external mission; leave the proposal untouched.' } : {}),
    });
  }
  if (!items.size) throw new Error('No supported session tables, PR records, or numbered Decision column found');
  return validateFeed({ items: [...items.values()], decisions: [], metadata: collectionMetadata(markdown, source) });
}

function nativeObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be an object`);
  return value;
}
function nativeText(value, label, max = 20000) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`${label} must be bounded text`);
  return value;
}
function nativePrUrl(value) {
  const safe = safeUrl(value);
  if (!safe) throw new Error('Supplement PR requires a safe GitHub pull-request URL');
  const url = new URL(safe);
  const match = url.pathname.match(/^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.search || url.hash || !match || !Number.isSafeInteger(Number(match[3]))) throw new Error('Supplement PR requires a validated GitHub pull-request URL');
  return { id: `pr-${match[3]}`, url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` };
}
function nativeItem(raw) {
  nativeObject(raw, 'Supplement item');
  nativeText(raw.id, 'Supplement id', 4096);
  if (!['session', 'pr', 'proposal', 'worktree'].includes(raw.kind)) throw new Error('Invalid supplement kind');
  const item = {};
  for (const key of ['id', 'kind', 'title', 'summary', 'purpose', 'delivered', 'status_on_dev', 'why', 'if_approved', 'if_declined', 'question', 'recommended_action', 'age', 'risk', 'group', 'workspace_id', 'owner_session_id', 'pr_url', 'head_sha', 'protected', 'locked', 'lock_reason', 'age_days', 'stale_bound', 'execution_policy', 'archived']) {
    if (raw[key] !== undefined) item[key] = raw[key];
  }
  // Pick only documented label/value/url data. Never copy arbitrary command/action objects.
  for (const key of ['evidence', 'raw_evidence', 'links']) {
    if (raw[key] === undefined && key === 'raw_evidence') continue;
    if (raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].length > 100)) throw new Error(`Invalid supplement ${key}`);
    item[key] = (raw[key] ?? []).flatMap((entry) => {
      nativeObject(entry, `Supplement ${key} entry`);
      nativeText(entry.label, 'Supplement label', 200);
      if (!entry.label.trim()) throw new Error('Supplement label must be nonempty');
      if (key !== 'links' && entry.value === undefined && entry.url === undefined) throw new Error('Supplement evidence requires value or url');
      if (entry.value !== undefined) nativeText(entry.value, 'Supplement evidence value');
      if (entry.url !== undefined && !safeUrl(entry.url)) throw new Error('Supplement evidence URL must be safe');
      if (key !== 'links' && /command|instruction|execute|script/i.test(entry.label)) return [];
      const selected = { label: entry.label };
      if (key !== 'links' && entry.value !== undefined) selected.value = entry.value;
      if (entry.url !== undefined) selected.url = entry.url;
      return [selected];
    });
  }
  if (raw.kind === 'session' && !/^ses_[A-Za-z0-9]+$/.test(raw.id)) throw new Error('Supplement session requires exact ses_ identity');
  if (raw.kind === 'pr') {
    const primary = [raw.pr_url, raw.url, /^https?:\/\//i.test(raw.id) ? raw.id : undefined].filter((url) => url !== undefined);
    const urls = (primary.length ? primary : item.links.map((link) => link.url)).map(nativePrUrl);
    if (!urls.length || urls.some((entry) => entry.url.toLowerCase() !== urls[0].url.toLowerCase())) throw new Error('Missing or conflicting supplement PR identity');
    if (/^pr-\d+$/.test(raw.id) && raw.id !== urls[0].id) throw new Error('Supplement PR id disagrees with URL');
    item.pr_url = urls[0].url;
  }
  if (raw.kind === 'worktree') {
    const paths = [raw.path, raw.id.startsWith('/') ? raw.id : undefined, ...item.evidence.filter((entry) => entry.label.toLowerCase() === 'path').map((entry) => entry.value)].filter((path) => path !== undefined);
    for (const path of paths) {
      nativeText(path, 'Supplement worktree path', 4096);
      if (!path.startsWith('/') || /[\r\n]/.test(path)) throw new Error('Worktree path must be absolute display data');
    }
    if (new Set(paths).size > 1) throw new Error('Conflicting supplement worktree paths');
    if (paths.length) {
      validateFeed({ items: [{ id: paths[0], kind: 'worktree', title: 'Path validation' }] });
      if (!item.evidence.some((entry) => entry.label.toLowerCase() === 'path')) item.evidence.push(evidence('Path', paths[0]));
    } else if (!/^worktree-[A-Za-z0-9_.:-]+$/.test(raw.id)) throw new Error('Supplement worktree requires a path or canonical worktree ID');
    item.locked = true;
    item.protected = true;
    item.lock_reason = 'Worktree reference only. Separate ownership, ignored-file, running-process and human authorization checks required; no removal instruction.';
  }
  // Reject malformed flags even when a safety lock would otherwise overwrite them.
  for (const key of ['locked', 'protected']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error(`Supplement ${key} must be boolean`);
  if (raw.locked === true || raw.group === 'external-mission' || (raw.kind === 'session' && typeof raw.title === 'string' && externalSession(raw.title))) {
    item.locked = true;
    item.protected = true;
    if (raw.group === 'external-mission' || (raw.kind === 'session' && externalSession(raw.title ?? ''))) item.group = 'external-mission';
    item.lock_reason = raw.lock_reason ?? 'External or locked native inventory item. Reference only; not yours to act on.';
  }
  return validateFeed({ items: [item], decisions: [] }).items[0];
}

/** Native inventory is supplementary evidence, never a source of decision events. */
export function supplementReport(feed, raw) {
  const normalized = validateFeed(feed);
  nativeObject(raw, 'Supplement');
  if (!Array.isArray(raw.items) || raw.items.length > 10000) throw new Error('Supplement items must be a bounded array');
  const items = new Map(normalized.items.map((item) => [item.id, item]));
  for (const source of raw.items) {
    const incoming = nativeItem(source);
    if (incoming.kind === 'pr' && incoming.pr_url !== undefined) {
      const url = nativePrUrl(incoming.pr_url).url.toLowerCase();
      const matches = [...items.values()].filter((entry) => entry.kind === 'pr' && (entry.id === source.id || (entry.pr_url !== undefined && nativePrUrl(entry.pr_url).url.toLowerCase() === url)));
      if (matches.length > 1) throw new Error('Ambiguous existing PR identity');
      if (matches.length === 1) incoming.id = matches[0].id;
    }
    if (incoming.kind === 'worktree') {
      const path = incoming.evidence.find((entry) => entry.label.toLowerCase() === 'path')?.value;
      const matches = [...items.values()].filter((entry) => entry.kind === 'worktree' && (entry.id === source.id || (path && entry.evidence.some((fact) => fact.label.toLowerCase() === 'path' && fact.value === path))));
      if (matches.length > 1) throw new Error('Ambiguous existing worktree identity');
      if (matches.length === 1) incoming.id = matches[0].id;
    }
    if (incoming.id !== source.id) incoming.evidence.push(evidence('Original ID', source.id));
    const previous = items.get(incoming.id);
    if (previous && previous.kind !== incoming.kind) throw new Error('Supplement identity conflicts with existing kind');
    if (previous?.kind === 'pr' && previous.pr_url && (incoming.pr_url === undefined || nativePrUrl(previous.pr_url).url.toLowerCase() !== incoming.pr_url.toLowerCase())) throw new Error('Supplement PR number collides across repositories');
    if (!previous) { items.set(incoming.id, incoming); continue; }
    // Canonical Markdown/JSONL identity, title, head, recommendation and evidence win.
    const merged = { ...previous, evidence: [...previous.evidence], raw_evidence: [...previous.raw_evidence], links: [...previous.links] };
    const original = feed.items.find((item) => item.id === previous.id);
    const defaults = { purpose: 'Purpose not supplied.', delivered: 'No delivery summary supplied.', status_on_dev: 'Not verified on dev.', why: 'No rationale supplied.', if_approved: '', if_declined: '', question: '' };
    for (const [key, fallback] of Object.entries(defaults)) {
      if (source[key] !== undefined && (!original?.[key] || original[key] === fallback || (key === 'why' && original[key].startsWith('No rationale supplied.')))) merged[key] = incoming[key];
    }
    if (merged.question && original?.recommended_action && ['review', 'review_decision', 'review_blockers'].includes(original.recommended_action)) merged.recommended_action = original.recommended_action;
    for (const entry of incoming.raw_evidence) {
      if (!merged.raw_evidence.some((existing) => JSON.stringify(existing) === JSON.stringify(entry))) merged.raw_evidence.push(entry);
    }
    const addEvidence = (entry) => {
      if (!merged.evidence.some((existing) => JSON.stringify(existing) === JSON.stringify(entry))) merged.evidence.push(entry);
    };
    for (const entry of incoming.evidence) addEvidence({ ...entry, label: `Native: ${entry.label}` });
    for (const key of ['title', 'summary', 'head_sha', 'recommended_action', 'group', 'archived']) {
      if (source[key] !== undefined && incoming[key] !== previous[key]) addEvidence(evidence(`Native ${key}`, incoming[key]));
    }
    for (const link of incoming.links) if (!merged.links.some((existing) => existing.url === link.url && existing.label === link.label)) merged.links.push(link);
    for (const key of ['workspace_id', 'owner_session_id', 'pr_url', 'head_sha', 'age_days', 'stale_bound', 'execution_policy', 'archived']) {
      if (previous[key] === undefined && incoming[key] !== undefined) merged[key] = incoming[key];
    }
    if (incoming.protected === true) merged.protected = true;
    // An observed archive is a safety gate, not a canonical display preference.
    if (incoming.archived === true) merged.archived = true;
    if (isLocked(previous) || isLocked(incoming)) {
      merged.locked = true;
      merged.protected = true;
      if (previous.group === 'external-mission' || incoming.group === 'external-mission') merged.group = 'external-mission';
      merged.lock_reason = previous.lock_reason ?? incoming.lock_reason ?? 'Locked source item; not yours to act on.';
    }
    items.set(merged.id, merged);
  }
  // Known external ownership also locks dependent rows, independent of native row order.
  for (const item of items.values()) {
    if (item.owner_session_id && items.get(item.owner_session_id)?.group === 'external-mission') {
      item.locked = true; item.protected = true; item.group = 'external-mission';
      item.lock_reason = 'Owner is an external mission; all decisions and follow-ups forbidden.';
    }
  }
  const original = {};
  if (raw.as_of !== undefined) original.as_of = validateFeed({ items: [], metadata: { collected_at: raw.as_of } }).metadata.collected_at;
  if (raw.coverage !== undefined) {
    nativeObject(raw.coverage, 'Supplement coverage');
    const coverage = {};
    for (const key of ['initial_roots', 'known_session_items', 'latest_candidate_roots_observed', 'unknown_new_root_count', 'unidentified_candidate_count_at_observation', 'external_mission_count', 'pr_items', 'reclaimable_worktrees']) {
      if (raw.coverage[key] !== undefined) {
        if (!(key === 'unknown_new_root_count' && raw.coverage[key] === null) && (!Number.isSafeInteger(raw.coverage[key]) || raw.coverage[key] < 0)) throw new Error(`Invalid supplement coverage ${key}`);
        coverage[key] = raw.coverage[key];
      }
    }
    if (raw.coverage.caveat !== undefined) coverage.caveat = nativeText(raw.coverage.caveat, 'Supplement coverage caveat');
    original.coverage = coverage;
  }
  const metadata = { ...normalized.metadata };
  const note = `original_collection (native snapshot, NOT refreshed): ${JSON.stringify(original)}\nNative decisions/actions_taken/generated_at are not imported as authority. Worktrees are read-only references.`;
  metadata.collection_caveat = [metadata.collection_caveat, note].filter(Boolean).join('\n\n');
  // Existing decisions remain exact. A newly locked decided item fails closed rather than silently losing audit.
  return validateFeed({ ...normalized, items: [...items.values()], metadata });
}

/** Refuse repository destinations and overwrites, including symlinked parents. */
export function privateOutputPath(output, inputs = [], { replace = false } = {}) {
  const absolute = resolve(output);
  const parent = realpathSync(dirname(absolute));
  const target = join(parent, basename(absolute));
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw new Error('Output symlinks are forbidden, including with --replace');
  if (existing && !existing.isFile()) throw new Error('Output must be an ordinary file');
  for (const input of inputs) {
    const identity = realpathSync(input);
    const info = statSync(identity);
    if (identity === target || (existing && existing.dev === info.dev && existing.ino === info.ino)) throw new Error('Output cannot overwrite an input or input alias');
  }
  if (existing && !replace) throw new Error('Output already exists; use --replace explicitly or choose a new private path');
  let directory = parent;
  while (true) {
    if (existsSync(join(directory, '.git'))) throw new Error('Private review output must be outside every Git repository');
    const next = dirname(directory);
    if (next === directory) break;
    directory = next;
  }
  return target;
}
export function writePrivateOutput(output, content, inputs = [], options = {}) {
  const target = privateOutputPath(output, inputs, options);
  if (!options.replace) {
    writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
    return target;
  }
  const temporary = join(dirname(target), `.review-queue-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    // Recheck identities/repository boundaries immediately before atomic replacement.
    privateOutputPath(target, inputs, options);
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return target;
}

export function parseQueueArgs(args, valueFlags = []) {
  if (args.length < 2 || args[0].startsWith('--') || args[1].startsWith('--')) throw new Error('Expected input and output positional paths first');
  const result = { input: args[0], output: args[1], replace: false };
  const seen = new Set();
  for (let index = 2; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--replace') { result.replace = true; continue; }
    if (!valueFlags.includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${flag}`);
    result[flag.slice(2)] = args[++index];
  }
  return result;
}
function main(args) {
  const options = parseQueueArgs(args, ['--prs', '--supplement']);
  const inputs = [options.input, ...[options.prs, options.supplement].filter(Boolean)];
  privateOutputPath(options.output, inputs, options);
  let feed = convertReport(readFileSync(options.input, 'utf8'), options.prs ? readFileSync(options.prs, 'utf8') : '', basename(options.input));
  if (options.supplement) feed = supplementReport(feed, JSON.parse(readFileSync(options.supplement, 'utf8')));
  const target = writePrivateOutput(options.output, JSON.stringify(feed, null, 2) + '\n', inputs, options);
  console.log(`Converted ${feed.items.length} items; ${feed.items.filter((item) => item.kind === 'session').length} sessions, ${feed.items.filter((item) => item.kind === 'pr').length} PRs, ${feed.items.filter((item) => item.kind === 'proposal').length} proposals, ${feed.items.filter((item) => item.kind === 'worktree').length} worktrees; ${feed.items.filter((item) => item.group === 'external-mission').length} external-mission items. No decisions or external actions. Private output: ${target}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
