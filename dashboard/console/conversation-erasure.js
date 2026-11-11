// Priority name removal tracks opaque identity, never the name or owner proof.
import { el, note, setKids, sheet, closeSheet, operatorSession } from './ui.js';
import { ledger, forget } from './conversation-write-continuity.js';

export function erasureControls({ node, canErase = false, headerForgotten = false, send, current, unlock, refresh }) {
  if (node.kind !== 'effort') return null;
  const scope = `${node.key}:erase-header`;
  let previous;
  try { previous = ledger().find(entry => entry.subject === scope); } catch { /* Server-managed privacy identity does not depend on browser storage. */ }
  if (!canErase && !previous) return null;
  return el('button', { type: 'button', class: 'btn-quiet btn-inline', text: previous || headerForgotten ? 'Check name removal' : 'Forget name', onclick: () => {
    let open = true, busy = false, id = previous?.requestId || null, legacy = Boolean(previous);
    const status = el('p', { class: 'need-sub', role: 'status', 'aria-live': 'polite' });
    const actions = el('div');
    const description = note('Remove this effort’s name from graph storage. This cannot be undone. Original messages stay. Other copies and backups may take longer to verify.');
    const close = () => { open = false; clearInterval(timer); window.removeEventListener('instar-owner-locked', locked); description.textContent = ''; status.textContent = ''; actions.replaceChildren(); };
    const panel = sheet({ title: 'Forget effort name', onClose: close }, description, status, actions);
    panel.classList.add('conversation-correction-sheet');
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const items = [...panel.querySelectorAll('button,a[href],input')].filter(item => !item.disabled && !item.closest('[hidden]'));
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    const active = () => open && current() && Boolean(operatorSession());
    const locked = () => { if (open) { closeSheet(); unlock(); } };
    window.addEventListener('instar-owner-locked', locked);
    const timer = setInterval(() => { if (open && !active()) closeSheet(); }, 250);
    const done = () => { closeSheet(); refresh(); };
    const call = async (path, body) => {
      if (!active() || busy) return;
      busy = true; setKids(actions); status.textContent = 'Checking name removal…';
      let result;
      try { result = await send(path, body); } catch { result = { ok: false }; }
      busy = false;
      if (!active()) return;
      if (result.needsUnlock) { locked(); return; }
      const data = result.data || {};
      if (!id && !legacy && path.endsWith('/ensure') && typeof data.requestId === 'string' && /^erasev1_[a-f0-9]{64}$/.test(data.requestId)) id = data.requestId;
      const valid = result.ok && data.requestId === id && data.localHidden === true
        && typeof data.liveGraphStoresPurged === 'boolean' && typeof data.fleetComplete === 'boolean'
        && (!data.fleetComplete || (data.liveGraphStoresPurged === true && data.capturedGraphCopiesComplete === true
          && data.waitingCopyCount === 0 && data.memberBackupDebtCount === 0
          && data.witnessPurge?.walPurged === true && data.witnessPurge?.externalBackupsVerified === true));
      const complete = valid && data.fleetComplete === true;
      if (valid) {
        status.textContent = data.fleetComplete === true ? 'Name removal verified.'
          : data.liveGraphStoresPurged === true ? 'Name copies removed from live graph storage. Backup removal is not verified.'
            : 'The name is hidden here. Other copies and backups are still being checked.';
        if (complete && !legacy) forget(scope);
      } else status.textContent = data.localHidden === true && data.code === 'erasure-discovery-unavailable'
        ? 'Name hidden here. Removal elsewhere could not be started. Try this same removal again.'
        : 'Name removal could not be confirmed. Check this same request again.';
      if (!valid && canErase) actions.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Retry same removal', onclick: retry }));
      if (!complete) actions.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Check status', onclick: check }));
      actions.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Done', onclick: done }));
    };
    const retry = () => legacy
      ? call('/conversation-graph/forget-header', { requestId: id, effort: node.ref })
      : call('/conversation-graph/forget-header/ensure', { effort: node.ref });
    const check = () => id ? call(`/conversation-graph/erasures/${encodeURIComponent(id)}`) : retry();
    const confirm = () => {
      setKids(actions);
      status.textContent = '';
      if (canErase) actions.append(el('button', { type: 'button', class: 'btn-primary btn-inline', text: 'Forget name', onclick: retry }));
    };
    const discover = async () => {
      busy = true; status.textContent = 'Checking earlier name removal…';
      let result;
      try { result = await send('/conversation-graph/forget-header/discover', { effort: node.ref }); }
      catch { result = { ok: false }; }
      busy = false;
      if (!active()) return;
      if (result.needsUnlock) { locked(); return; }
      const data = result.data || {};
      const found = result.ok && typeof data.requestId === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(data.requestId)
        && data.target?.sourceKind === 'header' && Object.keys(data.target).length === 2 && typeof data.target.sourceId === 'string'
        && /^[A-Za-z0-9_.:-]{8,160}$/.test(data.target.sourceId);
      if (legacy) {
        // An unknown earlier UUID is never replaced by the new stable identity.
        if (found && data.requestId === id && data.continuity?.publication === 'published') { forget(scope); legacy = false; }
        void check(); return;
      }
      if (found) { id = data.requestId; void check(); return; }
      confirm();
    };
    void discover();
  } });
}
