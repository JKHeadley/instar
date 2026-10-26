// Paste to a session (docs/specs/console-features/work.md, "Send content", legacy tab
// `dropzone`): the sheet the Sessions page opens from "Paste to a session" (the target
// asked, the most recently active one preselected and named) or from an open session's
// "⋯" → "Paste long text" (the target fixed). Rendering only; every decision is in
// send-model.js. Every value goes through textContent; no alert(), no confirm(); the
// bearer token is enough for every route, so there is no PIN.

import {
  countWords, keptWords, pasteTargets, targetWords, pasteBody, pasteResultWords, buildRecent, recentHead,
  DELETE_CONFIRM, deleteResultWords, pasteEvent, typeResultWords, LABEL_MAX, TYPE_ANSWER_MS,
} from './send-model.js';
import { frame } from './sessions-model.js';
import { el, setKids, sheet, note } from './ui.js';

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

async function call(method, path, body) {
  try {
    const r = await fetch(path, { method, headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  } catch { return { status: 0, data: {} }; }
}

// The one open sheet's live hooks (paste events, the typed-input answer).
let live = null;

/**
 * Every socket frame the Sessions page receives passes through here first.
 * Returns nothing; the page keeps handling its own frames.
 */
export function pasteOnMessage(msg) {
  if (!live || !msg) return;
  if (!live.panel.isConnected) { live = null; return; }
  const ev = pasteEvent(msg, { titleOf: live.titleOf });
  if (ev) { live.onPasteEvent(ev); return; }
  const t = live.typing;
  if (!t || msg.session !== t.session) return;
  if (msg.type === 'input_ack') t.done({ ack: msg.success === true });
  else if (msg.type === 'error' && msg.code) t.done({ code: msg.code });
}

/**
 * Open the paste sheet. api: { ctx, rows, fixedKey?, wsSend(frame) → bool, isViewing(key) → bool }.
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
    const typed = c && c.kind === 'type';
    go.textContent = typed ? 'Type it into the session' : 'Send';
    kept.hidden = Boolean(typed);
  };
  pick.addEventListener('change', () => { result.textContent = ''; result.removeAttribute('data-tone'); syncTarget(); });
  text.addEventListener('input', () => { counts.textContent = countWords(text.value); });

  const show = (w) => { result.textContent = w.text; result.setAttribute('data-tone', w.tone || 'ok'); };
  let lastPasteId = null;

  go.addEventListener('click', async () => {
    const c = choice();
    if (c && c.kind === 'type') { typeInto(c); return; }
    const req = pasteBody({ text: text.value, label: label.value, choice: c });
    if (!req.ok) { show({ text: req.problems.join(' '), tone: 'bad' }); return; }
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

  // Another machine's session: the text goes as terminal input over the live stream.
  async function typeInto(c) {
    const value = text.value;
    if (!value.trim()) { show({ text: 'Paste some text first.', tone: 'bad' }); return; }
    const s = c.row.session;
    const machine = s.machineNickname || 'that machine';
    const viewing = api.isViewing(c.row.key);
    go.disabled = true; show({ text: `Typing it into the session on ${machine}…`, tone: 'unknown' });
    const answer = await new Promise((resolve) => {
      if (!viewing && !api.wsSend(frame('subscribe', s))) { resolve({ code: 'not-connected' }); return; }
      const timer = setTimeout(() => finish({ timeout: true }), TYPE_ANSWER_MS);
      function finish(a) { clearTimeout(timer); if (live && live.typing && live.typing.done === finish) live.typing = null; resolve(a); }
      if (live) live.typing = { session: s.tmuxSession, done: finish };
      if (!api.wsSend(frame('input', s, { text: value }))) finish({ code: 'not-connected' });
    });
    if (!viewing) api.wsSend(frame('unsubscribe', s));
    const w = typeResultWords(answer, machine);
    show(w);
    go.disabled = false;
    if (w.ok) { text.value = ''; counts.textContent = countWords(''); }
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
    panel, titleOf, typing: null,
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
