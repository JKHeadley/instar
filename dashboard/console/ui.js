// Console shared UI parts (docs/specs/console-features/00-patterns.md).
// Every dynamic value is written with textContent; the only HTML strings are the
// static icons from nav-model.js.

import { icon } from './nav-model.js';

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'icon') n.insertAdjacentHTML('afterbegin', icon(v));
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  // Any depth: an array left inside the kids would otherwise be stringified into the page ("[object HTMLParagraphElement]").
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid);
  return n;
}

/** 1. The feature page head: eyebrow, headline sentence, context line, facts. */
export function pageHead({ eyebrow, headline, sub, tone, facts = [] }) {
  return el('section', { class: 'hero page-hero', 'data-tone': tone || 'ok' },
    el('div', { class: 'eyebrow', text: eyebrow }),
    el('h1', { class: 'page-title', text: headline }),
    sub ? el('p', { text: sub }) : null,
    facts.length ? el('div', { class: 'facts' }, facts.map((f) => el(f.href ? 'a' : 'span', { class: `fact${f.tone ? ' ' + f.tone : ''}`, href: f.href || null },
      el('span', { class: 'fact-n', text: String(f.n) }), el('span', { class: 'fact-label', text: f.label })))) : null,
  );
}

/** A dashed honesty note (can't tell / partial / stale). */
export function note(text) { return el('p', { class: 'card-note', text }); }

/** Where a machine's reachability is shown. */
export const MACHINES_PAGE = '#/capacity/machines';
/** A note about a machine that did not answer: anything that fails links to the problem. */
export function machineIssue(text) {
  return /did not answer|not answering|didn[’']t answer|Couldn['’]t read other machines/i.test(String(text || ''));
}
export function noteLinked(text) {
  if (!machineIssue(text)) return note(text);
  return el('p', { class: 'card-note' }, document.createTextNode(`${text} `), el('a', { href: MACHINES_PAGE, text: 'See machines' }));
}

/** 5. Can't tell, as a whole page. */
export function cantTell(reason) {
  return el('section', { class: 'card', 'data-state': 'unknown' },
    el('div', { class: 'card-head' }, el('span', { class: 'dot unknown' }), el('h2', { class: 'card-title', text: 'Can’t tell' })),
    el('p', { class: 'card-line', text: reason }));
}

/** 2. A section of rows with a title and count; collapsible sections start closed. */
export function section({ id, title, rows, collapsed = false, empty, limit = 20, onRow, tone }) {
  const wrap = el('section', { class: `list-section${tone ? ' ' + tone : ''}`, id: `sec-${id}` });
  const head = el(collapsed ? 'button' : 'div', { class: 'list-head', type: collapsed ? 'button' : null, 'aria-expanded': collapsed ? 'false' : null },
    el('h2', { class: 'eyebrow', text: title }), el('span', { class: 'list-count', text: String(rows.length) }),
    collapsed ? el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }) : null);
  const body = el('div', { class: 'rows list-rows', hidden: collapsed });
  let shown = 0;
  const renderMore = () => {
    const next = rows.slice(shown, shown + limit);
    for (const r of next) {
      const b = el('button', { class: 'row', type: 'button', 'data-focus-key': r.key },
        el('span', { class: r.tone === 'bad' ? 'dot bad' : r.tone === 'attn' ? 'dot attn' : r.tone === 'unknown' ? 'dot unknown' : 'dot' }),
        el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: r.main }), r.sub ? el('span', { class: 'row-sub', text: r.sub }) : null),
        el('span', { class: 'row-end' }, document.createTextNode(r.end || ''), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })),
      );
      b.addEventListener('click', () => onRow && onRow(r));
      body.insertBefore(b, more);
    }
    shown += next.length;
    more.hidden = shown >= rows.length;
    more.textContent = `Show ${Math.min(limit, rows.length - shown)} more`;
  };
  const more = el('button', { class: 'link-btn show-more', type: 'button' });
  more.addEventListener('click', renderMore);
  body.append(more);
  if (rows.length === 0) { more.hidden = true; body.prepend(el('p', { class: 'empty-line', text: empty || 'Nothing here.' })); }
  else renderMore();
  if (collapsed) head.addEventListener('click', () => { body.hidden = !body.hidden; head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true'); });
  wrap.append(head, body);
  return wrap;
}

/** 3. Detail sheet: bottom sheet on a phone, side panel on desktop. */
let openSheet = null;
export function sheet({ title, onClose }, ...content) {
  closeSheet();
  const priorOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  const panel = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', { class: 'sheet-grab', 'aria-hidden': 'true' }),
    el('div', { class: 'sheet-head' }, el('h2', { class: 'sheet-title', text: title }),
      el('button', { class: 'chip icon-btn sheet-close', type: 'button', 'aria-label': 'Close', text: '×', onclick: () => closeSheet() })),
    el('div', { class: 'sheet-body' }, content));
  const scrim = el('div', { class: 'scrim', onclick: () => closeSheet() });
  const root = el('div', { class: 'sheet-root' }, scrim, panel);
  document.body.append(root);
  const onKey = (e) => { if (e.key === 'Escape') closeSheet(); };
  document.addEventListener('keydown', onKey);
  openSheet = { root, onClose, onKey, priorOverflow };
  requestAnimationFrame(() => root.classList.add('open'));
  panel.querySelector('.sheet-close').focus({ preventScroll: true });
  return panel;
}
export function closeSheet() {
  if (!openSheet) return;
  const { root, onClose, onKey, priorOverflow } = openSheet;
  openSheet = null;
  document.documentElement.style.overflow = priorOverflow;
  document.removeEventListener('keydown', onKey);
  root.remove();
  if (onClose) onClose();
}
export function sheetIsOpen() { return Boolean(openSheet); }

/** Story lines: label + text pairs. */
export function story(lines) {
  return el('dl', { class: 'story' }, lines.flatMap((l) => [el('dt', { text: l.label }), el('dd', { text: l.text })]));
}

// Only fields with a clear operator meaning belong in a detail sheet. Raw
// records still exist in the API, but dumping their keys, IDs and JSON into
// the console makes an expanded view harder to understand than the summary.
const DETAIL_LABELS = {
  name: 'Name', nickname: 'Name', description: 'Description', reason: 'Reason', resolution: 'Outcome',
  status: 'Status', state: 'State', priority: 'Priority', severity: 'Severity',
  email: 'Email', provider: 'Provider', framework: 'App', model: 'Model',
  online: 'Answering', connectedNow: 'Connected now',
  startedAt: 'Started', createdAt: 'Recorded', updatedAt: 'Updated', lastActivity: 'Last activity',
  lastRun: 'Last run', nextRun: 'Next run', lastSentAt: 'Last sent', lastAckedAt: 'Last acknowledged',
  lastInboundAt: 'Last received', lastRefreshAt: 'Last refreshed',
  toolsUsed: 'Tools used', backgroundTasks: 'Background tasks', eventCount: 'Recorded events',
  pendingCount: 'Waiting', failedCount: 'Failed', unconfirmedCount: 'Unconfirmed',
  attempts: 'Attempts', lastOutcome: 'Last outcome', lastResult: 'Last result',
  scheduleWords: 'Schedule', machineNickname: 'Machine',
};

function detailValue(key, value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /^(?:[a-f0-9]{24,}|m_[a-f0-9]{16,})$/i.test(text)) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    const time = Date.parse(text);
    if (Number.isFinite(time)) return new Date(time).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  return ['status', 'state', 'priority', 'severity', 'lastOutcome', 'lastResult', 'provider', 'framework'].includes(key)
    ? text.replace(/[-_]/g, ' ') : text;
}

/** A fold of readable context; unknown technical fields are omitted. */
export function details(obj, keys) {
  const d = el('details', { class: 'raw' }, el('summary', { text: 'More context' }));
  const dl = el('dl', { class: 'raw-fields' });
  for (const k of keys) {
    const label = DETAIL_LABELS[k];
    const value = label ? detailValue(k, obj[k]) : null;
    if (value === null) continue;
    dl.append(el('dt', { text: label }), el('dd', { text: value }));
  }
  if (!dl.childNodes.length) d.hidden = true;
  d.append(dl);
  return d;
}

/**
 * 4. An action with an honest result: shows progress, then the server's real answer.
 * run() must resolve to { ok, message } (message shown on failure).
 */
export function actionButton({ label, kind = 'primary', confirm, reason, run, done }) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const btn = el('button', { class: kind === 'primary' ? 'btn-primary btn-inline' : 'btn-quiet', type: 'button', text: label });
  if (kind === 'danger-quiet') kind = 'danger';
  const box = el('div', { class: 'action' }, btn, status);
  btn.addEventListener('click', () => {
    if (confirm || reason) {
      const input = reason ? el('textarea', { class: 'reason-input', rows: '2', placeholder: reason, 'aria-label': reason }) : null;
      const go = el('button', { class: kind === 'danger' ? 'btn-danger' : 'btn-primary btn-inline', type: 'button', text: label });
      const cancel = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel' });
      const confirmBox = el('div', { class: 'confirm' }, el('p', { class: 'confirm-text', text: confirm || '' }), input, el('div', { class: 'confirm-row' }, cancel, go));
      box.replaceChildren(confirmBox, status);
      if (input) input.focus();
      cancel.addEventListener('click', () => box.replaceChildren(btn, status));
      go.addEventListener('click', async () => {
        if (input && !input.value.trim()) { status.textContent = 'A reason is needed.'; input.focus(); return; }
        go.disabled = true; status.textContent = 'Working…';
        const r = await run(input ? input.value.trim() : undefined);
        if (r.ok) { status.textContent = r.message || 'Done.'; box.replaceChildren(status); if (done) done(); }
        else { status.textContent = r.message || 'That did not work.'; go.disabled = false; }
      });
      return;
    }
    (async () => {
      btn.disabled = true; status.textContent = 'Working…';
      const r = await run();
      if (r.ok) { status.textContent = r.message || 'Done.'; btn.remove(); if (done) done(); }
      else { status.textContent = r.message || 'That did not work.'; btn.disabled = false; }
    })();
  });
  return box;
}

/** replaceChildren that skips null/false (a bare null would render as the text "null"). */
export function setKids(node, ...kids) {
  const page = node.tagName === 'MAIN' && node.isConnected && node.childElementCount > 0 && !restoring ? capturePlace(node) : null;
  if (node.tagName === 'MAIN') node.dataset.painted = '1';
  node.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  if (node.tagName !== 'MAIN' || restoring) return;
  const drawn = foldStates(node);
  if (page) restorePlace(node, page);
  drawnFolds.set(node, drawn);
}

// ── A refresh keeps the operator's place (Dashboard UX Standard F12) ───────
// Every page repaints by replacing what is in <main>. Replacing and restoring in
// one task means the browser never paints the gap: no flash, no jump. Folds are
// matched by what they say (numbers ignored, a count going from 3 to 4 is the same
// fold), so this needs nothing from the page. Only a fold the operator moved away from
// how the page last drew it is put back; a page that keeps its own fold state (and
// repaints BECAUSE that state changed) is never fought.
let restoring = false;
const drawnFolds = new WeakMap(); // <main> → key → how the page itself last drew each fold
const foldIsOpen = (n) => (n.tagName === 'DETAILS' ? n.open : n.getAttribute('aria-expanded') === 'true');
function foldStates(root) {
  const out = new Map();
  for (const [n, key] of placeKeys(root)) if (n.tagName === 'DETAILS' || (n.tagName === 'BUTTON' && n.hasAttribute('aria-expanded'))) out.set(key, foldIsOpen(n));
  return out;
}
function placeKeys(root) {
  const seen = new Map();
  const keys = new Map();
  for (const n of root.querySelectorAll('*')) {
    const tag = n.tagName;
    const fold = tag === 'DETAILS' || (tag === 'BUTTON' && n.hasAttribute('aria-expanded'));
    const scrolled = n.scrollTop > 0 || n.scrollLeft > 0;
    const entry = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || n.hasAttribute('tabindex');
    if (!fold && !scrolled && !entry && n.classList.length === 0) continue;
    const home = n.parentElement && n.parentElement.closest('[id]');
    const label = (tag === 'DETAILS' ? (n.querySelector(':scope > summary') || n).textContent : fold || entry ? (n.getAttribute('aria-label') || n.textContent || n.getAttribute('name') || n.getAttribute('placeholder') || '') : n.className) || '';
    const base = `${tag}|${home && home !== root ? home.id : ''}|${String(label).replace(/\d+/g, '#').trim().slice(0, 80)}`;
    const nth = seen.get(base) || 0;
    seen.set(base, nth + 1);
    keys.set(n, `${base}|${nth}`);
  }
  return keys;
}
function capturePlace(root) {
  const place = { x: window.scrollX, y: window.scrollY, folds: new Map(), scrolls: new Map(), focus: null };
  const drawn = drawnFolds.get(root) || new Map();
  for (const [n, key] of placeKeys(root)) {
    if ((n.tagName === 'DETAILS' || (n.tagName === 'BUTTON' && n.hasAttribute('aria-expanded'))) && drawn.has(key) && drawn.get(key) !== foldIsOpen(n)) place.folds.set(key, foldIsOpen(n));
    if (n.scrollTop > 0 || n.scrollLeft > 0) place.scrolls.set(key, [n.scrollLeft, n.scrollTop]);
    if (n === document.activeElement) place.focus = key;
  }
  return place;
}
function restorePlace(root, place) {
  restoring = true;
  try {
    for (const [n, key] of placeKeys(root)) {
      if (!place.folds.has(key) || !n.isConnected) continue;
      const was = place.folds.get(key);
      if (foldIsOpen(n) === was) continue;
      if (n.tagName === 'DETAILS') n.open = was;
      else n.click();
    }
    // Fold changes above can add height; positions are restored last, against the final layout.
    for (const [n, key] of placeKeys(root)) {
      const at = place.scrolls.get(key);
      if (at) { n.scrollLeft = at[0]; n.scrollTop = at[1]; }
      if (place.focus === key && typeof n.focus === 'function') n.focus({ preventScroll: true });
    }
    if (window.scrollX !== place.x || window.scrollY !== place.y) window.scrollTo(place.x, place.y);
  } finally { restoring = false; }
}

/** Marks the block that leads a page because it needs the operator. A fixed source id from needs-model.js, never a row key (some carry one-time tokens). */
export function markNeed(node, sourceId) { if (node) node.setAttribute('data-operator-need', sourceId); return node; }

/** The loading placeholder: only ever shown before a page's first real paint, never over real content. */
export function firstPaint(main, ...kids) {
  if (main.dataset.painted) return;
  main.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
}

let arrived = new Set();
/** A new page or link arrived (console route()): its deep-link scroll may run again. */
export function newArrival() { arrived = new Set(); }
/** The one way to scroll to a deep-linked section: once per arrival, per key, never on a repaint. */
export function arrivalScroll(node, { key = 'page', open = false, block = 'start' } = {}) {
  if (!node || arrived.has(key)) return false;
  arrived.add(key);
  if (open) { const head = node.querySelector('button.list-head[aria-expanded="false"]'); if (head) head.click(); }
  if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block });
  return true;
}

/** F9 at the shell: is the operator in the middle of something a repaint would destroy? */
export function refreshHeld(root) {
  if (!root) return false;
  if (root.querySelector('[data-interaction-open]')) return true;
  const a = document.activeElement;
  if (a && root.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable || (a.tagName === 'INPUT' && !/^(button|checkbox|radio|submit|reset|range|color|file)$/.test(a.type)))) return true;
  for (const f of root.querySelectorAll('input, textarea')) {
    if (/^(button|checkbox|radio|submit|reset|range|color|file|hidden)$/.test(f.type || '')) continue;
    if (f.value !== f.defaultValue) return true;
  }
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
  return Boolean(sel && !sel.isCollapsed && sel.anchorNode && root.contains(sel.anchorNode));
}

// ── PIN sheet (00-patterns.md §4: one look, per-action adapters) ───────────
// adapter 'session': POST /dashboard/unlock → operator-session token, held in page
//   memory only until the server-set expiry; later session actions reuse it.
// adapter 'body': the typed PIN is returned for exactly one request and the field
//   is cleared at once; it is never stored or replayed.
let opSession = null; // { token, expiresAt }
export function operatorSession() {
  return opSession && Date.parse(opSession.expiresAt) > Date.now() + 5000 ? opSession.token : null;
}
export function forgetOperatorSession() { opSession = null; }

/**
 * Asks the server whether a PIN typed on this connection can be accepted.
 * A PIN box is shown only when it can; otherwise the caller shows the reason
 * and a link to the secure address. If the check itself cannot be read, the
 * box is shown as before (the unlock route still answers for itself).
 */
export async function unlockCheck() {
  try {
    const r = await fetch('/dashboard/unlock-check', { cache: 'no-store' });
    if (!r.ok) return { accepted: true };
    const d = await r.json();
    if (d && d.accepted === false) {
      return { accepted: false, reason: typeof d.reason === 'string' ? d.reason : 'Your PIN cannot be accepted on this address.', secureUrl: secureHref(d.secureUrl) };
    }
  } catch { /* unreadable check: fall back to the box */ }
  return { accepted: true };
}

/** The same page on the secure address, or null when none is known. */
export function secureHref(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${location.pathname}${location.search}${location.hash}`;
  } catch { return null; }
}

/** What to show instead of a PIN box the server would refuse. */
export function refusedUnlock(check) {
  return el('div', { class: 'pin-form' },
    el('p', { class: 'confirm-text', text: check.reason }),
    check.secureUrl
      ? el('a', { class: 'btn-primary', href: check.secureUrl, text: 'Open the secure address' })
      : el('p', { class: 'confirm-text', text: 'Open this dashboard from your usual dashboard link, or on the machine itself.' }),
  );
}

export function askPin({ title, explain, adapter = 'body' }) {
  if (adapter === 'session' && operatorSession()) return Promise.resolve({ session: operatorSession() });
  return unlockCheck().then((check) => new Promise((resolve) => {
    if (!check.accepted) {
      sheet({ title: title || 'Your PIN', onClose: () => resolve(null) }, refusedUnlock(check));
      return;
    }
    const input = el('input', { class: 'pin-input', type: 'password', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '12', 'aria-label': 'Dashboard PIN' });
    const err = el('p', { class: 'unlock-error', role: 'alert' });
    const go = el('button', { class: 'btn-primary', type: 'submit', text: 'Continue' });
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const form = el('form', { class: 'pin-form' }, el('p', { class: 'confirm-text', text: explain || 'This needs your dashboard PIN.' }), input, go, err);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const pin = input.value;
      if (!pin) { err.textContent = 'Type your PIN.'; return; }
      if (adapter === 'body') { input.value = ''; finish({ pin }); closeSheet(); return; }
      go.disabled = true; err.textContent = '';
      try {
        const r = await fetch('/dashboard/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
        input.value = '';
        const d = await r.json().catch(() => ({}));
        if (!r.ok || typeof d.operatorSessionToken !== 'string' || !d.operatorSessionToken) {
          err.textContent = d.error ? `${d.error}${typeof d.attemptsRemaining === 'number' ? ` · ${d.attemptsRemaining} tries left` : ''}` : 'That did not work.';
          go.disabled = false; input.focus(); return;
        }
        opSession = { token: d.operatorSessionToken, expiresAt: d.operatorSessionExpiresAt || new Date(Date.now() + 10 * 60000).toISOString() };
        finish({ session: opSession.token }); closeSheet();
      } catch { err.textContent = 'The server could not be reached.'; go.disabled = false; }
    });
    sheet({ title: title || 'Your PIN', onClose: () => finish(null) }, form);
    setTimeout(() => input.focus(), 50);
  }));
}
