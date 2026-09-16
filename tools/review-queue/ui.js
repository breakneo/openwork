(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const labels = { approve: 'Approve', decline: 'Decline', defer: 'Defer', ask_info: 'Ask for info', request_changes: 'Request changes', comment: 'Comment' };
  const statuses = { approve: 'Approved', decline: 'Declined', defer: 'Deferred', ask_info: 'Asked for info', request_changes: 'Changes requested', comment: 'Commented' };
  let feed;
  let activeId = null;
  let selected = new Set();
  let drafts = Object.create(null);
  let pendingBatch = null;
  let dirty = false;
  let savedKey = '';
  let snapshot = '';
  let exportStamp = '';
  let liveSession = false;
  let connected = false;
  let writing = false;
  let token = '';
  let serverSnapshot = '';
  let cursor = 0;
  let originalServerFeed;
  let liveStorageReady = false;
  let restoreProblem = '';
  const uncertainState = 'LOCAL ONLY / UNCERTAIN — check the thread. No automatic retry.';
  const terminalStatuses = ['done', 'archived', 'merged', 'declined', 'deferred', 'stopped'];
  const events = new Map();
  const localRequests = new Map();
  const threadDrafts = new Map();
  function unavailable() { return liveSession && (!connected || writing); }
  function syncControls() {
    $('mode-badge').textContent = liveSession ? connected ? 'LIVE' : 'CONNECTION LOST' : 'OFFLINE';
    for (const id of ['import-feed', 'import-decisions']) $(id).disabled = liveSession;
    $('undo').disabled = liveSession || !feed?.decisions.length;
    for (const button of document.querySelectorAll('#detail [data-action]')) {
      const item = feed.items.find((entry) => entry.id === activeId);
      button.disabled = unavailable() || (button.dataset.action === 'approve' && !canApprove(item));
    }
    const send = document.querySelector('[data-testid="thread-send"]');
    if (send) send.disabled = unavailable();
    const input = document.querySelector('[data-testid="thread-input"]');
    if (input) input.disabled = !connected;
    const batch = document.querySelector('[data-testid="archive-batch"] button[data-batch-approve]');
    if (batch) batch.disabled = unavailable() || new Set(archiveItems().map(shape)).size !== 1;
    renderBulk();
  }
  function connectionLost() {
    connected = false;
    syncControls();
    message('Connection lost. Unconfirmed changes are local only / delivery uncertain; check the thread before acting again. Nothing will be retried automatically. Reload to inspect server results.');
  }
  async function request(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Review-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Server rejected request (${response.status})`);
    return response.json();
  }
  function acceptEvents(incoming) {
    if (!Array.isArray(incoming)) throw new Error('Invalid result events');
    const nextEvents = new Map(events);
    const before = listState();
    const decisions = new Map(originalServerFeed.decisions.map((entry) => [JSON.stringify([entry.batch_id, entry.id]), entry]));
    for (const event of [...events.values(), ...incoming]) {
      if (!event || typeof event.id !== 'string' || typeof event.decision_id !== 'string' ||
          !Array.isArray(event.item_ids) || !event.item_ids.every((id) => feed.items.some((item) => item.id === id)) ||
          !['decision', 'thread', 'status'].includes(event.kind) ||
          !['queued', 'rechecking', 'done', 'archived', 'merged', 'blocked', 'reply', 'waiting', 'declined', 'deferred', 'stopped'].includes(event.status) ||
          typeof event.text !== 'string' || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid result event');
      if (nextEvents.has(event.id) && JSON.stringify(nextEvents.get(event.id)) !== JSON.stringify(event)) throw new Error('Conflicting result event');
      nextEvents.set(event.id, event);
      if (event.kind === 'decision') {
        if (!Array.isArray(event.decisions)) throw new Error('Missing decision history');
        for (const entry of event.decisions) {
          if (entry.batch_id !== event.decision_id || !event.item_ids.includes(entry.id)) throw new Error('Uncorrelated decision');
          const key = JSON.stringify([entry.batch_id, entry.id]);
          if (decisions.has(key) && JSON.stringify(decisions.get(key)) !== JSON.stringify(entry)) throw new Error('Conflicting decision history');
          decisions.set(key, entry);
        }
      }
    }
    feed = validateFeed({ ...feed, decisions: [...decisions.values()].sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at)) });
    events.clear();
    for (const [id, event] of nextEvents) { events.set(id, event); localRequests.delete(id); }
    for (const [id, local] of localRequests) {
      if (local.kind === 'decision' && local.decisions.every((entry) => decisions.has(JSON.stringify([id, entry.id])))) localRequests.delete(id);
    }
    persist();
    if (before !== listState()) renderList(true);
    renderMetrics(); renderPlan(); renderHistory(); renderThreadEvents(); syncControls();
  }
  async function pollResults() {
    if (!connected) return;
    try {
      const result = await request(`/results?since=${cursor}`);
      if (!Number.isSafeInteger(result.cursor) || result.cursor < cursor) throw new Error('Invalid result cursor');
      acceptEvents(result.events); cursor = result.cursor;
    } catch { connectionLost(); }
    if (connected) setTimeout(pollResults, 3000);
  }
  async function postOnce(path, body) {
    try {
      const receipt = await request(path, body);
      if (receipt.id !== body.id) throw new Error('Uncorrelated receipt');
      acceptEvents([receipt]);
      message('Received by the server. Queued for owner recheck, not proof of execution; follow the thread.');
    } catch {
      if (events.has(body.id)) {
        message('Server receipt confirmed by polling. Follow the thread; this request will not be retried.');
      } else {
        const local = localRequests.get(body.id);
        if (local) local.state = uncertainState;
        connectionLost(); renderThreadEvents();
      }
    } finally { writing = false; persist(); syncControls(); }
  }
  async function connect() {
    if (location.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return;
    token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    if (!token) return;
    liveSession = true; syncControls();
    try {
      const metadata = await request('/server.json');
      if (metadata.origin !== location.origin) throw new Error('Server origin mismatch');
      const original = validateFeed(await request('/feed'));
      originalServerFeed = original;
      serverSnapshot = JSON.stringify({ ...original, decisions: [] });
      initialize(original, false);
      const result = await request('/results?since=0');
      if (!Number.isSafeInteger(result.cursor) || result.cursor < 0) throw new Error('Invalid result cursor');
      acceptEvents(result.events); cursor = result.cursor;
      connected = true; render();
      $('source').textContent = 'Live decisions and owner results · source evidence is a frozen snapshot, not live verification. Every approval requires a fresh recheck.';
      message(restoreProblem || (localRequests.size ? 'Connected. Restored LOCAL ONLY / UNCERTAIN audit entries; inspect them in All items. No request was replayed.' : 'Connected. New decisions are sent immediately once; old decisions are never replayed.'));
      setTimeout(pollResults, 3000);
    } catch { connectionLost(); }
  }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function message(text = '') { $('message').textContent = text; }
  function guarded(fn) { return (...args) => { try { fn(...args); } catch (error) { message(error.message); } }; }
  function fingerprint(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16);
  }
  function sourceSnapshot(source) {
    const { decisions, ...envelope } = source;
    return JSON.stringify(envelope);
  }
  function liveRecord() {
    return { mode: 'live-local-v2', sourceSnapshot: snapshot, drafts, threadDrafts: Object.fromEntries(threadDrafts), localRequests: [...localRequests.values()] };
  }
  function restoreLive() {
    try {
      const raw = localStorage.getItem(savedKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.sourceSnapshot !== snapshot) throw new Error('Stored source differs from server source');
        validateFeed({ ...feed, drafts: saved.drafts ?? {} });
        validateFeed({ ...feed, drafts: saved.threadDrafts ?? {} });
        let pending = saved.localRequests;
        if (saved.mode === undefined && Array.isArray(saved.decisions)) {
          const legacy = validateFeed({ ...feed, decisions: saved.decisions });
          const batches = new Map();
          for (const decision of legacy.decisions) {
            if (!batches.has(decision.batch_id)) batches.set(decision.batch_id, []);
            batches.get(decision.batch_id).push(decision);
          }
          pending = [...batches].map(([id, decisions]) => ({ id, kind: 'decision', item_ids: decisions.map((entry) => entry.id), text: decisions[0].comment, action: decisions[0].action, at: decisions[0].decided_at, decisions, state: uncertainState }));
        } else if (saved.mode !== 'live-local-v2') throw new Error('Unknown live storage format');
        if (!Array.isArray(pending) || pending.length > 100000) throw new Error('Invalid local audit');
        const restored = new Map();
        for (const local of pending) {
          const keys = ['id', 'kind', 'item_ids', 'text', 'action', 'at', 'decisions', 'state'];
          if (!local || Object.keys(local).length !== keys.length || keys.some((key) => !Object.hasOwn(local, key)) ||
              typeof local.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(local.id) || restored.has(local.id) ||
              !['decision', 'thread'].includes(local.kind) || !Array.isArray(local.item_ids) || !local.item_ids.length || new Set(local.item_ids).size !== local.item_ids.length ||
              !local.item_ids.every((id) => feed.items.some((item) => item.id === id && !isLocked(item))) ||
              typeof local.text !== 'string' || local.text.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(local.text) ||
              typeof local.at !== 'string' || !Number.isFinite(Date.parse(local.at)) || !Array.isArray(local.decisions) || typeof local.state !== 'string') throw new Error('Invalid local audit entry');
          if (local.kind === 'decision') {
            const validated = validateFeed({ ...feed, decisions: local.decisions }).decisions;
            if (validated.length !== local.item_ids.length || validated.some((entry, index) => entry.id !== local.item_ids[index] || entry.batch_id !== local.id || entry.action !== local.action || entry.comment !== local.text || entry.decided_at !== local.at)) throw new Error('Uncorrelated local decision');
          } else if (local.decisions.length || local.item_ids.length !== 1 || !local.text.trim() || !['stop', 'ask_info'].includes(local.action)) throw new Error('Invalid local thread');
          restored.set(local.id, { ...local, state: uncertainState });
        }
        drafts = Object.assign(Object.create(null), saved.drafts);
        for (const [id, text] of Object.entries(saved.threadDrafts ?? {})) threadDrafts.set(id, text);
        for (const [id, local] of restored) localRequests.set(id, local);
      }
      liveStorageReady = true;
    } catch {
      restoreProblem = 'Live local recovery unavailable: invalid or inaccessible saved audit. The existing record was not overwritten. Inspect browser storage before discarding it; nothing was replayed.';
      message(restoreProblem);
    }
  }
  function persist() {
    if (liveSession) {
      dirty = writing || localRequests.size > 0 || Object.values(drafts).some(Boolean) || [...threadDrafts.values()].some(Boolean);
      if (!liveStorageReady) { $('storage-status').textContent = restoreProblem || 'Recovering the live local audit before saving.'; return; }
    }
    try {
      localStorage.setItem(savedKey, JSON.stringify(liveSession ? liveRecord() : { sourceSnapshot: snapshot, decisions: feed.decisions, drafts }));
      $('storage-status').textContent = 'Saved in this browser for this exact feed. Download JSON for a portable backup; private browsing and previews may clear storage.';
    } catch {
      $('storage-status').textContent = 'Browser storage unavailable. Decisions remain in this tab only: export JSON before closing.';
    }
  }
  function initialize(input, restore = true) {
    const validated = validateFeed(input);
    feed = validated;
    snapshot = sourceSnapshot(feed);
    savedKey = `review-queue-${liveSession ? 'live' : 'v1'}-${fingerprint(snapshot)}`;
    drafts = Object.create(null);
    dirty = false;
    if (restore) {
      try {
        const raw = localStorage.getItem(savedKey);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved.sourceSnapshot !== snapshot) throw new Error('Stored feed does not match this snapshot. No decisions restored.');
          const restored = validateFeed({ ...feed, decisions: saved.decisions, drafts: saved.drafts ?? {} });
          feed = restored;
          if (saved.drafts && typeof saved.drafts === 'object' && !Array.isArray(saved.drafts)) {
            for (const item of feed.items) if (typeof saved.drafts[item.id] === 'string') drafts[item.id] = saved.drafts[item.id].slice(0, 10000);
          }
          dirty = feed.decisions.length > 0 || Object.values(drafts).some(Boolean);
          message('Restored saved decisions and drafts for this exact snapshot. Export a fresh copy after review.');
        }
      } catch (error) { message(`Local restore unavailable: ${error.message}. Import an exported JSON backup if needed.`); }
    }
    if (liveSession) restoreLive();
    selected.clear(); activeId = null;
    for (const [control, property, title] of [['kind', 'kind', 'All kinds'], ['group', 'group', 'All groups'], ['recommendation', 'recommended_action', 'All recommendations']]) {
      const select = $(control);
      select.replaceChildren(new Option(title, ''));
      [...new Set(feed.items.map((item) => property === 'recommended_action' ? recommendationVerb(item) : item[property]))].sort().forEach((value) => select.add(new Option(value || '(unspecified)', value)));
    }
    $('search').value = ''; $('status').value = 'human';
    const sourceMeta = feed.metadata ?? feed.meta ?? {};
    const sourceText = sourceMeta.collection_time || sourceMeta.collected_at || feed.as_of || 'Collection time unknown; consult source evidence.';
    $('source').textContent = `Snapshot, not live state. ${sourceText.slice(0, 650)}${sourceText.length > 650 ? '…' : ''}`;
    const { items, decisions, ...provenance } = feed;
    $('source-caveat').textContent = JSON.stringify(provenance, null, 2);
    const coverage = $('coverage'); coverage.replaceChildren(); coverage.hidden = !feed.coverage;
    if (feed.coverage) {
      coverage.append(element('strong', 'Snapshot coverage — not live or atomic'));
      for (const [key, value] of Object.entries(feed.coverage)) {
        coverage.append(element('div', `${key.replaceAll('_', ' ')}: ${value === null ? 'unknown (not reconciled)' : value}`));
      }
      if (feed.coverage.unknown_new_root_count === undefined) coverage.append(element('div', 'unknown new root count: not supplied'));
    }
    const overnight = $('done-overnight'); overnight.replaceChildren(); overnight.hidden = !feed.actions_taken?.length;
    if (feed.actions_taken?.length) {
      overnight.append(element('h2', `Done overnight (${feed.actions_taken.length})`), element('p', 'Read-only source history, not decisions in this queue. Reported outcomes may be incomplete; nothing here authorizes or repeats an action.', 'muted small'));
      for (const action of feed.actions_taken) {
        const row = element('details', undefined, 'overnight-entry');
        row.append(element('summary', `${action.title || action.id} · ${action.action} · ${action.status}`));
        row.append(element('p', action.summary), element('pre', JSON.stringify(action, null, 2), 'overnight-data'));
        overnight.append(row);
      }
    }
    $('export-json').disabled = false; $('export-markdown').disabled = false;
    persist(); render();
  }
  function localDecisions() { return [...localRequests.values()].flatMap((local) => local.decisions); }
  function reviewHistory() { return [...feed.decisions, ...localDecisions()].sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at)); }
  function decisionsById() { return new Map(reviewHistory().map((decision) => [decision.id, decision])); }
  function resultById() {
    const result = new Map();
    for (const event of [...events.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      if (event.kind !== 'decision' && !(event.kind === 'status' && (event.status !== 'rechecking' || events.get(event.decision_id)?.kind === 'decision'))) continue;
      for (const id of event.item_ids) result.set(id, event);
    }
    return result;
  }
  function needsHuman(item, decision, result) {
    if (isLocked(item)) return false;
    if (result && (!decision || Date.parse(result.at) >= Date.parse(decision.decided_at))) {
      if (['blocked', 'waiting'].includes(result.status)) return true;
      if (terminalStatuses.includes(result.status)) return false;
    }
    if (item.archived || ['decline', 'defer'].includes(decision?.action)) return false;
    if (decision?.action === 'approve') return ['queued', 'rechecking'].includes(result?.status);
    return ['merge', 'review', 'relaunch', 'blockers'].includes(recommendationVerb(item));
  }
  function archiveEligible(item, decisions = decisionsById(), results = resultById()) {
    return item.kind === 'session' && recommendationVerb(item) === 'archive' && canApprove(item) && !item.protected && !item.archived && !isLocked(item)
      && !decisions.has(item.id) && ![...localRequests.values()].some((local) => local.item_ids.includes(item.id))
      && !['blocked', 'waiting', ...terminalStatuses].includes(results.get(item.id)?.status)
      && ![...events.values()].some((event) => event.item_ids.includes(item.id) && terminalStatuses.includes(event.status));
  }
  function listState() {
    return JSON.stringify([reviewHistory(), [...resultById()].map(([id, event]) => [id, event.id]), [...localRequests.values()].map((local) => [local.id, local.item_ids])]);
  }
  function filteredItems() {
    const query = $('search').value.trim().toLowerCase();
    return feed.items.filter((item) => (!$('kind').value || item.kind === $('kind').value)
      && (!$('group').value || item.group === $('group').value)
      && (!$('recommendation').value || recommendationVerb(item) === $('recommendation').value)
      && (!query || JSON.stringify(item).toLowerCase().includes(query)));
  }
  function visibleItems() {
    const decisions = decisionsById();
    const results = resultById();
    return filteredItems().filter((item) => $('status').value === 'human'
      ? needsHuman(item, decisions.get(item.id), results.get(item.id))
      : !$('status').value || (isLocked(item) ? 'locked' : decisions.get(item.id)?.action ?? 'pending') === $('status').value)
      .sort((a, b) => Number(isLocked(a)) - Number(isLocked(b)));
  }
  function archiveItems() {
    const decisions = decisionsById(); const results = resultById();
    return filteredItems().filter((item) => archiveEligible(item, decisions, results));
  }
  function archiveCard() {
    if ($('status').value !== 'human') return null;
    const items = archiveItems();
    if (!items.length) return null;
    const card = element('section', undefined, 'archive-batch'); card.dataset.testid = 'archive-batch'; card.dataset.ids = JSON.stringify(items.map((item) => item.id));
    card.append(element('h3', `Archive ${items.length} concluded sessions`));
    const list = element('details'); list.append(element('summary', 'Inspect all sessions'));
    for (const item of items) {
      const open = element('button', item.title);
      open.addEventListener('click', () => { activeId = item.id; renderDetail(); });
      list.append(open);
    }
    const homogeneous = new Set(items.map(shape)).size === 1;
    const approve = element('button', 'Review archive batch'); approve.dataset.batchApprove = '';
    approve.disabled = !homogeneous || unavailable();
    approve.addEventListener('click', guarded(() => confirmBatch(items.map((item) => item.id), 'approve', '')));
    card.append(list, element('p', homogeneous ? 'Recheck required. Confirmation lists every session; no action before confirmation.' : 'Mixed archive groups or original recommendations. Require a separate filter for each shape; no partial batch will be approved.', 'small muted'), approve);
    return card;
  }
  function shape(item) { return JSON.stringify([item.kind, item.group, item.recommended_action]); }
  function renderMetrics() {
    const decisions = [...decisionsById().values()];
    const approved = decisions.filter((d) => d.action === 'approve').length;
    const declined = decisions.filter((d) => d.action === 'decline').length;
    const locked = feed.items.filter(isLocked).length;
    const actionable = feed.items.length - locked;
    const pending = actionable - decisions.length;
    const deferred = decisions.filter((d) => d.action === 'defer').length;
    const followups = decisions.filter((d) => ['ask_info', 'request_changes', 'comment'].includes(d.action)).length;
    $('metrics').replaceChildren();
    for (const [count, label] of [[feed.items.length, 'total'], [pending, 'pending'], [approved, 'approved'], [declined, 'declined'], [followups, 'follow-ups / comments'], [deferred, 'deferred'], [locked, 'nothing to decide']]) {
      const metric = element('span'); metric.append(element('strong', String(count)), document.createTextNode(` ${label}`)); $('metrics').append(metric);
    }
    $('progress').style.width = `${actionable ? ((approved + declined) / actionable) * 100 : 0}%`;
    $('undo').disabled = liveSession || feed.decisions.length === 0;
  }
  function renderList(preserveActive = false) {
    const items = visibleItems();
    const focused = document.activeElement;
    const focusedRow = focused?.closest('[data-testid="queue-row"]');
    if (!preserveActive && !items.some((item) => item.id === activeId) && !($('status').value === 'human' && archiveItems().some((item) => item.id === activeId))) activeId = items[0]?.id ?? null;
    if (preserveActive) selected = new Set([...selected].filter((id) => items.some((item) => item.id === id)));
    const decisions = decisionsById(); const results = resultById();
    $('visible-count').textContent = `${items.length} visible / ${feed.items.length}`;
    const selectable = items.filter((item) => !isLocked(item));
    $('select-visible').disabled = selectable.length === 0;
    $('select-visible').checked = selectable.length > 0 && selectable.every((item) => selected.has(item.id));
    $('select-visible').indeterminate = selectable.some((item) => selected.has(item.id)) && !$('select-visible').checked;
    const nodes = items.map((item) => {
      const row = element('div', undefined, `queue-row${item.id === activeId ? ' active' : ''}${selected.has(item.id) ? ' selected' : ''}${isLocked(item) ? ' locked' : ''}`);
      row.dataset.testid = 'queue-row'; row.dataset.id = item.id; row.dataset.verb = recommendationVerb(item);
      const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(item.id); checkbox.dataset.testid = 'item-select'; checkbox.setAttribute('aria-label', `Select ${item.title}`);
      checkbox.addEventListener('change', () => { checkbox.checked ? selected.add(item.id) : selected.delete(item.id); renderList(); renderBulk(); $('list').querySelector(`[data-id="${CSS.escape(item.id)}"] input`)?.focus({ preventScroll: true }); });
      const open = element('button', undefined, 'row-open'); open.setAttribute('aria-label', `Review ${item.title}`); open.setAttribute('aria-current', item.id === activeId ? 'true' : 'false');
      open.append(element('span', item.title, 'row-title'), element('span', item.purpose, 'row-summary'));
      const meta = element('span', undefined, 'row-meta'); meta.append(element('span', item.kind, 'tag'), element('span', isLocked(item) ? 'Nothing to decide' : results.has(item.id) ? `${results.get(item.id).status}${['blocked', 'waiting'].includes(results.get(item.id).status) ? `: ${results.get(item.id).text}` : ''}` : statuses[decisions.get(item.id)?.action] ?? 'Pending'), element('span', `→ ${recommendationVerb(item).replaceAll('_', ' ')}`)); open.append(meta);
      open.addEventListener('click', () => { activeId = item.id; renderList(); renderDetail(); $('list').querySelector('.active .row-open')?.focus({ preventScroll: true }); });
      if (!isLocked(item)) row.append(checkbox);
      row.append(open); return row;
    });
    const firstLocked = items.findIndex(isLocked);
    if (firstLocked !== -1) nodes.splice(firstLocked, 0, element('h3', 'Nothing to decide · read-only references', 'locked-heading'));
    const batch = archiveCard();
    const previousBatch = $('list').querySelector('[data-testid="archive-batch"]');
    if (batch) {
      if (previousBatch?.dataset.ids === batch.dataset.ids) nodes.unshift(previousBatch);
      else {
        if (previousBatch?.querySelector('details').open) batch.querySelector('details').open = true;
        nodes.unshift(batch);
      }
    }
    $('list').replaceChildren(...(nodes.length ? nodes : [element('p', 'No items match these filters.', 'empty')]));
    if (focusedRow) $('list').querySelector(`[data-id="${CSS.escape(focusedRow.dataset.id)}"] ${focused.matches('input') ? 'input' : '.row-open'}`)?.focus({ preventScroll: true });
    else if (focused && $('list').contains(focused)) focused.focus({ preventScroll: true });
  }
  function renderBulk() {
    $('bulk').hidden = selected.size === 0;
    $('selected-count').textContent = `${selected.size} selected`;
    const items = feed.items.filter((item) => selected.has(item.id));
    const homogeneous = new Set(items.map(shape)).size <= 1 && !items.some(isLocked);
    $('bulk-shape').textContent = homogeneous && items.length ? `${items[0].kind} · ${items[0].group} · ${items[0].recommended_action}` : 'Mixed kinds, groups or recommendations. Filter to matching items before batching.';
    const bulkMerge = items.length > 1 && items.some((item) => recommendationVerb(item).toLowerCase().trim() === 'merge');
    const missingOutcome = bulkMerge || items.some((item) => !canApprove(item));
    $('bulk-action').querySelector('option[value="approve"]').disabled = missingOutcome;
    const approvalBlocked = $('bulk-action').value === 'approve' && missingOutcome;
    if (approvalBlocked) $('bulk-shape').textContent = 'Approval unavailable: every selected item needs an approval outcome.';
    if (bulkMerge) $('bulk-shape').textContent = 'Bulk merge approval is forbidden. Review and approve each PR separately.';
    $('bulk-apply').disabled = unavailable() || !homogeneous || !items.length || approvalBlocked;
  }
  function safeLink(label, url) {
    const allowed = safeUrl(url);
    if (!allowed) return element('span', `${label} (unsafe or unavailable link)`, 'muted');
    const link = element('a', label); link.href = allowed; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; return link;
  }
  function renderDetail() {
    const root = $('detail'); root.replaceChildren();
    const item = feed.items.find((candidate) => candidate.id === activeId);
    if (!item) { root.append(element('p', 'Choose an item or load a feed to start reviewing.', 'empty')); return; }
    const heading = element('h2', item.title); heading.dataset.testid = 'detail-title';
    root.append(heading);
    function field(name, label, value) {
      const section = element('section', undefined, 'section'); section.dataset.field = name;
      section.append(element('h3', label), element('p', value, 'summary')); root.append(section); return section;
    }
    field('purpose', 'Purpose', item.purpose || 'Purpose not supplied.');
    field('status_on_dev', 'Status on dev', item.status_on_dev || 'Not verified on dev.');
    const delivered = field('delivered', 'Delivered', item.delivered || 'No delivery summary supplied.');
    if (item.links.length) {
      const links = element('div', undefined, 'actions'); links.dataset.field = 'links';
      for (const link of item.links) links.append(safeLink(link.label, link.url));
      delivered.append(links);
    }
    const rationale = field('why', 'Why', item.why || 'No rationale supplied.');
    const recommendation = element('div', undefined, 'recommendation'); recommendation.dataset.field = 'recommendation';
    recommendation.append(element('span', 'Recommendation · ', 'muted'), element('strong', recommendationVerb(item).replaceAll('_', ' ')));
    rationale.append(recommendation);
    if (item.question.trim()) field('question', 'Question for you', item.question);
    const review = element('section', undefined, 'section'); review.dataset.field = 'decision'; root.append(review);
    if (isLocked(item)) {
      review.append(element('p', `Nothing to decide. Not yours to act on; this reference is read-only. ${item.lock_reason || 'Separate ownership and authorization checks required.'}`, 'locked-banner'));
    } else {
      if (item.protected) review.append(element('p', 'Protected item: decisions here never override pin, running-state or permission restrictions.', 'small muted'));
      const actions = element('div', undefined, 'decision-actions');
      const commentLabel = element('label', 'Comment or follow-up request'); commentLabel.htmlFor = 'comment';
      const comment = element('textarea'); comment.id = 'comment'; comment.dataset.testid = 'comment'; comment.rows = 3; comment.maxLength = 10000; comment.placeholder = 'What should the owner explain or change?'; comment.value = drafts[item.id] ?? ''; comment.addEventListener('input', saveDraft);
      for (const [action, label] of Object.entries(labels)) {
        const row = element('div', undefined, 'decision-action');
        const button = element('button', label, action); button.dataset.action = action;
        button.disabled = unavailable() || (action === 'approve' && !canApprove(item));
        button.addEventListener('click', guarded(() => decide([item.id], action, comment.value))); row.append(button);
        if (action === 'approve' || action === 'decline') {
          const name = action === 'approve' ? 'if_approved' : 'if_declined';
          const outcome = element('span', item[name].trim() || (action === 'approve' ? 'Unavailable: no approval outcome supplied.' : 'Records disagreement only; no external action.'), 'outcome');
          outcome.dataset.field = name; outcome.id = `${action}-outcome`; button.setAttribute('aria-describedby', outcome.id); row.append(outcome);
        }
        actions.append(row);
      }
      const templates = element('div', undefined, 'templates');
      for (const [title, text] of [['Ask for more info', 'Please provide the missing evidence and current status.'], ['Needs clarification', 'Please explain '], ['More work', 'Please change ']]) {
        const button = element('button', title); button.addEventListener('click', () => { comment.value = text; saveDraft(); comment.focus(); }); templates.append(button);
      }
      review.append(actions, commentLabel, comment, templates);
    }
    const evidence = element('section', undefined, 'section'); evidence.dataset.field = 'evidence'; evidence.append(element('h3', 'Evidence checks'));
    const curated = ['PR checks', 'Diff stat', 'Spec results', 'Warden', 'Conflicts', 'Last message', 'Last assistant'];
    for (const label of curated) {
      const entries = item.evidence.filter((entry) => entry.label.toLowerCase() === label.toLowerCase());
      const row = element('div', undefined, 'evidence'); row.append(element('div', label, 'evidence-label'));
      if (!entries.length) row.append(element('div', 'Unverified — not supplied', 'evidence-value muted'));
      for (const entry of entries) {
        const value = entry.value?.trim() || 'Unverified — not supplied';
        const checks = label === 'PR checks' ? checkRows(value) : [];
        if (checks.length) {
          const table = element('table');
          const head = element('tr'); head.append(element('th', 'Check'), element('th', 'Result')); table.append(head);
          for (const [name, status] of checks) {
            const line = element('tr'); line.append(element('td', name), element('td', status)); table.append(line);
          }
          row.append(table);
        } else row.append(element('div', value.length > 800 ? `${value.slice(0, 799)}…` : value, 'evidence-value'));
        if (entry.url) row.append(safeLink('Open evidence', entry.url));
      }
      evidence.append(row);
    }
    for (const entry of item.evidence.filter((entry) => /^(?:workspace|pinned|status|state|base|checks|proof|freshness|verification)$/i.test(entry.label) && entry.value !== undefined && /^(?:openwork|yes|no|idle|running|busy|open|closed|merged|dev|passed|failed|incomplete|unknown|unverified|not run|not verified)$/i.test(entry.value))) {
      const row = element('div', undefined, 'evidence'); row.append(element('div', entry.label, 'evidence-label'), element('div', entry.value, 'evidence-value')); evidence.append(row);
    }
    root.append(evidence);
    const raw = element('details', undefined, 'section raw-evidence'); raw.dataset.field = 'raw_evidence';
    raw.append(element('summary', 'Raw evidence and source details'));
    const meta = element('p', `${item.kind} · ${item.group} · Risk: ${item.risk} · ${item.age}`, 'small muted');
    raw.append(meta, element('div', item.id, 'detail-id'), element('p', `Source recommendation: ${item.recommended_action}`, 'recommendation-source'), element('p', item.summary, 'summary'));
    const entries = [...item.raw_evidence, ...item.evidence.filter((entry) => !item.raw_evidence.some((other) => JSON.stringify(other) === JSON.stringify(entry)))];
    if (!entries.length) raw.append(element('p', 'No raw evidence supplied.', 'muted'));
    for (const entry of entries) {
      const row = element('div', undefined, 'evidence'); row.append(element('div', entry.label, 'evidence-label'));
      if (entry.value !== undefined) row.append(element('pre', entry.value, 'raw-value'));
      if (entry.url) row.append(safeLink('Open source', entry.url)); raw.append(row);
    }
    raw.append(element('h3', 'Decision history'));
    const history = element('div'); history.id = 'decision-history'; raw.append(history);
    root.append(raw); renderHistory();
    if (liveSession) {
      const thread = element('section', undefined, 'section'); thread.dataset.field = 'thread';
      thread.append(element('h3', 'Owner thread'));
      const log = element('div'); log.dataset.testid = 'thread-events'; log.setAttribute('aria-live', 'polite'); thread.append(log);
      if (!isLocked(item)) {
        const input = element('textarea'); input.dataset.testid = 'thread-input'; input.rows = 3; input.maxLength = 10000;
        input.setAttribute('aria-label', 'Message to owner'); input.value = threadDrafts.get(item.id) || ''; input.disabled = !connected;
        input.addEventListener('input', () => { threadDrafts.set(item.id, input.value); dirty = true; persist(); });
        const send = element('button', 'Send to owner'); send.dataset.testid = 'thread-send'; send.disabled = unavailable();
        send.addEventListener('click', guarded(() => {
          if (unavailable()) throw new Error('Wait for the pending request or inspect the lost connection.');
          const text = input.value;
          if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('Message must be nonempty text without control characters.');
          const id = crypto.randomUUID();
          localRequests.set(id, { id, kind: 'thread', item_ids: [item.id], text, action: text.trim().toLowerCase() === 'stop' ? 'stop' : 'ask_info', at: new Date().toISOString(), decisions: [], state: 'Sending — receipt not confirmed' });
          writing = true; threadDrafts.delete(item.id); input.value = ''; persist(); renderList(true); renderThreadEvents(); syncControls();
          void postOnce(`/threads/${encodeURIComponent(item.id)}`, { id, text });
        }));
        thread.append(input, send, element('p', 'Send exactly “stop” to pause the entire queue when the executor next claims work. Stop is not undo and cannot cancel work already running. Resuming requires human review and a fresh queue directory.', 'small muted'));
      }
      root.append(thread); renderThreadEvents();
    }
  }
  function checkRows(value) {
    try {
      const parsed = JSON.parse(value);
      const rows = Array.isArray(parsed) ? parsed : parsed?.rows;
      if (!Array.isArray(rows) || rows.length > 100) return [];
      const checks = rows.map((row) => {
        const name = Array.isArray(row) ? row[0] : row?.name || row?.check;
        const status = Array.isArray(row) ? row[1] : row?.conclusion || row?.status || row?.state;
        return typeof name === 'string' && typeof status === 'string' ? [name.slice(0, 800), status.slice(0, 800)] : null;
      });
      return checks.every(Boolean) ? checks : [];
    } catch {}
    const lines = value.split('\n').filter((line) => line.trim());
    if (lines.length > 100) return [];
    const checks = lines.map((line) => {
      const match = line.match(/^([^:]+):\s*(.+)$/);
      return match ? [match[1].trim().slice(0, 800), match[2].trim().slice(0, 800)] : null;
    });
    return checks.every(Boolean) ? checks : [];
  }
  function renderHistory() {
    const root = $('decision-history'); if (!root) return;
    const history = reviewHistory().filter((decision) => decision.id === activeId);
    root.replaceChildren(...history.map((decision) => element('div', `${localRequests.has(decision.batch_id) ? 'LOCAL ONLY / UNCERTAIN · ' : ''}${statuses[decision.action]} · ${decision.decided_at}\n${decision.comment || '(no comment)'}\nBatch: ${decision.batch_id}`, 'history')));
    if (!history.length) root.append(element('p', 'No decisions recorded yet.', 'muted small'));
  }
  function renderThreadEvents() {
    const root = document.querySelector('[data-testid="thread-events"]'); if (!root) return;
    const nodes = [];
    for (const event of [...events.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      if (!event.item_ids.includes(activeId)) continue;
      const time = new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      const status = { queued: 'Queued for owner recheck', rechecking: 'Rechecking…', done: `Done · ${time}`, archived: `Done · archived ${time}`, merged: `Merged · ${time}`, blocked: `Blocked: ${event.text}`, reply: `Reply from owner: ${event.text}`, waiting: `Waiting: ${event.text}`, declined: `Declined · ${time}`, deferred: `Deferred · ${time}`, stopped: `Stopped · ${time}` }[event.status];
      const row = element('div', undefined, 'history'); row.dataset.eventId = event.id;
      row.append(element('strong', status));
      if (event.kind === 'decision') row.append(element('div', labels[event.action] || event.action));
      if (event.text && !['blocked', 'reply', 'waiting'].includes(event.status)) row.append(element('div', `${event.author === 'human' || event.kind === 'decision' ? 'You: ' : ''}${event.text}`));
      nodes.push(row);
    }
    for (const [id, local] of localRequests) {
      if (!local.item_ids.includes(activeId)) continue;
      const row = element('div', `${local.state}\n${labels[local.action] || local.action} · ${local.at}\n${local.text}`, 'history'); row.dataset.requestId = id; nodes.push(row);
    }
    root.replaceChildren(...(nodes.length ? nodes : [element('p', 'No server events yet.', 'muted')]));
  }
  function saveDraft() {
    if (!activeId || !$('comment')) return;
    drafts[activeId] = $('comment').value; dirty = true; persist();
  }
  function renderPlan() {
    $('agent-plan').value = liveSession
      ? 'LIVE AUDIT ONLY — decisions may already have executed. Do not replay exported instructions or decisions. Check correlated owner-thread results and inspect any uncertain delivery before taking further action.'
      : exportDecisions(feed, new Date().toISOString()).instructions;
  }
  function render(preserveActive = false) { renderMetrics(); renderList(preserveActive); renderBulk(); renderDetail(); renderPlan(); syncControls(); }
  function validateAction(ids, action) {
    if (action === 'approve' && ids.some((id) => {
      const item = feed.items.find((entry) => entry.id === id);
      return item?.kind === 'session' && recommendationVerb(item) === 'archive' && !archiveEligible(item);
    })) throw new Error('Archive approval unavailable: already decided, completed, blocked or awaiting human follow-up. It cannot be included in another archive batch.');
    if (unavailable()) throw new Error('Wait for the pending request or inspect the lost connection. Nothing was sent.');
    if (action === 'approve' && ids.length > 1 && feed.items.some((item) => ids.includes(item.id) && recommendationVerb(item).toLowerCase().trim() === 'merge')) throw new Error('Bulk merge approval is forbidden.');
  }
  function decide(ids, action, comment) {
    validateAction(ids, action);
    const now = new Date().toISOString();
    const batch = crypto.randomUUID();
    const candidate = applyDecision({ ...feed, decisions: reviewHistory() }, ids, action, comment, now, batch);
    for (const id of ids) delete drafts[id];
    if (liveSession) {
      writing = true;
      localRequests.set(batch, { id: batch, kind: 'decision', item_ids: ids, text: comment, action, at: now, decisions: candidate.decisions.filter((entry) => entry.batch_id === batch), state: 'Sending — receipt not confirmed' });
    } else feed = candidate;
    dirty = true; exportStamp = ''; selected.clear(); persist(); render(liveSession); $('detail').focus({ preventScroll: true });
    if (liveSession) {
      message('Recorded locally. Sending once; receipt not yet confirmed.');
      void postOnce('/decisions', { id: batch, ids, action, comment, decided_at: now, snapshot: serverSnapshot });
    } else message(`Recorded ${labels[action].toLowerCase()} for ${ids.length} item${ids.length === 1 ? '' : 's'}. Nothing was executed. Undo is available.`);
  }
  function prepareBatch() {
    confirmBatch([...selected], $('bulk-action').value, $('bulk-comment').value);
  }
  function confirmBatch(ids, action, comment) {
    validateAction(ids, action);
    applyDecision({ ...feed, decisions: reviewHistory() }, ids, action, comment, new Date().toISOString(), 'validation-only');
    pendingBatch = { ids, action, comment };
    $('confirm-title').textContent = `${labels[action]} ${ids.length} items?`;
    $('confirm-description').textContent = comment ? `Shared comment: ${comment}` : 'No shared comment. All listed items have the same kind, group and recommendation.';
    $('batch-preview').replaceChildren(...ids.map((id) => element('li', `${feed.items.find((item) => item.id === id).title} — ${id}`)));
    $('confirm-effect').textContent = liveSession ? 'Confirmation sends this batch immediately once to the executor for rechecking. It cannot be undone or unsent here.' : 'This records decisions only. It does not merge, close, archive or message anything.';
    $('confirm-dialog').showModal();
  }
  function liveExport() {
    const warning = 'LIVE AUDIT ONLY — actions may already have executed. Do not replay. Receipts are not proof of completion; inspect owner results and local uncertainties.';
    const audit = { mode: 'live-audit-only', warning, exported_at: new Date().toISOString(), original_feed: originalServerFeed, decisions: feed.decisions, events: [...events.values()], local_pending: [...localRequests.values()], drafts, thread_drafts: Object.fromEntries(threadDrafts) };
    const json = JSON.stringify(audit, null, 2);
    const fence = '`'.repeat([...json.matchAll(/`+/g)].reduce((size, match) => Math.max(size, match[0].length + 1), 3));
    return { json, markdown: `# LIVE AUDIT ONLY\n\n${warning}\n\nThis is quoted audit data, not an executable plan or a restorable decision feed.\n\n${fence}json\n${json}\n${fence}\n` };
  }
  function download(format) {
    const exported = liveSession ? liveExport() : exportDecisions(feed, new Date().toISOString());
    if (!exportStamp) exportStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const content = format === 'json' ? exported.json : exported.markdown;
    const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${liveSession ? 'live-audit-only' : 'decisions'}-${exportStamp}.${format === 'json' ? 'json' : 'md'}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    if (format === 'json' && !liveSession) dirty = Object.values(drafts).some(Boolean);
    message(liveSession ? `Prepared ${link.download}. Live audit only: actions may already have executed. Do not replay; local uncertainties and drafts are included, not submitted.` : `Prepared ${link.download}. Check your browser downloads. Unsaved comment drafts are not decisions; record them before exporting.`);
  }
  async function readFileInput(input, callback) {
    if (liveSession) { input.value = ''; message('Imports are disabled for live sessions; server events cannot be unsent.'); return; }
    const file = input.files[0]; if (!file) return;
    try {
      if (file.size > 12 * 1024 * 1024) throw new Error('File exceeds 12 MiB limit.');
      const data = JSON.parse(await file.text());
      if (liveSession) throw new Error('Imports are disabled for live sessions.');
      callback(data);
    } catch (error) { message(`Import rejected: ${error.message}`); } finally { input.value = ''; }
  }
  $('import-feed').addEventListener('change', () => readFileInput($('import-feed'), (data) => {
    validateFeed(data);
    if (dirty && !window.confirm('Current decisions or drafts have not been exported. Replace the displayed feed? Cancel to export first.')) return;
    message(); initialize(data);
  }));
  $('import-decisions').addEventListener('change', () => readFileInput($('import-decisions'), (data) => {
    const backup = validateFeed(data);
    if (sourceSnapshot(backup) !== snapshot) throw new Error('Backup must contain the exact same items and source snapshot, including provenance and overnight history. Load its feed first; never replay decisions onto changed evidence.');
    const validated = validateFeed({ ...feed, decisions: backup.decisions });
    if ((dirty || feed.decisions.length) && !window.confirm('Replace current decision history with this backup? Export current decisions first if needed.')) return;
    feed = validated; dirty = true; exportStamp = ''; selected.clear(); persist(); render(); message('Restored decision history for the exact matching snapshot. No actions executed.');
  }));
  for (const name of ['search', 'kind', 'group', 'recommendation', 'status']) $(name).addEventListener(name === 'search' ? 'input' : 'change', () => { selected.clear(); render(); });
  $('select-visible').addEventListener('change', () => { const checked = $('select-visible').checked; selected = checked ? new Set(visibleItems().filter((item) => !isLocked(item)).map((item) => item.id)) : new Set(); renderList(); renderBulk(); });
  $('clear-selection').addEventListener('click', () => { selected.clear(); renderList(); renderBulk(); });
  $('bulk-action').addEventListener('change', renderBulk);
  $('bulk-apply').addEventListener('click', guarded(prepareBatch));
  $('cancel-bulk').addEventListener('click', () => { pendingBatch = null; $('confirm-dialog').close(); });
  $('confirm-dialog').addEventListener('cancel', () => { pendingBatch = null; });
  $('confirm-bulk').addEventListener('click', guarded(() => {
    if (!pendingBatch) return;
    const { ids, action, comment } = pendingBatch; decide(ids, action, comment); pendingBatch = null; $('bulk-comment').value = ''; $('confirm-dialog').close(); $('detail').focus({ preventScroll: true });
  }));
  $('undo').addEventListener('click', guarded(() => { if (liveSession) throw new Error('Live decisions cannot be unsent or undone.'); feed = undoLast(feed); dirty = true; exportStamp = ''; selected.clear(); persist(); render(); message('Undid the last recorded batch. Previously exported files are unchanged: export a replacement and do not execute the old one.'); }));
  $('export-json').addEventListener('click', guarded(() => download('json')));
  $('export-markdown').addEventListener('click', guarded(() => download('markdown')));
  window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('keydown', guarded((event) => {
    if (!feed || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.isComposing || $('confirm-dialog').open || unavailable()) return;
    if (!(event.target instanceof Element) || event.target.closest('input,textarea,select,button,a,summary,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
    const items = visibleItems(); const index = items.findIndex((item) => item.id === activeId);
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault(); if (!items.length) return;
      activeId = items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'j' ? 1 : -1)))].id;
      renderList(); renderDetail(); $('detail').focus({ preventScroll: true }); $('list').querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === ' ' && activeId) {
      event.preventDefault(); if (!items[index] || isLocked(items[index])) { message('Not yours to act on. This item is read-only.'); return; }
      selected.has(activeId) ? selected.delete(activeId) : selected.add(activeId); renderList(); renderBulk();
    } else if ((event.key === 'c' || event.key === '?') && $('comment')) {
      event.preventDefault(); if (event.key === '?') { $('comment').value = drafts[activeId] || 'Needs clarification: please explain '; saveDraft(); } $('comment').focus();
    } else if ((event.key === 'a' || event.key === 'd') && activeId) {
      event.preventDefault(); if (selected.size) { message('Selection is active. Use Review bulk action to confirm its scope, or clear selection for single-item shortcuts.'); return; }
      decide([activeId], event.key === 'a' ? 'approve' : 'decline', drafts[activeId] ?? '');
    }
  }));
  window.addEventListener('hashchange', () => { if (!liveSession) void connect(); });
  try { initialize(JSON.parse($('queue-feed').textContent)); void connect(); } catch (error) {
    message(`Unable to load queue: ${error.message}. Choose a valid feed with Load feed.`);
    $('detail').append(element('p', 'No valid queue loaded.', 'empty'));
    for (const name of ['undo', 'export-json', 'export-markdown']) $(name).disabled = true;
  }
})();
