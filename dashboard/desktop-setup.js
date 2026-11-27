// Guided Remote Desktop setup. Everything shown here comes from the server, so
// the dashboard and the app say the same thing. It never decides anything.
const POLL_MS = 4_000;
const MAX_POLL_MS = 60_000;
const POLL_FOR_MS = 10 * 60_000;

export function createDesktopSetup({ api, $, onReady, onPinLost }) {
  const rows = new Map();
  let activeId = '';
  let timer = 0;
  let delay = POLL_MS;
  let startedAt = 0;

  function stopPolling() {
    if (timer) clearTimeout(timer);
    timer = 0;
    activeId = '';
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = 0;
    if (!activeId || Date.now() - startedAt > POLL_FOR_MS) { stopPolling(); return; }
    timer = setTimeout(poll, delay);
  }

  async function poll() {
    timer = 0;
    const id = activeId;
    if (!id) return;
    try {
      const row = await api(`/desktop/setup/${encodeURIComponent(id)}`);
      delay = POLL_MS;
      const wasReady = rows.get(id)?.ready;
      show(row);
      if (row.ready && !wasReady) {
        stopPolling();
        await onReady(row);
        return;
      }
      if (row.ready) { stopPolling(); return; }
    } catch (error) {
      if (lostPin(error)) return;
      delay = Math.min(delay * 2, MAX_POLL_MS);
    }
    schedule();
  }

  function lostPin(error) {
    // This machine restarting ends the PIN session, which is expected here.
    if (!/dashboard operator session/i.test(error?.message || '')) return false;
    stopPolling();
    onPinLost();
    return true;
  }

  function follow(id) {
    activeId = id;
    delay = POLL_MS;
    startedAt = Date.now();
    schedule();
  }

  async function act(row, action, note) {
    if (action.id === 'check') { note.textContent = 'Checking…'; }
    try {
      if (action.id === 'check') {
        show(await api(`/desktop/setup/${encodeURIComponent(row.machineId)}`));
        rows.get(row.machineId)?.ready ? await onReady(rows.get(row.machineId)) : follow(row.machineId);
        return;
      }
      const reply = await api(`/desktop/setup/${encodeURIComponent(row.machineId)}`, 'POST',
        { action: action.id, ...(action.pane ? { pane: action.pane } : {}) });
      show(reply.step);
      follow(row.machineId);
    } catch (error) {
      if (lostPin(error)) return;
      if (error.step) show(error.step);
      const current = rowElement(row.machineId)?.querySelector('.setup-note');
      if (current) current.textContent = error.message || 'That did not work. Try again.';
      follow(row.machineId);
    }
  }

  function rowElement(id) {
    return [...$('setupRows').children].find(item => item.dataset.machineId === id);
  }

  function show(row) {
    rows.set(row.machineId, row);
    const item = document.createElement('li');
    item.dataset.machineId = row.machineId;
    const title = document.createElement('strong');
    title.textContent = row.title;
    const detail = document.createElement('p');
    detail.textContent = row.detail;
    const actions = document.createElement('div');
    actions.className = 'setup-actions';
    const note = document.createElement('p');
    note.className = 'setup-note';
    note.setAttribute('role', 'status');
    for (const action of row.actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      if (action.id === 'turn-off') button.className = 'setup-quiet';
      button.addEventListener('click', async () => {
        if (action.id === 'turn-off'
          && !confirm(`Turn off Remote Desktop on ${row.label}? Its Instar server restarts.`)) return;
        button.disabled = true;
        try { await act(row, action, note); } finally { button.disabled = false; }
      });
      actions.append(button);
    }
    item.append(title, detail, actions);
    if (row.note) {
      const extra = document.createElement('p');
      extra.textContent = row.note;
      item.append(extra);
    }
    if (row.fallback) {
      const more = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Do it by hand instead';
      const text = document.createElement('p');
      text.textContent = row.fallback;
      more.append(summary, text);
      item.append(more);
    }
    item.append(note);
    const existing = rowElement(row.machineId);
    if (existing) existing.replaceWith(item);
    else $('setupRows').append(item);
  }

  async function refresh() {
    let list;
    try { list = await api('/desktop/setup'); }
    catch (error) {
      if (lostPin(error)) return false;
      // An older server, or one with no machine identity yet.
      $('setup').hidden = true;
      return false;
    }
    stopPolling();
    $('setupRows').replaceChildren();
    rows.clear();
    if (list.frontElsewhere) {
      $('setupLead').textContent = `Remote Desktop runs from ${list.frontLabel}. Open this page on ${list.frontLabel} to set up other machines.`;
      for (const row of list.machines || []) show(row);
      $('setup').hidden = false;
      return true;
    }
    const machines = list.machines || [];
    $('setupLead').textContent = 'This page rechecks by itself after each step. A machine is ready when the check here says so.';
    for (const row of machines) show(row);
    $('setup').hidden = machines.length === 0;
    // These rows carry the same reasons with the steps to fix them.
    if (machines.length) $('machineNotes')?.replaceChildren();
    return machines.length > 0;
  }

  return { refresh, stop: stopPolling };
}
