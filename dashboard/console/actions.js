// The one tap on a needs-you item (Every Ask Is Actionable; shared-counts.js "Actions").
// open    → an ordinary link: a console deep link, or a GitHub review in a new tab.
// approve → a button that asks for confirmation, opens the existing PIN sheet when
//           the route needs a recent unlock, POSTs, and shows the server's real answer.
// Every dynamic value is written with textContent.

import { isActionable } from './shared-counts.js';
import { el, askPin, forgetOperatorSession, setActionRenderer } from './ui.js';

function token() {
  try { return localStorage.getItem('instar_token') || ''; } catch { return ''; }
}

/** POST an approve action; resolves to { ok, message }. */
export async function runApprove(action, { fetchImpl = (typeof fetch === 'function' ? fetch : null), pin = askPin } = {}) {
  const headers = { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' };
  if (action.pin === 'session') {
    const auth = await pin({ title: action.label, explain: 'This needs a recent PIN unlock. It is kept in this page only until it expires.', adapter: 'session' });
    if (!auth) return { ok: false, message: 'Not approved: no PIN was given.' };
    headers['X-Instar-Operator-Session'] = auth.session;
  }
  if (!fetchImpl) return { ok: false, message: 'The server could not be reached.' };
  try {
    const r = await fetchImpl(action.path, { method: 'POST', headers, body: JSON.stringify(action.body || {}) });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && action.pin === 'session') { forgetOperatorSession(); return { ok: false, message: 'The unlock expired. Tap again and enter your PIN.' }; }
    if (r.ok) return { ok: true, message: action.done || 'Done.' };
    return { ok: false, message: (data && (data.error || data.message)) ? String(data.error || data.message) : `The server answered ${r.status}.` };
  } catch { return { ok: false, message: 'The server could not be reached.' }; }
}

/**
 * The control for one action, or null when there is none (the caller then shows
 * nothing — such an item is never counted as needing the operator).
 */
export function actionControl(action, { onDone, fetchImpl, pin } = {}) {
  if (!isActionable(action)) return null;
  if (action.kind === 'open') {
    return el('a', {
      class: 'btn-primary btn-inline btn-small need-action', href: action.href, text: action.label,
      target: action.external ? '_blank' : null, rel: action.external ? 'noopener' : null,
      'data-action': 'open',
    });
  }
  const status = el('span', { class: 'action-status', role: 'status' });
  const btn = el('button', { class: 'btn-primary btn-inline btn-small need-action', type: 'button', text: action.label, 'data-action': 'approve' });
  const box = el('span', { class: 'need-action-box' }, btn, status);
  const go = async () => {
    btn.disabled = true; status.textContent = 'Working…';
    const r = await runApprove(action, { fetchImpl, pin });
    status.textContent = r.message;
    if (r.ok) { btn.remove(); if (onDone) onDone(); } else btn.disabled = false;
  };
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!action.confirm) { go(); return; }
    const yes = el('button', { class: 'btn-primary btn-inline btn-small', type: 'button', text: action.label });
    const no = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Cancel' });
    const confirmBox = el('span', { class: 'confirm need-confirm' }, el('span', { class: 'confirm-text', text: action.confirm }), no, yes);
    box.replaceChildren(confirmBox, status);
    no.addEventListener('click', () => box.replaceChildren(btn, status));
    yes.addEventListener('click', () => { box.replaceChildren(btn, status); go(); });
  });
  return box;
}

/**
 * Deep-link landing: the `item` query value of the current hash, so a page can open
 * or scroll to the exact row a needs-you tap points at.
 */
export function wantedItem(hash = (typeof location !== 'undefined' ? location.hash : '')) {
  try { return new URLSearchParams(String(hash).split('?')[1] || '').get('item'); } catch { return null; }
}

/**
 * The wanted item, taken once: it is removed from the address (without a reload) so a
 * page's 30-second refresh does not land on it again after the operator moved on.
 */
export function consumeItem() {
  const item = wantedItem();
  if (!item || typeof location === 'undefined') return item;
  try {
    const [path, q] = location.hash.split('?');
    const p = new URLSearchParams(q || '');
    p.delete('item');
    const rest = p.toString();
    history.replaceState(null, '', `${location.pathname}${location.search}${path}${rest ? '?' + rest : ''}`);
  } catch (err) { console.warn('[console] could not tidy the address after landing:', err); }
  return item;
}

/** Scroll to and mark the row whose data-item matches the wanted item; returns it. */
export function landOn(root, item) {
  if (!root || !item) return null;
  const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(item) : String(item).replace(/["\\]/g, '\\$&');
  const n = root.querySelector(`[data-item="${esc}"]`);
  if (!n) return null;
  n.classList.add('landed');
  if (typeof n.scrollIntoView === 'function') n.scrollIntoView({ block: 'center' });
  return n;
}

// section() rows in ui.js render their action through this.
setActionRenderer((a) => actionControl(a));
