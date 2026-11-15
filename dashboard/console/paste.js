// Paste to a session (docs/specs/console-features/work.md, "Send content", legacy tab
// `dropzone`): the sheet the Sessions page opens from "Paste to a session" (the target
// asked, the most recently active one preselected and named) or from an open session's
// "⋯" → "Paste long text" (the target fixed). Rendering only; every decision is in
// paste-model.js. Every value goes through textContent; no alert(), no confirm(); the
// bearer token is enough for every route, so there is no PIN.

import {
  countWords, keptWords, pasteTargets, targetWords, pasteBody, pasteResultWords, buildRecent, recentHead,
  DELETE_CONFIRM, deleteResultWords, pasteEvent, LABEL_MAX,
} from './paste-model.js';
import { el, setKids, sheet, closeSheet, note, askLink } from './ui.js';

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

async function call(method, path, body) {
  try {
    const r = await fetch(path, { method, headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  } catch { return { status: 0, data: {} }; }
}

// The one open sheet's live hook (paste events).
let live = null;

/**
 * Every socket frame the Sessions page receives passes through here first.
 * Returns nothing; the page keeps handling its own frames.
 */
export function pasteOnMessage(msg) {
  if (!live || !msg) return;
  if (!live.panel.isConnected) { live = null; return; }
  const ev = pasteEvent(msg, { titleOf: live.titleOf });
  if (ev) live.onPasteEvent(ev);
}

/**
 * Open the paste sheet. api: { ctx, rows, fixedKey?, openHref(key) → the session's own address }.
 */
export function openPasteSheet(api) {
  const { ctx, rows } = api;
  const titleOf = (name) => { const r = (rows || []).find((x) => x.session && x.session.name === name); return r ? r.title : null; };
  const t = pasteTargets(rows, { fixedKey: api.fixedKey || null });

  const pick = el('select', { class: 'reason-input', 'aria-label': 'Paste to' });
  setKids(pick, t.choices.map((c) => el('option', { value: c.value, text: c.label })));
  if (t.value) pick.value = t.value;
  const where = el('p', { class: 'paste-where' });
  const label = el('input', { class: 'reason-input', type: 'text', maxlength: String(LABEL_MAX), placeholder: 'What is it? (optional)', 'aria-label': 'What is it? (optional)' });
  const text = el('textarea', { class: 'reason-input paste-text', rows: '8', placeholder: 'Paste here…', 'aria-label': 'Text to paste' });
  const counts = el('p', { class: 'paste-count', text: countWords('') });
  const kept = el('p', { class: 'paste-kept', text: keptWords(7) });
  const go = el('button', { class: 'btn-primary paste-go', type: 'button', text: 'Send', 'data-paste-send': '1' });
  const result = el('p', { class: 'action-status paste-result', role: 'status' });
  const recentBox = el('section', { class: 'list-section paste-recent' });
  const choice = () => t.choices.find((c) => c.value === pick.value) || null;

  const syncTarget = () => {
    const c = choice();
    where.textContent = targetWords(c);
    const remote = c && c.kind === 'remote';
    go.textContent = remote ? 'Open that session' : 'Send';
    kept.hidden = Boolean(remote);
    label.hidden = Boolean(remote);
    text.hidden = Boolean(remote);
    counts.hidden = Boolean(remote);
  };
  pick.addEventListener('change', () => { result.textContent = ''; result.removeAttribute('data-tone'); syncTarget(); });
  text.addEventListener('input', () => { counts.textContent = countWords(text.value); });

  // A warning result always carries a way to act: the shared "Ask the agent about this" link (the text stays in the box to send again).
  const show = (w, { ask = true } = {}) => {
    result.textContent = w.text;
    result.setAttribute('data-tone', w.tone || 'ok');
    if (ask && (w.tone === 'attn' || w.tone === 'bad')) result.append(' ', askLink(`Paste to a session: ${w.text}`));
  };
  let lastPasteId = null;

  go.addEventListener('click', async () => {
    const c = choice();
    if (c && c.kind === 'remote') { openRemote(c); return; }
    const req = pasteBody({ text: text.value, label: label.value, choice: c });
    // warning-exempt: an input problem with the text or the target, fixed in the boxes right above it
    if (!req.ok) { show({ text: req.problems.join(' '), tone: 'bad' }, { ask: false }); return; }
    go.disabled = true; show({ text: 'Sending…', tone: 'unknown' });
    const x = await call('POST', '/pastes', req.body);
    const w = pasteResultWords(x.status, x.data, { titleOf });
    show(w);
    go.disabled = false;
    if (w.state !== 'failed') {
      lastPasteId = w.pasteId;
      text.value = ''; label.value = ''; counts.textContent = countWords('');
      loadRecent();
    }
  });

  // Another machine's session: a stored paste cannot reach it, so open it and paste into its own
  // message box (the composer keeps a draft and says whether that machine took it).
  function openRemote(c) {
    closeSheet();
    location.hash = api.openHref(c.row.key);
  }

  let recentModel = null;
  let recentOpen = false;
  function paintRecent() {
    const h = recentHead(recentModel);
    const head = el('button', { class: 'list-head', type: 'button', 'aria-expanded': recentOpen ? 'true' : 'false', 'data-recent': '1' },
      el('h2', { class: 'eyebrow', text: h.title }), el('span', { class: 'chev', 'aria-hidden': 'true', text: recentOpen ? '⌄' : '›' }));
    head.addEventListener('click', () => { recentOpen = !recentOpen; paintRecent(); });
    const sub = el('p', { class: 'card-note', text: h.sub });
    const body = el('div', { class: 'rows list-rows', hidden: !recentOpen });
    if (recentModel && recentModel.ok) body.append(...recentModel.rows.map(recentRow));
    setKids(recentBox, head, sub, body);
  }
  function recentRow(r) {
    const box = el('div', { class: 'row paste-row', 'data-paste': r.id },
      el('span', { class: r.tone === 'attn' ? 'dot attn' : r.tone === 'unknown' ? 'dot unknown' : 'dot live' }),
      el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: r.title }), el('span', { class: 'row-sub', text: r.sub })));
    const status = el('p', { class: 'action-status', role: 'status' });
    const del = el('button', { class: 'btn-quiet', type: 'button', text: 'Delete', 'data-paste-delete': r.id });
    const actions = el('div', { class: 'paste-row-actions' }, del);
    del.addEventListener('click', () => {
      const keep = el('button', { class: 'btn-quiet', type: 'button', text: 'Keep it', onclick: () => setKids(actions, del) });
      const yes = el('button', { class: 'btn-danger', type: 'button', text: 'Delete', 'data-paste-delete-confirm': r.id });
      yes.addEventListener('click', async () => {
        yes.disabled = true; status.textContent = 'Deleting…';
        const x = await call('DELETE', `/pastes/${encodeURIComponent(r.id)}`);
        const w = deleteResultWords(x.status, x.data);
        status.textContent = w.text;
        if (w.ok) { setKids(actions, status); setTimeout(() => loadRecent(), 700); } else yes.disabled = false;
      });
      setKids(actions, el('div', { class: 'confirm' }, el('p', { class: 'confirm-text', text: DELETE_CONFIRM }), el('div', { class: 'confirm-row' }, keep, yes)), status);
    });
    return el('div', { class: 'paste-item' }, box, actions);
  }
  async function loadRecent() {
    const res = await ctx.get('/pastes');
    recentModel = buildRecent(res, { now: Date.now() });
    if (recentModel.ok) kept.textContent = keptWords(recentModel.retentionDays);
    if (recentBox.isConnected) paintRecent();
  }

  const blocks = [];
  if (!t.choices.length) blocks.push(note('That session is not running any more. Go back and pick another one.'));
  else if (t.fixed) blocks.push(el('p', { class: 'card-line', text: `Paste to: ${t.choices[0].label}` }));
  else blocks.push(el('label', { class: 'limit-field' }, el('span', { text: 'Paste to' }), pick));
  blocks.push(where, label, text, counts, kept, go, result, recentBox);
  const panel = sheet({ title: t.fixed ? 'Paste long text' : 'Paste to a session', onClose: () => { if (live && live.panel === panel) live = null; } }, ...blocks);
  live = {
    panel, titleOf,
    onPasteEvent: (ev) => {
      if (ev.pasteId && ev.pasteId === lastPasteId) show(ev);
      loadRecent();
    },
  };
  if (!t.choices.length) { go.disabled = true; text.disabled = true; }
  syncTarget();
  paintRecent();
  loadRecent();
  setTimeout(() => { if (t.choices.length) text.focus(); }, 50);
  return panel;
}
