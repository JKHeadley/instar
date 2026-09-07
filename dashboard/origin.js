/** Operator-only message origin panel. No credentials or raw payloads are rendered. */
import { renderGlance } from './glance.js';
import { sanitizeForDisplay } from './subscriptions.js';

/** Only fixed prose reaches the glance; a page is never a total or proof of fleet health. */
export function originGlanceSpec({ status, auditAvailable = false } = {}, activate = {}) {
  const current = !!status?.metrics?.counts && status.metrics.stale === false && status.metrics.coverage === 'complete';
  return { headline: 'Choose message details or inspect saved origins.', tiles: [
    { key: 'display', label: 'Display settings', value: 'Edit', onActivate: activate.display },
    { key: 'recording', label: 'Recording status', value: current ? 'Current' : 'Unknown', onActivate: activate.recording },
    { key: 'messages', label: 'Recent messages', value: auditAvailable ? 'View' : 'Unknown', onActivate: activate.messages },
  ] };
}

const BITS = [['enabled', 'Show origin details'], ['machine', 'Machine name'], ['harness', 'Session app'], ['model', 'Model name']];
const human = value => typeof value === 'string' ? value.replace(/[-_]/g, ' ') : 'unknown';
const evidence = field => `${field?.value || 'Unknown'} (${human(field?.status)})`;
export function mountOriginPanel(root, { request, unlock }) {
  const doc = root.ownerDocument;
  const make = (tag, text, parent = root) => { const el = doc.createElement(tag); if (tag === 'button') el.className = 'action-btn'; if (text !== undefined) el.textContent = sanitizeForDisplay(text, 'summary'); parent.append(el); return el; };
  root.replaceChildren();
  make('h2', 'Message origins');
  make('p', 'Choose what appears below your messages. Saved origin records are always kept.').className = 'tab-purpose';
  const notice = make('p'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const unlockButton = make('button', 'Unlock with PIN'); unlockButton.type = 'button'; unlockButton.onclick = unlock;
  const refresh = make('button', 'Refresh'); refresh.type = 'button';
  const glance = make('section'); glance.className = 'glance-root';
  const status = make('section'); status.setAttribute('aria-label', 'Recording status');
  make('p', 'Recording and notification status are unavailable until access is verified.', status);
  const settings = make('section'); settings.setAttribute('aria-label', 'Origin display settings'); settings.className = 'origin-settings';
  make('h3', 'Display on messages', settings);
  const label = make('label', 'Apply settings to ', settings), select = make('select', undefined, label); select.setAttribute('aria-label', 'Conversation'); label.className = 'origin-scope';
  const inheritLabel = make('label', undefined, settings), inherit = make('input', undefined, inheritLabel); inherit.type = 'checkbox'; inheritLabel.className = 'origin-bit'; inheritLabel.append(' Use agent defaults');
  const boxes = {};
  for (const [key, title] of BITS) { const row = make('label', undefined, settings); row.className = 'origin-bit'; const box = make('input', undefined, row); box.type = 'checkbox'; box.setAttribute('aria-label', title); row.append(' ' + title); boxes[key] = box; }
  const save = make('button', 'Save display settings', settings); save.type = 'button'; save.disabled = true; save.classList.add('origin-save');
  const audit = make('section'); audit.setAttribute('aria-label', 'Message audit');
  make('h3', 'Recent messages', audit); const coverage = make('p', undefined, audit), rows = make('div', undefined, audit);
  coverage.textContent = 'Records are unavailable until access is verified.';
  const more = make('button', 'Load more messages', audit); more.type = 'button'; more.hidden = true;
  // Detail nodes retain form state when moved into the shared drill container.
  settings.remove(); status.remove(); audit.remove();
  let statusSnapshot, auditAvailable = false;
  const renderSummary = () => renderGlance(doc, glance, originGlanceSpec({ status: statusSnapshot, auditAvailable }, {
    display: ({ drilldown }) => drilldown.append(settings),
    recording: ({ drilldown }) => drilldown.append(status),
    messages: ({ drilldown }) => drilldown.append(audit),
  }));
  renderSummary();
  let preferences, cursor, timer, auditScope = 'pool', busy = false, stopped = false, statusBusy = false, auditGeneration = 0;
  const pending = new Set();
  const api = async (url, options) => {
    const controller = new AbortController(); pending.add(controller); let timeout;
    try {
      return await Promise.race([
        (async () => {
          const response = await request(url, { ...options, signal: controller.signal });
          if (response.status === 403) { unlockButton.hidden = false; throw new Error('Unlock with your PIN to view or change message origins.'); }
          if (!response.ok) throw new Error(response.status === 409 ? 'Settings changed elsewhere. Refresh before saving again.' : 'This information is unavailable. No complete result can be confirmed.');
          unlockButton.hidden = true; return response.json();
        })(),
        new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('This request timed out. Status remains unknown; refresh to try again.')); }, 5000); }),
      ]);
    } finally { clearTimeout(timeout); pending.delete(controller); }
  };
  const selected = () => preferences?.topics.find(topic => topic.id === select.value);
  const showSettings = () => {
    const topic = selected(); inheritLabel.hidden = !topic; inherit.checked = !!topic && topic.display === null;
    for (const [key] of BITS) { boxes[key].checked = (topic?.display?.[key] ?? preferences.defaults[key]) === true; boxes[key].disabled = inherit.checked; }
    save.disabled = !!topic && !topic.editable;
  };
  inherit.onchange = () => { for (const box of Object.values(boxes)) box.disabled = inherit.checked; };
  select.onchange = () => { showSettings(); void loadAudit(); };
  const loadPreferences = async () => {
    preferences = await api('/telegram/origin-display'); const previous = select.value; select.replaceChildren();
    const add = (id, name) => { const option = make('option', name, select); option.value = id; };
    add('', 'All conversations (agent defaults)');
    for (const topic of preferences.topics) add(topic.id, topic.name);
    select.value = [...select.options].some(option => option.value === previous) ? previous : '';
    showSettings();
    if (preferences.topicsMayBeIncomplete) notice.textContent = 'Some conversations are not listed. These settings remain available for the listed conversations.';
  };
  save.onclick = async () => {
    save.disabled = true;
    try {
      const topic = selected(), display = topic && inherit.checked ? null : Object.fromEntries(BITS.map(([key]) => [key, boxes[key].checked]));
      const result = await api('/telegram/origin-display', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Request': '1' },
        body: JSON.stringify({ ...(topic ? { topicId: topic.id } : {}), display, revision: topic?.revision ?? preferences.revision }) });
      notice.textContent = sanitizeForDisplay(result.message, 'summary'); await loadPreferences();
    } catch (error) { notice.textContent = sanitizeForDisplay(error.message, 'summary'); }
    finally { save.disabled = false; }
  };
  const loadStatus = async () => {
    if (statusBusy || stopped) return; statusBusy = true;
    const wasOpen = status.querySelector('details')?.open === true;
    status.replaceChildren();
    const detail = make('details', undefined, status); detail.className = 'origin-status-details'; detail.open = wasOpen;
    const summary = make('summary', 'Recording status unavailable', detail);
    try {
      const data = await api('/telegram/origins/status'); statusSnapshot = data;
      const counts = data.metrics?.counts;
      const known = counts && data.metrics?.stale === false && data.metrics?.coverage === 'complete';
      const notices = data.notices, outcomes = Array.isArray(notices) ? notices.map(item => human(item.notificationOutcome)) : [];
      summary.textContent = sanitizeForDisplay(`${known ? 'Recording available' : 'Recording status unknown'} · ${outcomes.length ? 'Outage notice: ' + outcomes.join(', ') : 'Outage notice unavailable'}`, 'summary');
      make('p', data.activation?.complete === true ? 'Enrollment complete.' : 'Enrollment incomplete. Some writers or required evidence remain unverified.', detail);
      make('p', counts ? `Recorded logical operations — Prepared: ${counts['operation:prepared'] ?? 'unknown'} · Held: ${counts['operation:held'] ?? 'unknown'} · Accepted: ${counts['operation:accepted'] ?? 'unknown'}` : 'Recording counts unavailable; held work is unknown.', detail);
      make('p', `Measurement freshness: ${data.metrics?.stale ? 'stale' : data.metrics?.sampledAt ? new Date(data.metrics.sampledAt).toLocaleString() : 'unknown'}.`, detail);
      make('p', outcomes.length ? `Outage notification: ${outcomes.join(', ')}.` : 'Outage notification unavailable: no current alert destination or verified state.', detail);
    } catch (error) { statusSnapshot = undefined; make('p', 'Recording and notification status unavailable; held work is unknown.', detail); notice.textContent = sanitizeForDisplay(error.message, 'summary'); }
    finally { statusBusy = false; renderSummary(); }
  };
  const renderRow = row => {
    let envelope;
    try { envelope = JSON.parse(row.record.envelopeJson); } catch { make('p', 'An origin record could not be read.', rows); return; }
    const details = make('details', undefined, rows); details.style.padding = '12px 0';
    make('summary', `${envelope.originMachineName || 'Unknown machine'} · ${envelope.harnessName || 'Unknown harness'} · ${evidence(envelope.model)}`, details);
    make('p', `${human(envelope.operationKind)} · ${human(row.operation?.state)} · ${new Date(envelope.createdAt).toLocaleString()}`, details);
    make('p', `Machine: ${evidence(envelope.machine)}. Harness: ${evidence(envelope.harness)}. Model: ${evidence(envelope.model)}.`, details);
    make('p', `Origin details at preparation: ${envelope.display?.enabled === false || ['machine', 'harness', 'model'].every(key => envelope.display?.[key] === false) ? 'hidden' : 'enabled'}. Evidence remains recorded.`, details);
    for (const field of ['machine', 'harness', 'model']) if (envelope[field]?.reason) make('p', `${human(field)} evidence: ${human(envelope[field].reason)}`, details);
    const receipts = row.attempts?.filter(attempt => attempt.receiptJson)?.length;
    make('p', `Origin attestation verification: ${row.currentVerification?.signatureValid === true ? 'valid' : row.currentVerification?.signatureValid === false ? 'invalid' : 'unknown'}.`, details);
    if (envelope.revisionOf) make('p', 'This revision retains a link to an earlier origin record.', details);
    if (receipts) make('p', `Recorded delivery receipts: ${receipts}.`, details);
  };
  const loadAudit = async (append = false) => {
    const generation = ++auditGeneration, topicId = select.value;
    more.disabled = true; if (!append) { rows.replaceChildren(); cursor = undefined; auditScope = 'pool'; }
    try {
      let page;
      try { page = await api('/telegram/origins?scope=' + auditScope + '&limit=25' + (topicId ? '&topicId=' + encodeURIComponent(topicId) : '') + (append && cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); }
      catch (error) {
        if (generation !== auditGeneration || stopped) return;
        if (append) throw error;
        auditScope = 'local'; page = await api('/telegram/origins?limit=25' + (topicId ? '&topicId=' + encodeURIComponent(topicId) : '')); page.coverage = 'local-only';
      }
      if (generation !== auditGeneration || stopped) return;
      auditAvailable = Array.isArray(page.records);
      coverage.textContent = page.coverage === 'complete' && auditScope === 'pool' ? 'Pool coverage complete for this snapshot.' : 'Coverage incomplete: some machines or records are unavailable. This list does not prove absence elsewhere.';
      for (const row of page.records ?? []) renderRow(row);
      if (!rows.childElementCount) make('p', 'No records returned in this snapshot.', rows);
      cursor = page.cursor; more.hidden = !cursor;
    } catch (error) { if (generation !== auditGeneration || stopped) return; auditAvailable = false; coverage.textContent = 'Audit unavailable. Coverage is unknown.'; notice.textContent = sanitizeForDisplay(error.message, 'summary'); more.hidden = true; }
    finally { if (generation === auditGeneration) { more.disabled = false; renderSummary(); } }
  };
  const refreshAll = async () => {
    if (busy || stopped) return; busy = true; refresh.disabled = true;
    try { await loadPreferences(); await Promise.all([loadStatus(), loadAudit()]); }
    catch (error) { statusSnapshot = undefined; auditAvailable = false; renderSummary(); notice.textContent = sanitizeForDisplay(error.message, 'summary'); }
    finally { busy = false; refresh.disabled = false; }
  };
  refresh.onclick = refreshAll; more.onclick = () => loadAudit(true);
  return { start() { stopped = false; void refreshAll(); clearInterval(timer); timer = setInterval(() => { if (!stopped && !busy) void loadStatus(); }, 30_000); },
    refresh: refreshAll, stop() { stopped = true; ++auditGeneration; clearInterval(timer); for (const controller of pending) controller.abort(); } };
}
