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
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
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
  openSheet = { root, onClose, onKey };
  requestAnimationFrame(() => root.classList.add('open'));
  panel.querySelector('.sheet-close').focus({ preventScroll: true });
  return panel;
}
export function closeSheet() {
  if (!openSheet) return;
  const { root, onClose, onKey } = openSheet;
  openSheet = null;
  document.removeEventListener('keydown', onKey);
  root.remove();
  if (onClose) onClose();
}
export function sheetIsOpen() { return Boolean(openSheet); }

/** Story lines: label + text pairs. */
export function story(lines) {
  return el('dl', { class: 'story' }, lines.flatMap((l) => [el('dt', { text: l.label }), el('dd', { text: l.text })]));
}

/** A fold with raw fields (identifiers last, mono). */
export function details(obj, keys) {
  const d = el('details', { class: 'raw' }, el('summary', { text: 'Details' }));
  const dl = el('dl', { class: 'raw-fields' });
  for (const k of keys) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === '') continue;
    dl.append(el('dt', { text: k }), el('dd', { class: 'mono', text: typeof obj[k] === 'object' ? JSON.stringify(obj[k]) : String(obj[k]) }));
  }
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
export function setKids(node, ...kids) { node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false)); }
