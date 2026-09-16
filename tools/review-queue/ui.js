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
  function persist() {
    try {
      localStorage.setItem(savedKey, JSON.stringify({ items: feed.items, decisions: feed.decisions, drafts }));
      $('storage-status').textContent = 'Saved in this browser for this exact feed. Download JSON for a portable backup; private browsing and previews may clear storage.';
    } catch {
      $('storage-status').textContent = 'Browser storage unavailable. Decisions remain in this tab only: export JSON before closing.';
    }
  }
  function initialize(input, restore = true) {
    const validated = validateFeed(input);
    feed = validated;
    snapshot = JSON.stringify(feed.items);
    savedKey = `review-queue-v1-${fingerprint(snapshot)}`;
    drafts = Object.create(null);
    dirty = false;
    if (restore) {
      try {
        const raw = localStorage.getItem(savedKey);
        if (raw) {
          const saved = JSON.parse(raw);
          if (JSON.stringify(saved.items) !== snapshot) throw new Error('Stored feed does not match this snapshot. No decisions restored.');
          feed = validateFeed({ ...feed, decisions: saved.decisions });
          if (saved.drafts && typeof saved.drafts === 'object' && !Array.isArray(saved.drafts)) {
            for (const item of feed.items) if (typeof saved.drafts[item.id] === 'string') drafts[item.id] = saved.drafts[item.id].slice(0, 10000);
          }
          dirty = feed.decisions.length > 0 || Object.values(drafts).some(Boolean);
          message('Restored saved decisions and drafts for this exact snapshot. Export a fresh copy after review.');
        }
      } catch (error) { message(`Local restore unavailable: ${error.message}. Import an exported JSON backup if needed.`); }
    }
    selected.clear(); activeId = feed.items[0]?.id ?? null;
    for (const [control, property, title] of [['kind', 'kind', 'All kinds'], ['group', 'group', 'All groups'], ['recommendation', 'recommended_action', 'All recommendations']]) {
      const select = $(control);
      select.replaceChildren(new Option(title, ''));
      [...new Set(feed.items.map((item) => item[property]))].sort().forEach((value) => select.add(new Option(value || '(unspecified)', value)));
    }
    $('search').value = ''; $('status').value = '';
    const sourceMeta = feed.metadata ?? feed.meta ?? {};
    const sourceText = sourceMeta.collection_time || sourceMeta.collected_at || 'Collection time unknown; consult source evidence.';
    $('source').textContent = `Snapshot, not live state. ${sourceText.slice(0, 650)}${sourceText.length > 650 ? '…' : ''}`;
    $('source-caveat').textContent = JSON.stringify(sourceMeta, null, 2);
    $('export-json').disabled = false; $('export-markdown').disabled = false;
    persist(); render();
  }
  function decisionsById() { return new Map(latestDecisions(feed).map((decision) => [decision.id, decision])); }
  function visibleItems() {
    const query = $('search').value.trim().toLowerCase();
    const decisions = decisionsById();
    return feed.items.filter((item) => (!$('kind').value || item.kind === $('kind').value)
      && (!$('group').value || item.group === $('group').value)
      && (!$('recommendation').value || item.recommended_action === $('recommendation').value)
      && (!$('status').value || (isLocked(item) ? 'locked' : decisions.get(item.id)?.action ?? 'pending') === $('status').value)
      && (!query || JSON.stringify(item).toLowerCase().includes(query))).sort((a, b) => Number(isLocked(a)) - Number(isLocked(b)));
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
    for (const [count, label] of [[feed.items.length, 'total'], [pending, 'pending'], [approved, 'approved'], [declined, 'declined'], [followups, 'follow-ups / comments'], [deferred, 'deferred'], [locked, 'not yours to act on']]) {
      const metric = element('span'); metric.append(element('strong', String(count)), document.createTextNode(` ${label}`)); $('metrics').append(metric);
    }
    $('progress').style.width = `${actionable ? ((approved + declined) / actionable) * 100 : 0}%`;
    $('undo').disabled = feed.decisions.length === 0;
  }
  function renderList() {
    const items = visibleItems();
    if (!items.some((item) => item.id === activeId)) activeId = items[0]?.id ?? null;
    const decisions = decisionsById();
    $('visible-count').textContent = `${items.length} visible / ${feed.items.length}`;
    const selectable = items.filter((item) => !isLocked(item));
    $('select-visible').disabled = selectable.length === 0;
    $('select-visible').checked = selectable.length > 0 && selectable.every((item) => selected.has(item.id));
    $('select-visible').indeterminate = selectable.some((item) => selected.has(item.id)) && !$('select-visible').checked;
    const nodes = items.map((item) => {
      const row = element('div', undefined, `queue-row${item.id === activeId ? ' active' : ''}${selected.has(item.id) ? ' selected' : ''}${isLocked(item) ? ' locked' : ''}`);
      row.dataset.testid = 'queue-row'; row.dataset.id = item.id;
      const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(item.id); checkbox.dataset.testid = 'item-select'; checkbox.setAttribute('aria-label', `Select ${item.title}`);
      checkbox.addEventListener('change', () => { checkbox.checked ? selected.add(item.id) : selected.delete(item.id); renderList(); renderBulk(); });
      const open = element('button', undefined, 'row-open'); open.setAttribute('aria-label', `Review ${item.title}`); open.setAttribute('aria-current', item.id === activeId ? 'true' : 'false');
      open.append(element('span', item.title, 'row-title'), element('span', item.summary, 'row-summary'));
      const meta = element('span', undefined, 'row-meta'); meta.append(element('span', item.kind, 'tag'), element('span', isLocked(item) ? 'Not yours to act on' : statuses[decisions.get(item.id)?.action] ?? 'Pending'), element('span', `→ ${item.recommended_action}`)); open.append(meta);
      open.addEventListener('click', () => { activeId = item.id; renderList(); renderDetail(); });
      if (!isLocked(item)) row.append(checkbox);
      row.append(open); return row;
    });
    const firstLocked = items.findIndex(isLocked);
    if (firstLocked !== -1) nodes.splice(firstLocked, 0, element('h3', 'Other owners · not yours to act on', 'locked-heading'));
    $('list').replaceChildren(...(nodes.length ? nodes : [element('p', 'No items match these filters.', 'empty')]));
  }
  function renderBulk() {
    $('bulk').hidden = selected.size === 0;
    $('selected-count').textContent = `${selected.size} selected`;
    const items = feed.items.filter((item) => selected.has(item.id));
    const homogeneous = new Set(items.map(shape)).size <= 1 && !items.some(isLocked);
    $('bulk-shape').textContent = homogeneous && items.length ? `${items[0].kind} · ${items[0].group} · ${items[0].recommended_action}` : 'Mixed kinds, groups or recommendations. Filter to matching items before batching.';
    $('bulk-apply').disabled = !homogeneous || !items.length;
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
    const meta = element('div', undefined, 'detail-meta');
    for (const value of [item.kind, item.group, `Risk: ${item.risk}`, item.age || 'Age unknown']) meta.append(element('span', value, 'tag'));
    const heading = element('h2', item.title); heading.dataset.testid = 'detail-title';
    root.append(meta, heading, element('div', item.id, 'detail-id'));
    if (isLocked(item)) root.append(element('p', `Not yours to act on. ${item.lock_reason || 'Controlled by another owner; read-only.'}`, 'locked-banner'));
    else if (item.protected) root.append(element('p', 'Protected item: approving here never overrides pin, running-state or permission restrictions.', 'notice'));
    const evidence = element('section', undefined, 'section'); evidence.append(element('h3', 'Evidence · inspect before deciding'));
    if (!item.evidence.length) evidence.append(element('p', 'No evidence supplied. Ask for information rather than infer a pass.', 'muted'));
    for (const entry of item.evidence) {
      const row = element('div', undefined, 'evidence'); const value = element('div', undefined, 'evidence-value');
      if (entry.value !== undefined) value.append(document.createTextNode(String(entry.value)));
      if (entry.url) { if (entry.value !== undefined) value.append(document.createTextNode(' · ')); value.append(safeLink('Open evidence', entry.url)); }
      row.append(element('div', entry.label, 'evidence-label'), value); evidence.append(row);
    }
    if (item.links.length) { const links = element('div', undefined, 'actions'); for (const link of item.links) links.append(safeLink(link.label, link.url)); evidence.append(links); }
    root.append(evidence);
    const summary = element('section', undefined, 'section'); summary.append(element('h3', 'Context'), element('p', item.summary, 'summary'));
    const recommendation = element('div', undefined, 'recommendation'); recommendation.append(element('div', 'RECOMMENDATION · NOT YOUR DECISION', 'eyebrow'), element('strong', item.recommended_action), element('p', isLocked(item) ? 'Read-only reference. No decisions or follow-ups can be recorded for this item.' : 'Approve means accept this recommendation, subject to audit-agent checks. Decline records disagreement; it never closes a PR.', 'small muted')); summary.append(recommendation); root.append(summary);
    if (isLocked(item)) return;
    const review = element('section', undefined, 'section'); const owner = item.owner_session_id ?? (item.kind === 'session' ? item.id : null);
    review.append(element('h3', 'Your decision'), element('p', owner ? `Follow-up owner: ${owner}` : 'No session owner supplied. Follow-ups require manual routing by the audit agent.', 'small muted'));
    const templates = element('div', undefined, 'templates');
    for (const [title, text] of [['Ask for more info', 'Ask for more info: please provide the missing evidence and current status.'], ['Needs clarification', 'Needs clarification: please explain '], ['More work: …', 'More work: please ']]) {
      const button = element('button', title); button.addEventListener('click', () => { $('comment').value = text; saveDraft(); $('comment').focus(); }); templates.append(button);
    }
    const commentLabel = element('label', 'Comment or follow-up request', 'sr-only'); commentLabel.htmlFor = 'comment';
    const comment = element('textarea'); comment.id = 'comment'; comment.dataset.testid = 'comment'; comment.rows = 3; comment.maxLength = 10000; comment.placeholder = 'What should the owner explain or change?'; comment.value = drafts[item.id] ?? ''; comment.addEventListener('input', saveDraft);
    review.append(templates, commentLabel, comment);
    const actions = element('div', undefined, 'actions');
    for (const [action, label] of Object.entries(labels)) {
      const button = element('button', label, action); button.dataset.action = action; button.addEventListener('click', guarded(() => decide([item.id], action, comment.value))); actions.append(button);
    }
    review.append(actions); root.append(review);
    const history = element('section', undefined, 'section'); history.append(element('h3', 'Decision history'));
    const entries = feed.decisions.filter((decision) => decision.id === item.id);
    if (!entries.length) history.append(element('p', 'No decisions recorded yet.', 'muted small'));
    for (const decision of entries) history.append(element('div', `${statuses[decision.action]} · ${decision.decided_at}\n${decision.comment || '(no comment)'}\nBatch: ${decision.batch_id}`, 'history'));
    root.append(history);
  }
  function saveDraft() {
    if (!activeId || !$('comment')) return;
    drafts[activeId] = $('comment').value; dirty = true; persist();
  }
  function renderPlan() { $('agent-plan').value = exportDecisions(feed, new Date().toISOString()).instructions; }
  function render() { renderMetrics(); renderList(); renderBulk(); renderDetail(); renderPlan(); }
  function decide(ids, action, comment) {
    const now = new Date().toISOString();
    const batch = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    feed = applyDecision(feed, ids, action, comment, now, batch);
    for (const id of ids) delete drafts[id];
    dirty = true; exportStamp = ''; selected.clear(); persist(); render(); message(`Recorded ${labels[action].toLowerCase()} for ${ids.length} item${ids.length === 1 ? '' : 's'}. Nothing was executed. Undo is available.`);
  }
  function prepareBatch() {
    const ids = [...selected]; const action = $('bulk-action').value; const comment = $('bulk-comment').value;
    // Validate before presenting confirmation; discard the pure candidate until confirmed.
    applyDecision(feed, ids, action, comment, new Date().toISOString(), 'validation-only');
    pendingBatch = { ids, action, comment };
    $('confirm-title').textContent = `${labels[action]} ${ids.length} items?`;
    $('confirm-description').textContent = comment ? `Shared comment: ${comment}` : 'No shared comment. All listed items have the same kind, group and recommendation.';
    $('batch-preview').replaceChildren(...ids.map((id) => element('li', `${feed.items.find((item) => item.id === id).title} — ${id}`)));
    $('confirm-dialog').showModal();
  }
  function download(format) {
    const exported = exportDecisions(feed, new Date().toISOString());
    if (!exportStamp) exportStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const content = format === 'json' ? exported.json : exported.markdown;
    const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `decisions-${exportStamp}.${format === 'json' ? 'json' : 'md'}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    if (format === 'json') dirty = Object.values(drafts).some(Boolean);
    message(`Prepared ${link.download}. Check your browser downloads. Unsaved comment drafts are not decisions; record them before exporting.`);
  }
  async function readFileInput(input, callback) {
    const file = input.files[0]; if (!file) return;
    try { if (file.size > 12 * 1024 * 1024) throw new Error('File exceeds 12 MiB limit.'); callback(JSON.parse(await file.text())); } catch (error) { message(`Import rejected: ${error.message}`); } finally { input.value = ''; }
  }
  $('import-feed').addEventListener('change', () => readFileInput($('import-feed'), (data) => {
    validateFeed(data);
    if (dirty && !window.confirm('Current decisions or drafts have not been exported. Replace the displayed feed? Cancel to export first.')) return;
    message(); initialize(data);
  }));
  $('import-decisions').addEventListener('change', () => readFileInput($('import-decisions'), (data) => {
    const backup = validateFeed(data);
    if (JSON.stringify(backup.items) !== snapshot) throw new Error('Backup must contain the exact same items and source snapshot. Load its feed first; never replay decisions onto changed evidence.');
    const validated = validateFeed({ ...feed, decisions: backup.decisions });
    if ((dirty || feed.decisions.length) && !window.confirm('Replace current decision history with this backup? Export current decisions first if needed.')) return;
    feed = validated; dirty = true; exportStamp = ''; selected.clear(); persist(); render(); message('Restored decision history for the exact matching snapshot. No actions executed.');
  }));
  for (const name of ['search', 'kind', 'group', 'recommendation', 'status']) $(name).addEventListener(name === 'search' ? 'input' : 'change', () => { selected.clear(); render(); });
  $('select-visible').addEventListener('change', () => { const checked = $('select-visible').checked; selected = checked ? new Set(visibleItems().filter((item) => !isLocked(item)).map((item) => item.id)) : new Set(); renderList(); renderBulk(); });
  $('clear-selection').addEventListener('click', () => { selected.clear(); renderList(); renderBulk(); });
  $('bulk-apply').addEventListener('click', guarded(prepareBatch));
  $('cancel-bulk').addEventListener('click', () => { pendingBatch = null; $('confirm-dialog').close(); });
  $('confirm-dialog').addEventListener('cancel', () => { pendingBatch = null; });
  $('confirm-bulk').addEventListener('click', guarded(() => {
    if (!pendingBatch) return;
    const { ids, action, comment } = pendingBatch; decide(ids, action, comment); pendingBatch = null; $('bulk-comment').value = ''; $('confirm-dialog').close();
  }));
  $('undo').addEventListener('click', guarded(() => { feed = undoLast(feed); dirty = true; exportStamp = ''; selected.clear(); persist(); render(); message('Undid the last recorded batch. Previously exported files are unchanged: export a replacement and do not execute the old one.'); }));
  $('export-json').addEventListener('click', guarded(() => download('json')));
  $('export-markdown').addEventListener('click', guarded(() => download('markdown')));
  window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('keydown', guarded((event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.repeat || $('confirm-dialog').open) return;
    if (event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key === ' ' && event.target.closest('button,a')) return;
    const items = visibleItems(); const index = items.findIndex((item) => item.id === activeId);
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault(); if (!items.length) return;
      activeId = items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'j' ? 1 : -1)))].id;
      renderList(); renderDetail(); $('list').querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === ' ' && activeId) {
      event.preventDefault(); if (isLocked(items[index])) { message('Not yours to act on. This item is read-only.'); return; }
      selected.has(activeId) ? selected.delete(activeId) : selected.add(activeId); renderList(); renderBulk();
    } else if ((event.key === 'c' || event.key === '?') && $('comment')) {
      event.preventDefault(); if (event.key === '?') { $('comment').value = drafts[activeId] || 'Needs clarification: please explain '; saveDraft(); } $('comment').focus();
    } else if ((event.key === 'a' || event.key === 'd') && activeId) {
      event.preventDefault(); if (selected.size) { message('Selection is active. Use Review bulk action to confirm its scope, or clear selection for single-item shortcuts.'); return; }
      decide([activeId], event.key === 'a' ? 'approve' : 'decline', drafts[activeId] ?? '');
    }
  }));
  try { initialize(JSON.parse($('queue-feed').textContent)); } catch (error) {
    message(`Unable to load queue: ${error.message}. Choose a valid feed with Load feed.`);
    $('detail').append(element('p', 'No valid queue loaded.', 'empty'));
    for (const name of ['undo', 'export-json', 'export-markdown']) $(name).disabled = true;
  }
})();
