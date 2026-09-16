(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const labels = { approve: 'Approve', archive: 'Archive', close_pr: 'Close PR', decline: 'Keep', defer: 'Deferred (legacy)', ask_info: 'Message (legacy question)', request_changes: 'Message (legacy changes)', comment: 'Message (legacy note)', message: 'Message' };
  const statuses = { approve: 'Approved', archive: 'Archive requested', close_pr: 'PR closure requested', decline: 'Kept', defer: 'Deferred', ask_info: 'Asked for info', request_changes: 'Changes requested', comment: 'Message recorded', message: 'Message recorded' };
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
  const terminalStatuses = ['done', 'archived', 'merged', 'closed', 'declined', 'deferred', 'stopped'];
  const events = new Map();
  const ledgerInputs = new Map();
  let currentInputIds = new Set();
  let controlTarget = null;
  let logSignature = '';
  let logFilter = '';
  let readDeliveries = new Set();
  let laterIds = new Set();
  function restoreLater(value) {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((id) => !feed.items.some((item) => item.id === id && !isLocked(item)))) throw new Error('Invalid local Later list');
    laterIds = new Set(value);
  }
  function skipLater() {
    const item = feed.items.find((entry) => entry.id === activeId);
    if (!item || isLocked(item) || decisionsById().has(item.id)) throw new Error('Later is only a local skip for an undecided item');
    const order = [...visibleItems(), ...archiveItems()].map((entry) => entry.id);
    if (laterIds.has(item.id)) { laterIds.delete(item.id); $('status').value = 'human'; persist(); render(true); }
    else { laterIds.add(item.id); selected.delete(item.id); persist(); advanceReview(order, item.id); }
    message('Later is saved only in this browser. No decision, message or owner action was sent.');
  }
  function deliveryWasRead(item) {
    return deliveryOf(item)?.completeness === 'complete' && (liveSession
      ? [...events.values()].some((event) => event.kind === 'read' && currentInputIds.has(event.id) && event.deliverable === deliveryIdentity(item))
      : readDeliveries.has(deliveryIdentity(item)));
  }
  function readAllowed(item, action = 'approve') { return !chatOnly(item) || !isArchiveAction(item, action) || deliveryWasRead(item); }
  function primaryAction(item) { return recommendationVerb(item) === 'archive' && !canApprove(item) && canArchive(item) ? 'archive' : 'approve'; }
  function actionReady(item, action) {
    if (isArchiveAction(item, action)) return canArchive(item) && readAllowed(item, action);
    if (action === 'approve') return canApprove(item);
    if (action === 'close_pr') return canClosePr(item);
    return !isLocked(item);
  }
  const localRequests = new Map();
  const threadDrafts = new Map();
  const advances = new Map();
  function advanceReview(order, anchor) {
    const pending = new Set([...visibleItems(), ...archiveItems()].filter((item) => !decisionsById().has(item.id) && !isLocked(item)).map((item) => item.id));
    const index = order.indexOf(anchor);
    activeId = pending.has(anchor) ? anchor : [...order.slice(index + 1), ...order.slice(0, index + 1)].find((id) => pending.has(id)) ?? null;
    render(true); $('detail').focus({ preventScroll: true });
  }
  function unavailable() { return liveSession && (!connected || writing); }
  function syncControls() {
    $('mode-badge').textContent = liveSession ? connected ? 'LIVE' : 'CONNECTION LOST' : 'OFFLINE';
    for (const id of ['import-feed', 'import-decisions']) $(id).disabled = liveSession;
    $('undo').disabled = liveSession || !feed?.decisions.length;
    for (const button of document.querySelectorAll('#detail [data-action]')) {
      const item = feed.items.find((entry) => entry.id === activeId);
      button.disabled = unavailable() || !actionReady(item, button.dataset.action);
    }
    const send = document.querySelector('[data-testid="thread-send"]');
    if (send) send.disabled = unavailable();
    const input = document.querySelector('[data-testid="thread-input"]');
    if (input) input.disabled = !connected;
    const batch = document.querySelector('[data-testid="archive-batch"] button[data-batch-approve]');
    if (batch) batch.disabled = unavailable() || new Set(archiveItems().map(shape)).size !== 1;
    renderBulk(); renderActionLog(); renderCardControls();
    $('confirm-control').disabled = unavailable();
    const read = document.querySelector('[data-testid="mark-read"]');
    if (read) { const item = feed.items.find((entry) => entry.id === activeId); read.disabled = unavailable() || deliveryOf(item).completeness !== 'complete'; read.textContent = deliveryWasRead(item) ? 'Marked read' : 'Mark read'; }
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
  function acceptEvents(incoming, inputs = [], currentIds) {
    if (currentIds) currentInputIds = new Set(currentIds);
    else for (const event of incoming) if (event.id === event.decision_id) currentInputIds.add(event.id);
    if (!Array.isArray(incoming) || !Array.isArray(inputs)) throw new Error('Invalid result events');
    for (const input of inputs) ledgerInputs.set(input.id, input);
    const nextEvents = new Map(events);
    const before = listState();
    const decisions = new Map(originalServerFeed.decisions.map((entry) => [JSON.stringify([entry.batch_id, entry.id]), entry]));
    for (const event of [...events.values(), ...incoming]) {
      if (!event || typeof event.id !== 'string' || typeof event.decision_id !== 'string' ||
          !Array.isArray(event.item_ids) || !event.item_ids.every((id) => typeof id === 'string') ||
          !['decision', 'thread', 'status', 'control', 'compensation', 'read'].includes(event.kind) ||
          !['queued', 'rechecking', 'done', 'archived', 'merged', 'blocked', 'reply', 'waiting', 'declined', 'deferred', 'stopped', 'withdrawn', 'no_effect', 'sent', 'unarchived', 'cancelled', 'read', 'closed'].includes(event.status) ||
          typeof event.text !== 'string' || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid result event');
      if (nextEvents.has(event.id) && JSON.stringify(nextEvents.get(event.id)) !== JSON.stringify(event)) throw new Error('Conflicting result event');
      nextEvents.set(event.id, event);
      if (event.kind === 'decision' && currentInputIds.has(event.id)) {
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
    for (const id of laterIds) if (decisionsById().has(id)) laterIds.delete(id);
    persist();
    if (before !== listState()) renderList(true);
    renderMetrics(); renderPlan(); renderHistory(); renderThreadEvents(); syncControls();
    for (const [id, advance] of advances) {
      if (!events.has(id)) continue;
      advances.delete(id);
      if (activeId === advance.anchor) advanceReview(advance.order, advance.anchor);
    }
  }
  async function pollResults() {
    if (!connected) return;
    try {
      const result = await request(`/results?since=${cursor}`);
      if (!Number.isSafeInteger(result.cursor) || result.cursor < cursor) throw new Error('Invalid result cursor');
      acceptEvents(result.events, result.inputs, result.current_ids); cursor = result.cursor;
    } catch { connectionLost(); }
    if (connected) setTimeout(pollResults, 3000);
  }
  async function postOnce(path, body) {
    try {
      const receipt = await request(path, body);
      if (receipt.id !== body.id) throw new Error('Uncorrelated receipt');
      acceptEvents([receipt]);
      if (receipt.kind === 'control') {
        const result = await request(`/results?since=${cursor}`);
        acceptEvents(result.events, result.inputs, result.current_ids); cursor = result.cursor;
      }
      message('Received by the server. Inspect the action log for withdrawal, dependencies and execution outcomes; acceptance is not completion.');
    } catch (error) {
      if (events.has(body.id)) {
        message('Server receipt confirmed by polling. Follow the thread; this request will not be retried.');
      } else {
        const local = localRequests.get(body.id);
        if (local) local.state = uncertainState;
        connectionLost(); message(`${error.message}. Unconfirmed change is local only / delivery uncertain. Inspect the action log; no automatic retry.`); renderThreadEvents();
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
      const protocol = await request('/protocol');
      if (protocol.protocol !== 4 || typeof protocol.epoch !== 'string') throw new Error('Unsupported queue protocol; coordinated owner upgrade required');
      $('mode-badge').title = `Queue protocol ${protocol.protocol} · epoch ${protocol.epoch}`;
      const original = validateFeed(await request('/feed'));
      originalServerFeed = original;
      serverSnapshot = JSON.stringify({ ...original, decisions: [] });
      initialize(original, false);
      const result = await request('/results?since=0');
      if (!Number.isSafeInteger(result.cursor) || result.cursor < 0) throw new Error('Invalid result cursor');
      acceptEvents(result.events, result.inputs, result.current_ids); cursor = result.cursor;
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
    return { mode: 'live-local-v2', sourceSnapshot: snapshot, drafts, threadDrafts: Object.fromEntries(threadDrafts), later: [...laterIds], localRequests: [...localRequests.values()] };
  }
  function restoreLive() {
    try {
      const raw = localStorage.getItem(savedKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.sourceSnapshot !== snapshot) throw new Error('Stored source differs from server source');
        restoreLater(saved.later);
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
              !['decision', 'thread', 'control', 'read'].includes(local.kind) || !Array.isArray(local.item_ids) || !local.item_ids.length || new Set(local.item_ids).size !== local.item_ids.length ||
              !local.item_ids.every((id) => feed.items.some((item) => item.id === id && !isLocked(item))) ||
              typeof local.text !== 'string' || local.text.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(local.text) ||
              typeof local.at !== 'string' || !Number.isFinite(Date.parse(local.at)) || !Array.isArray(local.decisions) || typeof local.state !== 'string') throw new Error('Invalid local audit entry');
          if (local.kind === 'decision') {
            const validated = validateFeed({ ...feed, decisions: local.decisions }).decisions;
            if (validated.length !== local.item_ids.length || validated.some((entry, index) => entry.id !== local.item_ids[index] || entry.batch_id !== local.id || entry.action !== local.action || entry.comment !== local.text || entry.decided_at !== local.at)) throw new Error('Uncorrelated local decision');
          } else if (local.kind === 'read') {
            if (local.decisions.length || local.item_ids.length !== 1 || local.action !== 'read') throw new Error('Invalid local read');
          } else if (local.kind === 'control') {
            if (local.decisions.length || !['undo', 'change'].includes(local.action)) throw new Error('Invalid local control');
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
      localStorage.setItem(savedKey, JSON.stringify(liveSession ? liveRecord() : { sourceSnapshot: snapshot, decisions: feed.decisions, drafts, reads: [...readDeliveries], later: [...laterIds] }));
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
    readDeliveries = new Set(); laterIds = new Set();
    dirty = false;
    if (restore) {
      try {
        const raw = localStorage.getItem(savedKey);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved.sourceSnapshot !== snapshot) throw new Error('Stored feed does not match this snapshot. No decisions restored.');
          const restored = validateFeed({ ...feed, decisions: saved.decisions, drafts: saved.drafts ?? {} });
          feed = restored; restoreLater(saved.later);
          if (saved.reads !== undefined) {
            if (!Array.isArray(saved.reads) || saved.reads.some((identity) => !feed.items.some((item) => deliveryIdentity(item) === identity))) throw new Error('Invalid stored read acknowledgement');
            readDeliveries = new Set(saved.reads);
          }
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
  function withdrawnIds() { return new Set([...events.values()].filter((event) => event.kind === 'control').map((event) => event.target_id)); }
  function decisionsById() {
    const withdrawn = withdrawnIds();
    return new Map(reviewHistory().filter((decision) => !withdrawn.has(decision.batch_id) && !isMessage(decision.action)).map((decision) => [decision.id, decision]));
  }
  function resultById() {
    const result = new Map();
    const withdrawn = withdrawnIds();
    for (const event of events.values()) {
      if (!currentInputIds.has(event.decision_id) || withdrawn.has(event.decision_id) || isMessage(event.action)) continue;
      if (['thread', 'read'].includes(event.kind) || (event.status === 'rechecking' && events.get(event.decision_id)?.kind === 'thread')) continue;
      for (const id of event.item_ids) result.set(id, event);
    }
    const messages = new Map();
    for (const event of events.values()) {
      if (isMessage(event.action) && currentInputIds.has(event.decision_id) && event.kind === 'status' && event.status !== 'rechecking') for (const id of event.item_ids) messages.set(id, event);
    }
    for (const [id, event] of messages) if (!result.has(id)) result.set(id, event);
    return result;
  }
  function needsHuman(item, decision, result) {
    if (isLocked(item) || laterIds.has(item.id)) return false;
    if (result && (!decision || Date.parse(result.at) >= Date.parse(decision.decided_at))) {
      if (['blocked', 'waiting'].includes(result.status)) return true;
      if (['unarchived', 'cancelled', 'no_effect'].includes(result.status)) return !decision && !archiveEligible(item);
      if (result.kind === 'control') return result.status === 'withdrawn' && !result.replacement_id && !archiveEligible(item);
      if (result.kind === 'compensation') return false;
      if (terminalStatuses.includes(result.status)) return false;
    }
    if ([...localRequests.values()].some((local) => local.item_ids.includes(item.id))) return true;
    if (item.archived || decision) return false;
    return (chatOnly(item) && recommendationVerb(item) === 'archive' && !readAllowed(item)) || ['merge', 'review', 'relaunch', 'blockers'].includes(recommendationVerb(item));
  }
  function archiveEligible(item, decisions = decisionsById(), results = resultById()) {
    return !laterIds.has(item.id) && item.kind === 'session' && recommendationVerb(item) === 'archive' && canArchive(item) && readAllowed(item) && !item.protected && !item.archived && !isLocked(item)
      && !decisions.has(item.id) && ![...localRequests.values()].some((local) => local.item_ids.includes(item.id))
      && !['blocked', 'waiting', ...terminalStatuses].includes(results.get(item.id)?.status)
      && ![...events.values()].some((event) => event.kind === 'compensation' && event.item_ids.includes(item.id) && !['unarchived', 'cancelled'].includes([...events.values()].filter((entry) => entry.decision_id === event.id).at(-1)?.status))
      && ![...events.values()].some((event) => event.item_ids.includes(item.id) && terminalStatuses.includes(event.status) && !withdrawnIds().has(event.decision_id));
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
      : $('status').value === 'later' ? laterIds.has(item.id)
        : $('status').value === 'decided' ? decisions.has(item.id)
        : $('status').value === 'pending' ? !isLocked(item) && !decisions.has(item.id) && !laterIds.has(item.id)
        : $('status').value === 'message' ? reviewHistory().some((entry) => entry.id === item.id && isMessage(entry.action))
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
    approve.addEventListener('click', guarded(() => confirmBatch(items.map((item) => item.id), items.every(canApprove) ? 'approve' : 'archive', '')));
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
    const pending = actionable - decisions.length - [...laterIds].filter((id) => !decisions.some((entry) => entry.id === id)).length;
    $('status').querySelector('option[value="later"]').textContent = `Later (${laterIds.size})`;
    const deferred = decisions.filter((d) => d.action === 'defer').length;
    const followups = reviewHistory().filter((decision) => isMessage(decision.action)).length;
    $('metrics').replaceChildren();
    for (const [count, label] of [[feed.items.length, 'total'], [pending, 'pending'], [approved, 'approved'], [decisions.filter((entry) => entry.action === 'archive').length, 'archive requests'], [decisions.filter((entry) => entry.action === 'close_pr').length, 'close requests'], [declined, 'kept'], [followups, 'follow-ups / comments'], [deferred, 'deferred'], [locked, 'nothing to decide']]) {
      const metric = element('span'); metric.append(element('strong', String(count)), document.createTextNode(` ${label}`)); $('metrics').append(metric);
    }
    $('progress').style.width = `${actionable ? ((approved + declined + decisions.filter((entry) => ['archive', 'close_pr'].includes(entry.action)).length) / actionable) * 100 : 0}%`;
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
      open.append(element('span', item.title, 'row-title'), element('span', displayProse(item.purpose, item), 'row-summary'));
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
    const missingOutcome = bulkMerge || items.some((item) => !actionReady(item, 'approve')) || items.some((item) => item.kind === 'worktree') && items.length > 1;
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
  function displayProse(value, item) {
    const sessionTools = { read: 'session details', send: 'session messaging', archive: 'session archiving', search: 'session search', 'search/read': 'session search and details', activity: 'session activity', create: 'session creation', stop: 'session stopping' };
    const prActions = { merge: 'merge pull request', view: 'view pull request', checks: 'pull-request checks', diff: 'pull-request diff', list: 'list pull requests', status: 'pull-request status', review: 'review pull request', close: 'close pull request', reopen: 'reopen pull request' };
    const treeActions = { add: 'create working copy', remove: 'remove working copy', list: 'list working copies', prune: 'clean up working-copy references' };
    return value.replace(/\bses_[A-Za-z0-9]+\b/g, (id) => {
      if (id === item.id) return 'this session';
      const related = feed.items.find((entry) => entry.id === id);
      return related ? `“${related.title.replace(/\bses_[A-Za-z0-9]+\b/g, 'related session')}”` : 'related session';
    }).replace(/\bOpenWork Chat session this session\b/g, 'this OpenWork Chat session')
      .replace(/\bsession (this session|related session)\b/g, '$1')
      .replace(/\bsession\.(search\/read|read|send|archive|search|activity|create|stop)\b/g, (_, tool) => sessionTools[tool])
      .replace(/\bgh pr(?: (merge|view|checks|diff|list|status|review|close|reopen))?\b/g, (_, action) => prActions[action] || 'pull requests')
      .replace(/\bgit worktree(?: (add|remove|list|prune))?\b/g, (_, action) => treeActions[action] || 'working copy')
      .replace(/`+/g, '');
  }
  function shortOutcome(item, action) {
    if (action === 'decline') return item.kind === 'session' && !item.archived ? 'leave this session open' : item.kind === 'pr' ? 'leave this PR unchanged' : 'leave this item unchanged';
    if (!canApprove(item)) return 'unavailable — no actionable approval outcome';
    const verb = recommendationVerb(item);
    if (verb === 'archive' && item.kind === 'session') return 'archive this session';
    if (verb === 'merge' && item.kind === 'pr') return 'merge this PR';
    const clause = displayProse(item.if_approved || item.question, item).replace(/\s+/g, ' ').split(/;|\b(?:only after|subject to|provided that|otherwise)\b|(?<=[.!?])\s/i)[0].trim();
    return clause.length > 100 ? `${clause.slice(0, 99).replace(/\s+\S*$/, '')}…` : clause;
  }
  function suppliedEvidence(entry) {
    const value = entry.value?.trim();
    return Boolean(entry.url || (value && !/^(?:(?:unknown|unverified)(?:[.!]?$|\s*[—:–-]\s*(?:no\b|not\b|.*(?:not supplied|not applicable|unavailable)))|not (?:supplied|applicable)\b|n\/a\b)/i.test(value)));
  }
  function nonCodeItem(item) {
    return item.kind !== 'pr' && !item.pr_url && !item.links.some((link) => /\/pull\//.test(link.url))
      && /\b(?:non-code|documentation only|no runtime change|no (?:code|product-code) change|(?:review )?report only|Notion (?:page|note|document))\b/i.test(`${item.status_on_dev} ${item.purpose}`);
  }
  function renderDelivery(item, root) {
    const delivery = deliveryOf(item);
    root.append(element('strong', deliveryClassification(item)), element('p', delivery ? `Completeness: ${delivery.completeness} · ${delivery.observed_at} · ${delivery.provenance}` : 'Complete answers and delivery type are unknown. A summary is not the delivered answer.', 'small muted'));
    const route = sessionRoute(item);
    if (isLocked(item)) { root.append(element('div', route || `Session: ${item.id} · workspace unknown`, 'raw-value')); return; }
    const routeField = element('textarea'); routeField.readOnly = true; routeField.rows = 2; routeField.setAttribute('aria-label', 'Open in OpenWork — copy route and IDs');
    routeField.value = `${route || 'Route unknown'}\nSession: ${item.id} · Workspace: ${item.workspace_id || 'unknown'}`; root.append(element('div', 'Open in OpenWork — copy route and IDs', 'small muted'), routeField);
    if (!delivery) return;
    const answers = element('details'); answers.dataset.testid = 'delivery-answers'; answers.append(element('summary', 'Read full questions and answers'));
    for (const exchange of delivery.exchanges) {
      answers.append(element('h3', `Question · ${exchange.at || 'date unknown'}`), element('pre', exchange.question, 'raw-value'));
      for (const answer of exchange.answers) answers.append(element('h3', `Assistant · ${answer.at || 'date unknown'}`), element('pre', answer.text, 'raw-value'));
    }
    if (chatOnly(item) && !isLocked(item)) {
      const read = element('button', deliveryWasRead(item) ? 'Marked read' : 'Mark read'); read.dataset.testid = 'mark-read';
      read.disabled = delivery.completeness !== 'complete' || unavailable();
      read.addEventListener('click', guarded(() => {
        if (!answers.open || delivery.completeness !== 'complete' || unavailable()) throw new Error('Expand complete answers before marking read');
        if (!liveSession) { readDeliveries.add(deliveryIdentity(item)); persist(); renderList(true); syncControls(); read.textContent = 'Marked read'; return; }
        const id = crypto.randomUUID();
        localRequests.set(id, { id, kind: 'read', item_ids: [item.id], action: 'read', text: 'Mark complete answers read', at: new Date().toISOString(), decisions: [], state: 'Sending read acknowledgement' });
        writing = true; persist(); syncControls();
        void postOnce('/reads', { id, item_id: item.id, snapshot: serverSnapshot, deliverable: deliveryIdentity(item) });
      }));
      answers.append(read);
    }
    root.append(answers);
    if (liveSession && !isLocked(item)) {
      const download = element('button', 'Download full deliverable (.md)');
      download.addEventListener('click', () => {
        void request(`/deliverables/${item.id}.md`).then((file) => {
          const url = URL.createObjectURL(new Blob([file.markdown], { type: 'text/markdown;charset=utf-8' }));
          const link = element('a'); link.href = url; link.download = `${item.id}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
        }).catch(() => message('Deliverable download failed; no read acknowledgement was recorded.'));
      }); root.append(download);
    } else if (!isLocked(item)) {
      const link = element('a', 'Open private deliverable (.md)'); link.href = `deliverables/${item.id}.md`; link.download = `${item.id}.md`; root.append(link);
    }
  }
  function renderDetail() {
    const root = $('detail'); root.replaceChildren();
    const item = feed.items.find((candidate) => candidate.id === activeId);
    if (!item) { root.append(element('p', 'No more cards needing a decision in this view. Open Decided to review recorded choices, or change filters.', 'empty')); return; }
    const heading = element('h2', item.title); heading.dataset.testid = 'detail-title';
    root.append(heading);
    function field(name, label, value) {
      const section = element('section', undefined, 'section'); section.dataset.field = name;
      section.append(element('h3', label), element('p', displayProse(value, item), 'summary')); root.append(section); return section;
    }
    field('purpose', 'Purpose', item.purpose || 'Purpose not supplied.');
    field('status_on_dev', 'Status on dev', item.status_on_dev || 'Not verified on dev.');
    const delivered = field('delivered', 'Delivered', item.delivered || 'No delivery summary supplied.');
    if (item.kind === 'session') renderDelivery(item, delivered);
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
      const actions = element('div', undefined, 'decision-actions');
      const commentLabel = element('label', 'Comment or follow-up request'); commentLabel.htmlFor = 'comment';
      const comment = element('textarea'); comment.id = 'comment'; comment.dataset.testid = 'comment'; comment.rows = 3; comment.maxLength = 10000; comment.placeholder = 'What should the owner explain or change?'; comment.value = drafts[item.id] ?? ''; comment.addEventListener('input', saveDraft);
      const proposed = recommendationVerb(item) === 'archive' ? 'archive this session' : canApprove(item) ? shortOutcome(item, 'approve') : recommendationVerb(item).replaceAll('_', ' ');
      const choices = [[primaryAction(item), canReclaim(item) ? 'Reclaim' : `Approve: ${proposed.slice(0, 80)}`], ['decline', 'Keep']];
      if (canArchive(item) && recommendationVerb(item) !== 'archive') choices.push(['archive', 'Archive']);
      if (canClosePr(item)) choices.push(['close_pr', 'Close PR']);
      for (const [action, label] of choices) {
        const row = element('div', undefined, 'decision-action');
        const button = element('button', label, action); button.dataset.action = action;
        button.disabled = unavailable() || !actionReady(item, action);
        button.addEventListener('click', guarded(() => {
          if (action === 'close_pr' && !window.confirm(`Close this exact PR? ${item.pr_url}\nHead: ${item.head_sha}\nAuthorization: ${actionAuthorization(item, 'close_pr').text}`)) return;
          if (canReclaim(item) && action === 'approve' && !window.confirm(`Record this exact reclaim instruction for owner recheck?\n${reclaimCommand(item)}\nAuthorization: ${actionAuthorization(item, 'reclaim').text}`)) return;
          decide([item.id], action, comment.value);
        })); row.append(button);
        if (action === 'approve' || action === 'decline') {
          const name = action === 'approve' ? 'if_approved' : 'if_declined';
          const outcome = element('span', shortOutcome(item, action), 'outcome');
          outcome.dataset.field = name; outcome.id = `${action}-outcome`; button.setAttribute('aria-describedby', outcome.id); row.append(outcome);
        }
        actions.append(row);
      }
      const later = element('button', laterIds.has(item.id) ? 'Return to queue' : 'Later'); later.dataset.localAction = 'later'; later.disabled = decisionsById().has(item.id); later.addEventListener('click', guarded(skipLater)); actions.append(later);
      const send = element('button', liveSession ? 'Send to owner' : 'Record message (offline)'); send.dataset.testid = 'thread-send'; send.disabled = unavailable(); send.addEventListener('click', guarded(() => decide([item.id], 'message', comment.value)));
      const templates = element('div', undefined, 'templates');
      for (const [title, text] of [['Why…?', 'Why '], ['Please change…', 'Please change '], ['Note:', 'Note: '], ['Needs clarification:', 'Needs clarification: ']]) {
        const button = element('button', title); button.addEventListener('click', () => { comment.value = text; saveDraft(); comment.focus(); }); templates.append(button);
      }
      review.append(actions, commentLabel, comment, templates, send);
      if (canReclaim(item)) { const command = element('pre', reclaimCommand(item), 'raw-value'); command.dataset.testid = 'reclaim-command'; review.append(command); }
      for (const action of ['close_pr', 'reclaim']) { const grant = actionAuthorization(item, action); if (grant) review.append(element('p', `Explicit authorization · ${grant.at} · ${grant.provenance}\n${grant.text}`, 'raw-value')); }
      if (threadDrafts.has(item.id)) review.append(element('p', `Legacy owner draft retained, not sent: ${threadDrafts.get(item.id)}`, 'raw-value'));
      if (liveSession) { const controls = element('div'); controls.id = 'card-controls'; review.append(controls); renderCardControls(); }
    }
    const evidence = element('section', undefined, 'section'); evidence.dataset.field = 'evidence'; evidence.append(element('h3', 'Evidence checks'));
    const curated = ['PR checks', 'Diff stat', 'Spec results', 'Warden', 'Conflicts', 'Last message', 'Last assistant'];
    const codeLabels = ['PR checks', 'Diff stat', 'Spec results', 'Warden', 'Conflicts'];
    const suppliedCode = item.evidence.some((entry) => codeLabels.some((label) => entry.label.toLowerCase() === label.toLowerCase()) && suppliedEvidence(entry));
    if (!suppliedCode) evidence.append(element('p', nonCodeItem(item) ? 'No code checks apply to this item' : 'Code checks not supplied — recheck before approving', 'muted small'));
    for (const label of curated) {
      const entries = item.evidence.filter((entry) => entry.label.toLowerCase() === label.toLowerCase() && suppliedEvidence(entry));
      if (!entries.length) continue;
      const row = element('div', undefined, 'evidence'); row.append(element('div', label, 'evidence-label'));
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
    for (const entry of item.evidence.filter((entry) => suppliedEvidence(entry) && /^(?:workspace|pinned|status|state|base|checks|proof|freshness|verification)$/i.test(entry.label) && entry.value !== undefined && /^(?:openwork|yes|no|idle|running|busy|open|closed|merged|dev|passed|failed|incomplete|unknown|unverified|not run|not verified)$/i.test(entry.value))) {
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
    for (const name of ['purpose', 'delivered', 'status_on_dev', 'why', 'question', 'if_approved', 'if_declined']) {
      if (!name.startsWith('if_') && displayProse(item[name], item) === item[name]) continue;
      const original = element('pre', item[name], 'raw-value'); original.dataset.proseSource = name;
      raw.append(element('h3', `Original ${name.replaceAll('_', ' ')}`), original);
    }
    raw.append(element('h3', 'Decision history'));
    const history = element('div'); history.id = 'decision-history'; raw.append(history);
    root.append(raw); renderHistory();
    const safety = element('details', undefined, 'section safety-gates'); safety.dataset.testid = 'safety-gates';
    safety.append(element('summary', 'Safety gates'));
    const gates = item.kind === 'pr'
      ? 'Recheck the exact head and base, open state, required checks, specs, reviews and conflicts. Merge requires current explicit authorization; declining never closes a PR.'
      : item.kind === 'session'
        ? 'Recheck exact identity, pins, the operator’s active root, external ownership, busy/working and descendants, read acknowledgement and unresolved safety. Explicit LIVE human approval can authorize cross-workspace archival; agent-only scope and owned-task-worktree rules must not become a scope-only veto or use coordinator dirt as a substitute. Follow-ups require an explicit owner and reviewed text.'
        : 'Recheck ownership, current evidence, permissions and the exact requested scope. Proposals and worktree changes require separate authorization.';
    safety.append(element('p', `${gates} Protected items remain protected. ${liveSession ? 'New decisions are sent once for recheck, not proof of completion; they cannot be unsent.' : 'Offline decisions record intent only; nothing is executed.'}`, 'small muted'));
    root.append(safety);
    if (liveSession) {
      const thread = element('section', undefined, 'section'); thread.dataset.field = 'thread';
      thread.append(element('h3', 'Owner thread'));
      const log = element('div'); log.dataset.testid = 'thread-events'; log.setAttribute('aria-live', 'polite'); thread.append(log);
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
  function controlActions(input) {
    const root = element('div', undefined, 'actions');
    if (!liveSession || !['decision', 'thread'].includes(input.kind) || input.action === 'stop') return root;
    const history = [...events.values()].filter((event) => event.decision_id === input.id && event.id !== input.id);
    const lastEvent = history.some((event) => event.status === 'rechecking') ? history.filter((event) => event.kind === 'status' && event.status !== 'reply').at(-1) : undefined;
    const last = lastEvent?.status;
    const outcomes = lastEvent?.outcomes?.map((entry) => entry.status);
    const knownTargets = outcomes?.length === input.item_ids.length && outcomes.every((status) => ['no_effect', 'archived', 'sent', 'waiting', 'reply'].includes(status));
    const archiveEffect = last === 'archived' || outcomes?.includes('archived');
    const completedMessage = isMessage(input.action) && [last, ...(outcomes ?? [])].some((status) => ['sent', 'waiting', 'reply'].includes(status));
    const reason = !currentInputIds.has(input.id) ? 'Older snapshot — reconcile first'
      : withdrawnIds().has(input.id) ? 'Withdrawn / changed — follow the linked requests'
        : history.some((event) => event.status === 'merged' || event.outcomes?.some((outcome) => outcome.status === 'merged')) ? 'Merge is not reversible'
          : history.some((event) => event.status === 'closed' || event.outcomes?.some((outcome) => outcome.status === 'closed')) ? 'PR closure needs separate reopen authorization; no automatic rollback'
          : last === 'rechecking' ? 'Running — cannot interrupt'
            : last && input.item_ids.length > 1 && !outcomes && !['no_effect', 'declined', 'deferred'].includes(last) && !['decline', 'defer'].includes(input.action) ? 'Bulk outcome needs complete per-target receipts first'
              : last && !knownTargets && !['archived', 'no_effect', 'declined', 'deferred'].includes(last) && !completedMessage && !(last === 'done' && ['decline', 'defer'].includes(input.action)) ? 'Blocked, mixed or unknown — reconcile external effects first' : '';
    root.append(element('span', reason || (completedMessage ? 'Cannot unsend. A reviewed cancellation/follow-up will be sent.' : archiveEffect ? 'Undo queues unarchive after fresh checks.' : 'Queued withdrawal wins only before the atomic claim.'), 'small muted'));
    for (const mode of ['undo', 'change']) {
      const button = element('button', mode === 'undo' ? 'Undo decision' : 'Change decision');
      button.dataset.controlMode = mode; button.disabled = unavailable() || Boolean(reason) || localRequests.size > 0;
      button.addEventListener('click', () => {
        controlTarget = { input, mode };
        $('control-title').textContent = mode === 'undo' ? 'Undo this entire decision?' : 'Change this entire decision?';
        $('control-items').replaceChildren(...input.item_ids.map((id) => element('li', `${feed.items.find((item) => item.id === id)?.title || id} · ${id}`)));
        $('replacement-fields').hidden = mode !== 'change';
        const replacement = $('replacement-action'); replacement.replaceChildren(new Option('Approve proposed action', 'approve'), new Option('Keep', 'decline'));
        if (input.items.every((item) => canArchive(item) && readAllowed(item, 'archive'))) replacement.add(new Option('Archive', 'archive'));
        if (input.items.length === 1 && canClosePr(input.items[0])) replacement.add(new Option('Close PR', 'close_pr'));
        replacement.value = [...replacement.options].some((option) => option.value === input.action) ? input.action : 'decline';
        $('replacement-comment').value = '';
        $('control-text').value = '';
        $('control-effect').textContent = `${input.item_ids.length} target(s), whole batch only. ${completedMessage ? 'The original message cannot be unsent. Enter the exact cancellation/follow-up message.' : archiveEffect ? 'Queue unarchive only for targets explicitly reported archived, after live rechecks. Explicit no-effect targets need no compensation.' : 'Withdraw only if still unclaimed; running work cannot be interrupted.'} ${mode === 'change' ? 'The replacement waits for successful compensation. Failure or uncertainty blocks it.' : ''} History is append-only.`;
        $('control-dialog').showModal();
      });
      root.append(button);
    }
    return root;
  }
  function renderCardControls() {
    const root = $('card-controls'); if (!root) return;
    const latest = [...events.values()].filter((event) => event.id === event.decision_id && ['decision', 'thread'].includes(event.kind) && event.item_ids.includes(activeId)).at(-1);
    root.replaceChildren(...(latest ? [controlActions(latest)] : []));
  }
  function openLoggedCard(id) {
    if (!feed.items.some((item) => item.id === id)) { message('This card is from an older snapshot. Its history is retained; reload the matching source to inspect it.'); return; }
    for (const name of ['search', 'kind', 'group', 'recommendation', 'status']) $(name).value = '';
    selected.clear(); activeId = id; render(true); $('detail').focus({ preventScroll: true });
  }
  function renderActionLog() {
    const root = $('action-log');
    const states = effectiveActionStatuses([...events.values()]);
    for (const status of ['blocked', 'waiting']) {
      $(`show-${status}`).textContent = `${status === 'blocked' ? 'Blocked' : 'Waiting'} (${states.filter((entry) => entry.status === status).length})`;
      $(`show-${status}`).setAttribute('aria-pressed', String(logFilter === status));
    }
    const requests = new Map(ledgerInputs);
    for (const event of events.values()) if (event.id === event.decision_id) requests.set(event.id, event);
    for (const decision of feed?.decisions ?? []) {
      if (requests.has(decision.batch_id)) continue;
      const batch = feed.decisions.filter((entry) => entry.batch_id === decision.batch_id);
      requests.set(decision.batch_id, { id: decision.batch_id, item_ids: batch.map((entry) => entry.id), action: decision.action, at: decision.decided_at, text: decision.comment, status: liveSession ? 'Source history — not replayed' : 'Recorded offline — not executed' });
    }
    for (const [id, local] of localRequests) requests.set(id, { ...local, status: local.state });
    const signature = JSON.stringify([snapshot, logFilter, [...requests], [...events.values()], [...currentInputIds], unavailable()]);
    if (signature === logSignature) return;
    logSignature = signature;
    const nodes = [];
    for (const input of [...requests.values()].reverse()) {
      const current = states.filter((entry) => entry.request_id === input.id);
      if (logFilter && !current.some((entry) => entry.status === logFilter)) continue;
      const history = [...events.values()].filter((event) => event.decision_id === input.id && event.id !== input.id);
      const latest = history.filter((event) => event.kind === 'status' && event.status !== 'reply').at(-1);
      const currentStatuses = new Set(current.map((entry) => entry.status));
      const state = currentStatuses.size > 1 ? 'mixed target outcomes' : current[0]?.status || latest?.status || (liveSession && ledgerInputs.has(input.id) && !events.has(input.id) ? 'Unpublished — reconciliation needed' : input.status);
      const row = element('section', undefined, 'history'); row.dataset.logId = input.id;
      row.append(element('strong', `${labels[input.action] || input.action} · ${state === 'rechecking' ? 'running / rechecking' : state} · ${input.at}`));
      for (const id of input.item_ids) {
        const item = feed.items.find((entry) => entry.id === id) || input.items?.find((entry) => entry.id === id);
        const open = element('button', `${item?.title || id} · ${id}`); open.addEventListener('click', () => openLoggedCard(id)); row.append(open);
      }
      row.append(element('div', input.text || '(no comment)'), controlActions(input));
      for (const entry of current) {
        const verification = element('div', `Latest verification · ${entry.item_id} · ${entry.at} · ${entry.status} · ${entry.phase}\n${entry.text}`); verification.dataset.testid = 'latest-verification'; row.append(verification);
        for (const previous of entry.historical_blocked) row.append(element('div', `Historical blocked · ${previous.at} · ${previous.text}`, 'small muted'));
      }
      for (const name of ['target_id', 'control_id', 'compensation_id', 'replacement_id', 'depends_on']) {
        if (input[name]) row.append(element('div', `${name}: ${input[name]}`, 'small muted'));
      }
      for (const event of history) {
        row.append(element('div', `${event.at} · ${event.status === 'rechecking' ? 'running / rechecking' : event.status} · ${event.text}`));
        for (const outcome of event.outcomes ?? []) row.append(element('div', `${outcome.item_id} · ${outcome.status} · ${outcome.text}`));
      }
      nodes.push(row);
    }
    root.replaceChildren(...(nodes.length ? nodes : [element('p', logFilter ? 'No matching current incidents. All action history retains prior outcomes.' : 'No decisions recorded yet.', 'muted')]));
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
      const status = { queued: 'Queued for owner recheck', rechecking: 'Rechecking…', done: `Done · ${time}`, archived: `Done · archived ${time}`, merged: `Merged · ${time}`, blocked: `Blocked: ${event.text}`, reply: `Reply from owner: ${event.text}`, waiting: `Waiting: ${event.text}`, declined: `Kept · ${time}`, deferred: `Deferred · ${time}`, stopped: `Stopped · ${time}` }[event.status];
      const row = element('div', undefined, 'history'); row.dataset.eventId = event.id;
      row.append(element('strong', status || `${event.status} · ${event.action} · ${time}`));
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
    if (ids.some((id) => !actionReady(feed.items.find((item) => item.id === id), action))) throw new Error('Action unavailable: resolve positive safety/read evidence or explicit authorization. Nothing was sent.');
    if (action === 'approve' && ids.some((id) => {
      const item = feed.items.find((entry) => entry.id === id);
      return item?.kind === 'session' && recommendationVerb(item) === 'archive' && !archiveEligible(item);
    })) throw new Error('Archive approval unavailable: already decided, completed, blocked or awaiting human follow-up. It cannot be included in another archive batch.');
    if (liveSession && ids.some((id) => [...localRequests.values()].some((entry) => entry.item_ids.includes(id)) || (!isMessage(action) && decisionsById().has(id)))) throw new Error('Existing or uncertain decision: use Undo/change on its exact request in the action log.');
    if (unavailable()) throw new Error('Wait for the pending request or inspect the lost connection. Nothing was sent.');
    if (action === 'approve' && ids.length > 1 && feed.items.some((item) => ids.includes(item.id) && recommendationVerb(item).toLowerCase().trim() === 'merge')) throw new Error('Bulk merge approval is forbidden.');
  }
  function decide(ids, action, comment) {
    validateAction(ids, action);
    const order = [...visibleItems(), ...archiveItems()].map((item) => item.id);
    const anchor = activeId;
    const now = new Date().toISOString();
    const batch = crypto.randomUUID();
    const candidate = applyDecision({ ...feed, decisions: reviewHistory() }, ids, action, comment, now, batch);
    for (const id of ids) delete drafts[id];
    if (liveSession) {
      writing = true;
      if (!isMessage(action)) advances.set(batch, { order, anchor });
      localRequests.set(batch, { id: batch, kind: 'decision', item_ids: ids, text: comment, action, at: now, decisions: candidate.decisions.filter((entry) => entry.batch_id === batch), state: 'Sending — receipt not confirmed' });
    } else { feed = candidate; if (!isMessage(action)) for (const id of ids) laterIds.delete(id); }
    dirty = true; exportStamp = ''; selected.clear(); persist(); render(liveSession); $('detail').focus({ preventScroll: true });
    if (liveSession) {
      message('Recorded locally. Sending once; receipt not yet confirmed.');
      void postOnce('/decisions', { id: batch, ids, action, comment, decided_at: now, snapshot: serverSnapshot });
    } else {
      if (!isMessage(action)) advanceReview(order, anchor);
      message(`Recorded ${labels[action].toLowerCase()} for ${ids.length} item${ids.length === 1 ? '' : 's'}. Nothing was executed. Undo is available.`);
    }
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
    $('confirm-effect').textContent = liveSession ? 'Confirmation sends this entire batch once for rechecking. Queued work can be withdrawn before claim; running work cannot be interrupted. Later undo/change requires the action log and outcome-specific compensation.' : 'This records decisions only. It does not merge, close, archive or message anything.';
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
  $('cancel-control').addEventListener('click', () => { controlTarget = null; $('control-dialog').close(); });
  $('control-dialog').addEventListener('cancel', () => { controlTarget = null; });
  $('confirm-control').addEventListener('click', guarded(() => {
    if (!controlTarget || unavailable() || localRequests.size) throw new Error('Inspect pending requests before changing a decision.');
    const { input, mode } = controlTarget;
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    const text = $('control-text').value;
    const replacement = mode === 'change' ? { action: $('replacement-action').value, comment: $('replacement-comment').value, decided_at: at } : null;
    if (replacement) applyDecision({ ...feed, decisions: reviewHistory() }, input.item_ids, replacement.action, replacement.comment, at, id);
    localRequests.set(id, { id, kind: 'control', item_ids: input.item_ids, text, action: mode, at, decisions: [], state: 'Sending control — receipt not confirmed' });
    writing = true; persist(); syncControls(); renderThreadEvents();
    controlTarget = null; $('control-dialog').close();
    void postOnce('/controls', { id, target_id: input.id, mode, replacement, text, snapshot: serverSnapshot });
  }));
  $('undo').addEventListener('click', guarded(() => { if (liveSession) throw new Error('Live decisions cannot be unsent or undone.'); feed = undoLast(feed); dirty = true; exportStamp = ''; selected.clear(); persist(); render(); message('Undid the last recorded batch. Previously exported files are unchanged: export a replacement and do not execute the old one.'); }));
  for (const status of ['blocked', 'waiting']) $(`show-${status}`).addEventListener('click', () => { logFilter = status; renderActionLog(); $('action-log').scrollIntoView({ block: 'nearest' }); });
  $('show-all-actions').addEventListener('click', () => { logFilter = ''; renderActionLog(); });
  $('export-json').addEventListener('click', guarded(() => download('json')));
  $('export-markdown').addEventListener('click', guarded(() => download('markdown')));
  window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('keydown', guarded((event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.target === $('comment') && !$('control-dialog').open && !$('confirm-dialog').open && !unavailable()) {
      event.preventDefault(); decide([activeId], 'message', $('comment').value); return;
    }
    if (!feed || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.isComposing || $('confirm-dialog').open || $('control-dialog').open || unavailable()) return;
    if (!(event.target instanceof Element) || event.target.closest('input,textarea,select,button,a,summary,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
    const items = visibleItems(); const index = items.findIndex((item) => item.id === activeId);
    if (event.key === 'j' || event.key === 'ArrowUp') {
      event.preventDefault(); if (!items.length) return;
      activeId = items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'j' ? 1 : -1)))].id;
      renderList(); renderDetail(); $('detail').focus({ preventScroll: true }); $('list').querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'l' && activeId) {
      event.preventDefault(); skipLater();
    } else if (event.key === ' ' && activeId) {
      event.preventDefault(); if (!items[index] || isLocked(items[index])) { message('Not yours to act on. This item is read-only.'); return; }
      selected.has(activeId) ? selected.delete(activeId) : selected.add(activeId); renderList(); renderBulk();
    } else if ((event.key === 'c' || event.key === '?') && $('comment')) {
      event.preventDefault(); if (event.key === '?') { $('comment').value = drafts[activeId] || 'Needs clarification: please explain '; saveDraft(); } $('comment').focus();
    } else if (['a', 'x', 'k', 'd'].includes(event.key) && activeId) {
      event.preventDefault(); if (selected.size) { message('Selection is active. Use Review bulk action to confirm its scope, or clear selection for single-item shortcuts.'); return; }
      decide([activeId], event.key === 'a' ? primaryAction(feed.items.find((item) => item.id === activeId)) : event.key === 'x' ? 'archive' : 'decline', drafts[activeId] ?? '');
    }
  }));
  window.addEventListener('hashchange', () => { if (!liveSession) void connect(); });
  try { initialize(JSON.parse($('queue-feed').textContent)); void connect(); } catch (error) {
    message(`Unable to load queue: ${error.message}. Choose a valid feed with Load feed.`);
    $('detail').append(element('p', 'No valid queue loaded.', 'empty'));
    for (const name of ['undo', 'export-json', 'export-markdown']) $(name).disabled = true;
  }
})();
