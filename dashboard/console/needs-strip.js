// The Needs-you strip (docs/specs/work-front-doors.md decision 2, §2.1): above both front doors, drawn
// from the one server read (GET /needs). The only inbox and the only count. It hides only when a
// complete read returns zero; a failed read, a failed source or a read still loading keeps it, says
// "could not check …", and marks the count incomplete.
import { el } from './ui.js';

export const STRIP_ROWS = 3;
// Its own period, apart from the pages' 30 s refresh, so a leak of either is visible on its own.
export const STRIP_REFRESH_MS = 45000;
// warning-path: row
const TONE_DOT = { bad: 'dot bad', attn: 'dot attn', unknown: 'dot unknown' };

const list = (words) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/**
 * res: the console read result ({ ok, data } | { ok: false, reason }), or null while loading.
 * Returns what the strip shows. Pure, no DOM.
 */
export function stripModel(res, { expanded = false } = {}) {
  if (!res) return { show: true, state: 'loading', badge: '…', incomplete: true, title: 'Checking what needs you…', rows: [], more: 0, line: '' };
  if (!res.ok) {
    // An agent server older than the read (404) is "could not check" too: never a zero.
    return { show: true, state: 'unknown', badge: '?', incomplete: true, title: 'Could not check what needs you', rows: [], more: 0, line: `The list did not load: ${res.reason || 'no answer'}. Checking again shortly.` };
  }
  const d = res.data || {};
  const items = Array.isArray(d.items) ? d.items : null;
  const count = Number.isFinite(d.count) ? d.count : null;
  if (!items || count === null) return { show: true, state: 'unknown', badge: '?', incomplete: true, title: 'Could not check what needs you', rows: [], more: 0, line: 'The list answered in a shape this page cannot read.' };
  const missed = Array.isArray(d.couldNotCheck) ? d.couldNotCheck.filter((x) => typeof x === 'string') : [];
  const complete = d.complete === true && missed.length === 0;
  if (count === 0 && complete) return { show: false, state: 'ok', badge: '0', incomplete: false, title: '', rows: [], more: 0, line: '' };
  // "N more" opens the rest in place (every count needs a path to act); the read carries up to 100 items.
  const rows = expanded ? items : items.slice(0, STRIP_ROWS);
  return {
    show: true,
    // warning-path: row
    state: count > 0 ? (items.some((i) => i.tone === 'bad') ? 'bad' : 'attn') : 'unknown',
    badge: `${count}${complete ? '' : '+?'}`,
    incomplete: !complete,
    title: count > 0 ? `Needs you · ${count}` : 'Nothing found so far',
    rows,
    more: Math.max(0, count - rows.length),
    line: missed.length ? `Could not check ${list(missed)}.` : '',
  };
}

// One strip at a time: a new mount (another door) stops the previous refresh.
let timer = null;
let last = null; // the last answer, so a door change paints at once
let expanded = false; // "N more" opened: every item shows until it is closed again

/** Draw the strip into `host` and keep it fresh while it is on screen. `hrefFor(action)` maps a row's action to a link. */
export function mountNeedsStrip(host, { get, hrefFor }) {
  if (timer) { clearInterval(timer); timer = null; }
  let rows = null;
  const paint = (res) => {
    // A refresh never replaces a row being acted on (spec §2.1).
    if (rows && rows.contains(document.activeElement) && document.activeElement !== document.body) return;
    const m = stripModel(res, { expanded });
    host.hidden = !m.show;
    host.dataset.state = m.state;
    host.dataset.incomplete = m.incomplete ? '1' : '0';
    if (!m.show) { host.replaceChildren(); return; }
    rows = el('ul', { class: 'needs-rows' }, m.rows.map((r) => {
      const href = hrefFor ? hrefFor(r.action) : null;
      const body = [el('span', { class: TONE_DOT[r.tone] || 'dot attn', 'aria-hidden': 'true' }),
        el('span', { class: 'needs-text' }, el('span', { class: 'needs-title', text: r.title }), el('span', { class: 'needs-why', text: r.why || '' }))];
      return el('li', {}, href ? el('a', { class: 'needs-row', href }, ...body) : el('div', { class: 'needs-row' }, ...body));
    }));
    host.replaceChildren(
      el('div', { class: 'needs-head' },
        el('h2', { class: 'needs-heading', text: m.title }),
        el('span', { class: 'needs-badge', 'aria-label': m.incomplete ? `${m.badge} or more` : m.badge, text: m.badge })),
      ...(m.rows.length ? [rows] : []),
      ...(m.more > 0 || (expanded && m.rows.length > STRIP_ROWS) ? [moreButton(m)] : []),
      ...(m.line ? [el('p', { class: 'needs-line', text: m.line })] : []),
    );
  };
  // "N more things need you." opens the rest in place; "Show fewer" closes it.
  const moreButton = (m) => {
    const b = el('button', { class: 'needs-more link-btn', type: 'button', 'aria-expanded': expanded ? 'true' : 'false',
      text: expanded ? 'Show fewer' : (m.more === 1 ? 'One more thing needs you. Show it' : `${m.more} more things need you. Show all`) });
    b.addEventListener('click', () => { expanded = !expanded; paint(last); });
    return b;
  };
  paint(last);
  const load = async () => {
    if (!host.isConnected) { if (timer) { clearInterval(timer); timer = null; } return; }
    if (document.visibilityState === 'hidden') return;
    const res = await get('/needs');
    last = res;
    if (host.isConnected) paint(res);
  };
  load();
  timer = setInterval(load, STRIP_REFRESH_MS);
}
