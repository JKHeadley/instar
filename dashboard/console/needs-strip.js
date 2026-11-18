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
  const count = Number.isSafeInteger(d.count) && d.count >= 0 ? d.count : null;
  const page = d.continuation;
  const cursor = (v) => v === null || (typeof v === 'string' && v.length > 0);
  const validPage = page === undefined || (page && Number.isSafeInteger(page.start) && page.start >= 0
    && items && page.start + items.length <= count && (items.length > 0 || count === 0)
    && cursor(page.nextCursor) && cursor(page.previousCursor)
    && (page.nextCursor !== null) === (page.start + items.length < count)
    && (page.previousCursor !== null) === (page.start > 0));
  if (!items || items.length > 100 || count === null || items.length > count || !validPage
    || items.some((item) => !item || typeof item.title !== 'string' || typeof item.action?.kind !== 'string')) return { show: true, state: 'unknown', badge: '?', incomplete: true, title: 'Could not check what needs you', rows: [], more: 0, line: 'The list answered in a shape this page cannot read.' };
  const missed = Array.isArray(d.couldNotCheck) ? d.couldNotCheck.filter((x) => typeof x === 'string') : [];
  const complete = d.complete === true && missed.length === 0;
  const truncated = !page && (d.truncated === true || count > items.length);
  const omitted = Math.max(0, count - items.length);
  if (count === 0 && complete && !truncated) return { show: false, state: 'ok', badge: '0', incomplete: false, title: '', rows: [], more: 0, line: '' };
  // Expand only rows actually received. The server bounds each answer; name any omitted rows.
  const rows = expanded ? items : items.slice(0, STRIP_ROWS);
  return {
    show: true,
    // warning-path: row
    state: count > 0 ? (items.some((i) => i.tone === 'bad') ? 'bad' : 'attn') : 'unknown',
    badge: `${count}${complete ? '' : '+?'}`,
    incomplete: !complete,
    title: count > 0 ? `Needs you · ${count}` : 'Nothing found so far',
    rows,
    more: Math.max(0, items.length - rows.length),
    truncated,
    page,
    line: [
      missed.length ? `Could not check ${list(missed)}.` : '',
      truncated ? `This list has ${items.length} of ${count} needs.${omitted > 0 ? ` ${omitted} more ${omitted === 1 ? 'is' : 'are'} not shown.` : ' Some needs may not be shown.'}` : '',
    ].filter(Boolean).join(' '),
  };
}

// Each shell owns its answer and timer. A late read from a previous door cannot populate this one.
let stopPrevious;
export function mountNeedsStrip(host, { get, hrefFor }) {
  stopPrevious?.();
  let active = true, expanded = false, busy = false, sequence = 0;
  let answer = null, cursor = null, failure = null;
  let retryTarget = { cursor: null, start: 0 };
  const button = (text, click, attrs = {}) => el('button', {
    type: 'button', class: 'needs-more link-btn', text, onclick: click, ...attrs,
  });
  const paint = () => {
    const m = stripModel(answer, { expanded });
    host.hidden = !m.show;
    host.dataset.state = m.state;
    host.dataset.incomplete = m.incomplete ? '1' : '0';
    if (!m.show) { host.replaceChildren(); return; }
    const heading = el('h2', { class: 'needs-heading', tabindex: '-1', text: m.title });
    const rows = el('ul', { class: 'needs-rows' }, m.rows.map((r) => {
      const href = hrefFor ? hrefFor(r.action) : null;
      const body = [el('span', { class: TONE_DOT[r.tone] || 'dot attn', 'aria-hidden': 'true' }),
        el('span', { class: 'needs-text' }, el('span', { class: 'needs-title', text: r.title }), el('span', { class: 'needs-why', text: r.why || '' }))];
      return el('li', {}, href ? el('a', { class: 'needs-row', href }, ...body) : el('div', { class: 'needs-row' }, ...body));
    }));
    const controls = [];
    if (m.more > 0 || (expanded && (m.rows.length > STRIP_ROWS || m.page?.previousCursor)) || (!expanded && m.page?.nextCursor)) {
      const text = expanded ? 'Show fewer' : m.page?.nextCursor ? 'Show more needs' : m.truncated ? `Show ${m.more} more available ${m.more === 1 ? 'item' : 'items'}` :
        (m.more === 1 ? 'One more thing needs you. Show it' : `${m.more} more things need you. Show all`);
      controls.push(button(text, () => {
        expanded = !expanded;
        if (!expanded && m.page?.start > 0) { void load({ cursor: null, start: 0 }); return; }
        if (!expanded) cursor = null;
        paint();
        const firstNewRow = expanded && host.querySelector(`li:nth-child(${STRIP_ROWS + 1}) a`);
        (firstNewRow || host.querySelector('[aria-expanded]'))?.focus();
      }, { 'aria-expanded': String(expanded) }));
    }
    if (expanded && m.page && m.rows.length) {
      const { start, previousCursor, nextCursor } = m.page;
      controls.push(el('p', { role: 'status', text: `Showing ${start + 1}–${start + m.rows.length} of ${answer.data.count}` }));
      if (nextCursor || previousCursor) controls.push(el('nav', { 'aria-label': 'Needs list pages' },
        previousCursor && button('Previous page', () => load({ cursor: previousCursor, end: start })),
        nextCursor && button('Next page', () => load({ cursor: nextCursor, start: start + m.rows.length }))));
    }
    if (failure) controls.push(button(failure === 'stale' ? 'Reload current list' : 'Try again',
      () => load(failure === 'stale' ? { cursor: null, start: 0 } : retryTarget)));
    host.replaceChildren(el('div', { class: 'needs-head' }, heading,
      el('span', { class: 'needs-badge', 'aria-label': m.incomplete ? `${m.badge} or more` : m.badge, text: m.badge })),
      ...(m.rows.length ? [rows] : []), ...controls,
      ...(m.line ? [el('p', { class: 'needs-line', text: failure === 'stale' ? 'The needs list changed. Reload to see its current items.' : m.line })] : []));
  };
  const load = async (target, background = false) => {
    const run = ++sequence;
    busy = true;
    if (!background) { answer = null; failure = null; paint(); }
    let res;
    try { res = await get(target.cursor === null ? '/needs' : `/needs?cursor=${encodeURIComponent(target.cursor)}`); }
    catch { res = { ok: false, reason: 'the server could not be reached' }; }
    if (!active || !host.isConnected || sequence !== run) return;
    busy = false;
    const denied = res?.status === 401 || res?.status === 403 || res?.reason === 'not signed in';
    if (res?.ok) {
      const model = stripModel(res, { expanded: true });
      const start = model.page?.start ?? 0;
      if (model.badge === '?' || (target.cursor !== null && !model.page)
        || (target.start !== undefined && start !== target.start)
        || (target.end !== undefined && start + model.rows.length !== target.end)) {
        res = { ok: false, reason: 'the page could not be read' };
      }
    }
    const focused = document.activeElement;
    const focusInStrip = host.contains(focused);
    // Keep a live action stable during ordinary polling. A heading is only a reading position.
    if (background && res?.ok && !failure && focusInStrip && focused.matches('a, button')) return;
    failure = res?.ok || denied ? null : res?.status === 409 ? 'stale' : 'retry';
    retryTarget = denied ? { cursor: null, start: 0 } : target;
    cursor = denied ? null : target.cursor;
    if (denied) expanded = false;
    answer = res || { ok: false, reason: 'no answer' };
    paint();
    if ((background && focusInStrip) || (!background && document.activeElement === document.body)) host.querySelector('.needs-heading')?.focus();
  };
  const timer = setInterval(() => {
    if (!host.isConnected) { stop(); return; }
    if (!busy && failure !== 'stale' && document.visibilityState !== 'hidden') {
      void load(failure === 'retry' ? retryTarget : { cursor, start: answer?.data?.continuation?.start ?? 0 }, true);
    }
  }, STRIP_REFRESH_MS);
  const stop = () => { active = false; clearInterval(timer); };
  stopPrevious = stop;
  paint();
  void load({ cursor: null, start: 0 }, true);
  return stop;
}
