// Sessions (docs/specs/console-features/work.md, "Sessions", legacy tab id `sessions`).
// One list across every machine, grouped by what needs a look; tapping a row opens the
// session full-screen on a phone (list beside it on a desktop): the live terminal (the
// same xterm library and WebSocket protocol the legacy tab uses, streamed from another
// machine through the relay), a multi-line composer, a Keys tray with Stop (Ctrl+C)
// last, red and confirmed, and a "⋯" menu with the door switch, Details and Close.
// Every route here is adapter (a): the bearer token is enough, so there is no PIN.
// Every value goes through textContent; no alert(), no confirm().

import {
  buildSessions, sessionsHeadline, sessionsFacts, partialWords, titleLine, closeRequest, closeConfirmWords,
  closeResultWords, doorChoices, modelChoices, doorModelWords, regimeWords, machineChoices, PLATFORMS,
  platformAllowsDoor, platformAllowsMachine, newRequestId, createBody, createResultWords, defaultWords, profileSourceWords, switchLanded,
  canSwitchDoor, profileKeyOf, DOOR, attachmentMessage, historyUrl, historyErrorWords, historyText, topicOf, topicHistoryUrl, topicHistoryEntry, TOPIC_HISTORY_PAGE, KEYS, STOP_KEY, frame, nextHistoryBatch, streamErrorWords, composerRows, modelWords, HISTORY_FIRST,
} from './sessions-model.js';
import { createInputTracker } from './input-model.js';
import { el, setKids, pageHead, sheet, closeSheet, story, details, note, noteLinked, cantTell, MACHINES_PAGE } from './ui.js';
import { legacyHref } from './nav-model.js';
import { topicNameMap } from './topic-names.js';

const XTERM_JS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js';
const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';
const FIT_JS = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js';
const POOL_TIMEOUT_MS = 8000;

const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const SHOW_INTERNAL_KEY = 'instar_console_show_internal';
function showInternal() { try { return localStorage.getItem(SHOW_INTERNAL_KEY) === '1'; } catch { return false; } }
function setShowInternal(on) { try { localStorage.setItem(SHOW_INTERNAL_KEY, on ? '1' : '0'); } catch { /* per-viewer convenience only */ } }

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

/** A write that keeps the status and the server's body. */
async function send(method, path, body, extraHeaders = {}) {
  try {
    const r = await fetch(path, { method, headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json', ...extraHeaders }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: {} }; }
}

const wantKey = () => new URLSearchParams((location.hash.split('?')[1] || '')).get('s');
/** A question brought from another page (Health's "Ask the agent about this"): it waits in the next message box opened. */
const wantAsk = () => new URLSearchParams((location.hash.split('?')[1] || '')).get('ask');
const listHref = '#/work/sessions';
const openHref = (key) => `#/work/sessions?s=${encodeURIComponent(key)}`;

// ── Page state (one page at a time) ───────────────────────────────────────
const st = {
  main: null, ctx: null, model: null, lastGoodAt: 0, lastFailReason: null,
  wsList: null, ws: null, wsUp: false, wsTries: 0, wsTimer: null,
  view: null, // { key, s, term, fit, pre, following, pending, loaded, exhausted, loading, statusLine }
  switching: new Map(), // tmuxSession → 'switching…' while a door switch lands
  // Composer drafts per open-session key (§3e of native-conversation-any-machine-access):
  // kept for the life of the page, so leaving a session never drops a draft.
  inputs: new Map(), // key → { tracker, s }
};

export async function renderSessions(main, ctx) {
  st.main = main; st.ctx = ctx;
  st.ask = wantAsk() || st.ask || null;
  // A refresh never rebuilds an open session: only the list half repaints.
  if (!main.querySelector('.sessions-page')) {
    leaveView();
    setKids(main, el('div', { class: 'sessions-page' },
      el('div', { class: 'sess-list' }, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Work · Sessions' }), el('h1', { class: 'page-title skeleton', text: 'Loading' })),
        el('div', { class: 'rows list-rows' }, [1, 2, 3].map(() => el('div', { class: 'row skeleton-row' }, el('span', { class: 'skeleton', text: 'Loading a session' }))))),
      el('div', { class: 'sess-view' })));
    st.view = null;
  }
  connectWs();
  const [res, topics] = await Promise.all([ctx.get('/sessions?scope=pool', POOL_TIMEOUT_MS), ctx.get('/telegram/topics?scope=pool', POOL_TIMEOUT_MS)]);
  if (topics.ok) st.topicNames = topicNameMap(topics);
  if (res.ok) { st.poolData = res; st.lastGoodAt = Date.now(); st.lastFailReason = null; } else st.lastFailReason = res.reason;
  paint();
}

const onPage = () => Boolean(st.main && st.main.isConnected && st.main.querySelector('.sessions-page'));

// The last good list is kept (with its age) when a later read fails.
function currentModel() {
  const src = st.poolData || (st.lastFailReason ? { ok: false, reason: st.lastFailReason } : null);
  if (!src) return null;
  return buildSessions(src, { ws: st.wsUp ? st.wsList : null, now: Date.now(), topicNames: st.topicNames || {}, showInternal: showInternal() });
}

function paint() {
  const page = st.main && st.main.querySelector('.sessions-page');
  if (!page || !page.isConnected) { leaveView(); closeWs(); return; }
  const m = currentModel();
  if (!m) return;
  st.model = m;
  const key = wantKey();
  page.classList.toggle('has-open', Boolean(key));
  paintList(page.querySelector('.sess-list'), m, key);
  const v = page.querySelector('.sess-view');
  if (!key) { if (st.view) leaveView(); setKids(v, el('p', { class: 'empty-line sess-pick', text: 'Pick a session to watch it and type to it.' })); return; }
  const row = m.ok ? m.allRows.find((r) => r.key === key) : null;
  if (st.view && st.view.key === key) { if (row) updateViewTitle(row); else markEnded(); return; }
  if (st.view) leaveView();
  if (!row) {
    setKids(v, el('div', { class: 'sess-gone' }, el('a', { class: 'link-btn', href: listHref, text: '‹ All sessions' }),
      m.ok ? note('That session is not running any more, or its machine did not answer.') : cantTell(m.reason)));
    return;
  }
  openView(v, row);
}

// ── The list ──────────────────────────────────────────────────────────────
function paintList(box, m, openKey) {
  const focused = box.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus-key') : null;
  const h = sessionsHeadline(m);
  const parts = [pageHead({ eyebrow: 'Work · Sessions', headline: h.text, tone: h.tone, facts: sessionsFacts(m) })];
  parts.push(el('div', { class: 'page-primary sess-new' },
    el('button', { class: 'btn-primary btn-inline', type: 'button', text: '+ New session', 'data-new': '1', onclick: () => newSessionSheet() }),
    el('button', { class: 'btn-quiet btn-inline', type: 'button', text: 'Session settings', 'data-settings': '1', onclick: () => settingsSheet() })));
  if (st.ask) parts.push(note('Your question is ready. Open a session and it will be waiting in the message box.'));
  if (!st.wsUp) parts.push(el('p', { class: 'stale-banner', role: 'status', text: 'Live updates paused, reconnecting.' }));
  if (m.ok && st.lastFailReason) {
    parts.push(cantTell(`Couldn’t refresh the list: ${st.lastFailReason}.`), note(`Showing the list from ${Math.max(1, Math.round((Date.now() - st.lastGoodAt) / 60000))} min ago.`));
  }
  if (!m.ok) {
    parts.push(cantTell(m.reason));
  } else {
    const pw = partialWords(m);
    // A machine that did not answer links to the Machines page, where its state and reachability are shown.
    if (pw) parts.push(noteLinked(pw));
    if (!m.rows.length) parts.push(el('p', { class: 'empty-line', text: m.multi ? 'Nothing is running on any machine.' : 'Nothing is running on this machine.' }));
    if (m.needsLook.length) parts.push(group('Needs a look', 'look', m.needsLook, openKey));
    if (m.working.length) parts.push(group('Working', 'working', m.working, openKey));
    if (m.unanswered.length || m.idleMachines.length) {
      parts.push(el('section', { class: 'list-section', id: 'sec-idle' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Other machines' })),
        m.unanswered.map((u) => el('a', { class: 'machine-line dashed machine-line-link', href: MACHINES_PAGE, text: `${u.name}: ${u.words} ›` })),
        m.idleMachines.map((i) => el('p', { class: `machine-line${i.ok ? '' : ' dashed'}`, text: `${i.name}: ${i.words}` }))));
    }
  }
  if (m.ok && m.internalCount) {
    const on = m.showInternal;
    parts.push(el('button', { class: 'link-btn sess-internal-toggle', type: 'button', 'aria-pressed': on ? 'true' : 'false',
      text: on ? `Hide ${m.internalCount} internal session${m.internalCount === 1 ? '' : 's'} (jobs and helpers)` : `Show ${m.internalCount} internal session${m.internalCount === 1 ? '' : 's'} (jobs and helpers)`,
      onclick: () => { setShowInternal(!on); paint(); } }));
  }
  parts.push(el('p', { class: 'foot-note' }, el('a', { href: legacyHref('sessions'), text: 'Open sessions in the legacy dashboard' })));
  setKids(box, parts);
  if (focused) {
    const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(focused) : focused.replace(/["\\]/g, '\\$&');
    const n = box.querySelector(`[data-focus-key="${esc}"]`);
    if (n) n.focus({ preventScroll: true });
  }
}

function group(title, id, rows, openKey) {
  return el('section', { class: 'list-section', id: `sec-${id}` },
    el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: title }), el('span', { class: 'list-count', text: String(rows.length) })),
    el('div', { class: 'rows list-rows' }, rows.map((r) => {
      const label = st.switching.get(r.session.tmuxSession);
      return el('a', { class: `row sess-row${r.key === openKey ? ' open' : ''}`, href: openHref(r.key), 'data-focus-key': r.key, 'data-session': r.key },
        el('span', { class: r.tone === 'bad' ? 'dot bad' : r.tone === 'attn' ? 'dot attn' : r.tone === 'unknown' ? 'dot unknown' : r.activity === 'working' ? 'dot live' : 'dot' }),
        el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: r.title }), el('span', { class: 'row-sub', text: label ? `${r.sub} · ${label}` : r.sub })),
        el('span', { class: 'row-end' }, document.createTextNode(r.end || ''), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })));
    })));
}

// ── The WebSocket (this machine's live list + the terminal stream) ───────
function connectWs() {
  if (st.ws && (st.ws.readyState === 0 || st.ws.readyState === 1)) return;
  if (typeof WebSocket === 'undefined') return;
  clearTimeout(st.wsTimer);
  let ws;
  try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?token=${encodeURIComponent(bearer())}`); } catch { return; }
  st.ws = ws;
  ws.onopen = () => {
    st.wsUp = true; st.wsTries = 0;
    if (st.view) { wsSend(frame('subscribe', st.view.s)); setStatus(''); }
    paint();
  };
  ws.onclose = () => {
    const was = st.wsUp; st.wsUp = false; st.ws = null;
    // This page's socket is gone: every composer waits for the machine to say what it can do again.
    for (const x of st.inputs.values()) x.tracker.linkDown();
    if (was) { paint(); setStatus('Live output paused, reconnecting.'); }
    // Reconnect with backoff while the page is on screen.
    if (onPage() && st.wsTries < 10) {
      st.wsTimer = setTimeout(connectWs, Math.min(1000 * 2 ** st.wsTries++, 30_000));
    }
  };
  ws.onmessage = (ev) => { let msg; try { msg = JSON.parse(ev.data); } catch { return; } onMessage(msg); };
}
function closeWs() {
  clearTimeout(st.wsTimer);
  const ws = st.ws; st.ws = null; st.wsUp = false; st.wsList = null;
  if (ws) { ws.onclose = null; try { ws.close(); } catch { /* already closed */ } }
}
function wsSend(msg) { if (st.ws && st.ws.readyState === 1) { st.ws.send(JSON.stringify(msg)); return true; } return false; }

function onMessage(msg) {
  if (!onPage()) { leaveView(); closeWs(); return; }
  const v = st.view;
  switch (msg.type) {
    case 'sessions': st.wsList = Array.isArray(msg.sessions) ? msg.sessions : []; paint(); break;
    case 'output': if (v && msg.session === v.s.tmuxSession) writeOutput(msg.data || ''); break;
    case 'history': if (v && msg.session === v.s.tmuxSession) writeHistory(msg); break;
    case 'session_ended': if (v && msg.session === v.s.tmuxSession) markEnded(); break;
    case 'input_caps': case 'input_ack': inputFrame(msg); break;
    case 'error': {
      if (inputFrame(msg)) break; // an answer about a typed message, shown with that message
      const w = streamErrorWords(msg); if (w && v && (!msg.session || msg.session === v.s.tmuxSession)) setStatus(w); break;
    }
    default: break;
  }
}

/** Hand an input frame to the composer of the session it is about. True when one took it. */
function inputFrame(msg) {
  let took = false;
  for (const x of st.inputs.values()) {
    if (x.s.tmuxSession !== msg.session) continue;
    // A frame relayed from another machine carries its machineId: it belongs only to the
    // composer for that machine's session; a frame without one only to a local session.
    if (msg.machineId ? !(x.s.remote && x.s.machineId === msg.machineId) : x.s.remote) continue;
    if (x.tracker.onFrame(msg)) took = true;
  }
  return took;
}

/** The composer's draft tracker for one session, made once per page. */
function inputFor(key, s) {
  let x = st.inputs.get(key);
  if (x) { x.s = s; return x; }
  x = { s, tracker: null };
  x.tracker = createInputTracker({
    send: (extra) => wsSend(frame('key' in extra ? 'key' : 'input', x.s, extra)),
    onChange: () => { if (st.view && st.view.key === key && st.view.paintInput) st.view.paintInput(); },
  });
  st.inputs.set(key, x);
  return x;
}

// ── The open session ──────────────────────────────────────────────────────
function loadScript(src) {
  return new Promise((resolve) => {
    if (document.querySelector(`script[src="${src}"]`)) { const t = setInterval(() => { if (window.Terminal && window.FitAddon) { clearInterval(t); resolve(true); } }, 100); setTimeout(() => { clearInterval(t); resolve(Boolean(window.Terminal)); }, 8000); return; }
    const s = el('script', { src, crossorigin: 'anonymous' });
    s.onload = () => resolve(true); s.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 8000);
    document.head.append(s);
  });
}
async function loadTerminalLib() {
  if (window.Terminal && window.FitAddon) return true;
  if (!document.querySelector(`link[href="${XTERM_CSS}"]`)) document.head.append(el('link', { rel: 'stylesheet', href: XTERM_CSS }));
  const a = await loadScript(XTERM_JS);
  const b = a && await loadScript(FIT_JS);
  return Boolean(b && window.Terminal && window.FitAddon);
}

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\x1b[@-_]/g, '');

function updateViewTitle(row) {
  const v = st.view;
  v.s = { ...v.s, ...row.session };
  const x = st.inputs.get(v.key); if (x) x.s = v.s;
  const sw = st.switching.get(v.s.tmuxSession);
  v.titleSub.textContent = sw ? `${v.s.machineNickname} · ${sw}` : titleLine(v.s);
}

function setStatus(text) { if (st.view) { st.view.statusLine.textContent = text; st.view.statusLine.hidden = !text; } }
function markEnded() { setStatus('This session has ended.'); if (st.view) st.view.ended = true; }

function openView(box, row) {
  const s = row.session;
  const titleSub = el('p', { class: 'sess-sub', text: titleLine(s) });
  const statusLine = el('p', { class: 'sess-status', role: 'status', hidden: true });
  const termBox = el('div', { class: 'sess-term', 'aria-label': 'Live terminal' });
  const resume = el('button', { class: 'btn-primary btn-inline sess-resume', type: 'button', text: '▼ Back to live', hidden: true });
  const more = el('button', { class: 'btn-quiet sess-more', type: 'button', 'aria-label': 'More', text: '⋯', 'data-more': '1' });
  const input = el('textarea', { class: 'reason-input sess-input', rows: '1', placeholder: 'Message…', 'aria-label': 'Message to the session' });
  if (st.ask) { input.value = st.ask; input.rows = composerRows(st.ask); st.ask = null; }
  const sendBtn = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Send', 'data-send': '1' });
  const keysBtn = el('button', { class: 'btn-quiet', type: 'button', text: 'Keys', 'aria-expanded': 'false', 'data-keys': '1' });
  // Attach: a screenshot or file, picked, pasted or dropped. Saved on this machine, so a
  // session on another machine says so instead of offering it.
  const filePick = el('input', { type: 'file', multiple: true, hidden: true, 'data-file': '1' });
  const attachBtn = el('button', { class: 'btn-quiet sess-attach', type: 'button', 'aria-label': 'Attach a screenshot or file', text: '📎', 'data-attach': '1',
    title: s.remote ? `Attaching works for sessions on this machine; open ${s.machineNickname}’s own console to attach there.` : 'Attach a screenshot or file' });
  if (s.remote) attachBtn.disabled = true;
  const chips = el('div', { class: 'sess-attachments', hidden: true });
  // Unresolved messages sit above the composer, which stays free for a new one.
  const draftsBox = el('div', { class: 'sess-drafts', hidden: true, 'aria-live': 'polite' });
  const files = [];
  const paintChips = () => {
    chips.hidden = !files.length;
    setKids(chips, files.map((f, i) => el('span', { class: 'chip sess-file' }, el('span', { text: f.name }),
      el('button', { class: 'link-btn', type: 'button', 'aria-label': `Remove ${f.name}`, text: '✕', onclick: () => { files.splice(i, 1); paintChips(); } }))));
  };
  const addFiles = (list) => {
    if (s.remote) { setStatus(`Attaching works for sessions on this machine; open ${s.machineNickname}’s own console to attach there.`); return; }
    for (const f of list) {
      if (f.size > ATTACH_MAX_BYTES) { setStatus(`${f.name} is too big to attach (up to 8 MB).`); continue; }
      files.push({ name: f.name || `pasted-${Date.now()}.png`, file: f });
    }
    paintChips();
  };
  attachBtn.addEventListener('click', () => filePick.click());
  filePick.addEventListener('change', () => { addFiles([...filePick.files]); filePick.value = ''; });
  const tray = el('div', { class: 'keys-tray', hidden: true });
  // Live (the terminal) or History (the conversation record, which goes back to the start:
  // a full-screen session keeps no terminal scrollback).
  const historyBox = el('div', { class: 'sess-history', hidden: true, 'aria-label': 'Conversation history' });
  const liveTab = el('button', { class: 'chip sess-tab', type: 'button', text: 'Live', 'aria-pressed': 'true', 'data-tab': 'live' });
  const historyTab = el('button', { class: 'chip sess-tab', type: 'button', text: 'History', 'aria-pressed': 'false', 'data-tab': 'history' });
  const tabs = el('div', { class: 'sess-tabs', role: 'group', 'aria-label': 'View' }, liveTab, historyTab);
  const view = { key: row.key, s, titleSub, statusLine, termBox, historyBox, history: null, resume, following: true, pending: null, loaded: HISTORY_FIRST, exhausted: false, loading: false, term: null, fit: null, pre: null };
  st.view = view;
  const input$ = inputFor(row.key, s);
  let wasSending = false;
  // The composer follows the draft model: it clears a message only on that message's own answer.
  view.paintInput = () => {
    if (st.view !== view) return;
    const m = input$.tracker.view();
    if (m.sending) { input.value = m.sending.text; input.rows = composerRows(m.sending.text); }
    else if (m.returned) { input.value = m.returned.text; input.rows = composerRows(m.returned.text); }
    else if (wasSending) { input.value = ''; input.rows = 1; }
    wasSending = Boolean(m.sending);
    input.readOnly = m.composer.readOnly;
    input.classList.toggle('sending', Boolean(m.sending));
    sendBtn.disabled = m.composer.disabled;
    input.placeholder = m.composer.words || 'Message…';
    const n = input$.tracker.takeNotice();
    if (n) setStatus(n);
    else if (m.composer.words && m.composer.readOnly) setStatus(m.composer.words);
    draftsBox.hidden = !m.drafts.length;
    setKids(draftsBox, m.drafts.map((dr) => el('div', { class: 'sess-draft', 'data-draft': dr.id },
      el('p', { class: 'sess-draft-text', text: dr.text }),
      el('p', { class: 'sess-draft-words', role: 'status', text: dr.words }),
      el('div', { class: 'confirm-row' }, dr.controls.map((c) => c === 'send-again'
        ? el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Send again', 'data-send-again': dr.id, onclick: () => input$.tracker.retry(dr.id) })
        : c === 'copy'
          ? el('button', { class: 'btn-quiet', type: 'button', text: 'Copy', 'data-copy': dr.id, onclick: () => { try { navigator.clipboard.writeText(dr.text); } catch { /* the text stays on screen */ } } })
          : el('button', { class: 'btn-quiet', type: 'button', text: 'Discard', 'data-discard': dr.id, onclick: () => input$.tracker.discard(dr.id) }))))));
  };

  // Keys: the ordinary ones, then Stop separated, red, and asked once.
  const keyRow = el('div', { class: 'keys-row' }, KEYS.map((k) => el('button', { class: 'chip key-chip', type: 'button', text: k.label, 'aria-label': k.aria || null, 'data-key': k.key, onclick: () => sendKey(k.key) })));
  const stopBox = el('div', { class: 'keys-stop' });
  const stopBtn = el('button', { class: 'btn-danger', type: 'button', text: STOP_KEY.label, 'data-stop': '1' });
  stopBtn.addEventListener('click', () => {
    const go = el('button', { class: 'btn-danger', type: 'button', text: 'Interrupt', 'data-stop-confirm': '1', onclick: () => { sendKey(STOP_KEY.key); setKids(stopBox, stopBtn); } });
    const back = el('button', { class: 'btn-quiet', type: 'button', text: 'Keep going', onclick: () => setKids(stopBox, stopBtn) });
    setKids(stopBox, el('div', { class: 'confirm' }, el('p', { class: 'confirm-text', text: STOP_KEY.confirm }), el('div', { class: 'confirm-row' }, back, go)));
  });
  stopBox.append(stopBtn);
  tray.append(keyRow, stopBox);
  keysBtn.addEventListener('click', () => { tray.hidden = !tray.hidden; keysBtn.setAttribute('aria-expanded', tray.hidden ? 'false' : 'true'); });

  const sendText = async () => {
    let text = input.value;
    if (!text.trim() && !files.length) return;
    if (!st.wsUp) { setStatus('Not sent: live updates are paused. Your text is still here.'); return; }
    if (files.length) {
      sendBtn.disabled = true; setStatus(`Attaching ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
      const paths = [];
      for (const f of files) {
        const r = await send('POST', `/sessions/${encodeURIComponent(view.s.tmuxSession)}/attachments`, { filename: f.name, dataBase64: await toBase64(f.file) });
        if (!r.ok || !r.data.path) { sendBtn.disabled = false; setStatus(`Not sent: ${f.name} could not be attached (${r.data.error || `status ${r.status}`}). Your message is still here.`); return; }
        paths.push(r.data.path);
      }
      sendBtn.disabled = false; setStatus('');
      text = attachmentMessage(text, paths);
    }
    const r = input$.tracker.sendText(text);
    if (!r.ok) {
      // Nothing was sent. Uploaded attachments are already named in the text, so they leave the tray.
      if (files.length) { input.value = text; input.rows = composerRows(text); files.length = 0; paintChips(); }
      setStatus(r.words); return;
    }
    files.length = 0; paintChips();
    // The text stays in the box, marked as sending, until its own answer arrives.
    if (r.unresolved) { input.value = ''; input.rows = 1; }
    view.paintInput();
    input.focus();
  };
  input.addEventListener('paste', (e) => {
    const pasted = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (pasted.length) { e.preventDefault(); addFiles(pasted); }
  });
  const composer = el('div', { class: 'sess-composer' }, attachBtn, filePick, input, el('div', { class: 'sess-composer-btns' }, keysBtn, sendBtn));
  for (const t of [composer, termBox]) {
    t.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); composer.classList.add('dropping'); } });
    t.addEventListener('dragleave', () => composer.classList.remove('dropping'));
    t.addEventListener('drop', (e) => { if (!e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); composer.classList.remove('dropping'); addFiles([...e.dataTransfer.files]); });
  }
  sendBtn.addEventListener('click', sendText);
  input.addEventListener('input', () => { input.rows = composerRows(input.value); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendText(); } });
  more.addEventListener('click', () => moreSheet(view));
  resume.addEventListener('click', () => backToLive());
  const showTab = (which) => {
    const hist = which === 'history';
    liveTab.setAttribute('aria-pressed', hist ? 'false' : 'true'); historyTab.setAttribute('aria-pressed', hist ? 'true' : 'false');
    termBox.hidden = hist; historyBox.hidden = !hist; if (hist) resume.hidden = true;
    if (hist && !view.history) openHistory(view);
    if (!hist && view.fit) requestAnimationFrame(() => { try { view.fit.fit(); } catch { /* not visible yet */ } });
  };
  liveTab.addEventListener('click', () => showTab('live'));
  historyTab.addEventListener('click', () => showTab('history'));

  setKids(box, el('div', { class: 'sess-open', 'data-open': row.key },
    el('div', { class: 'sess-bar' },
      el('a', { class: 'chip icon-btn sess-back', href: listHref, 'aria-label': 'All sessions', text: '‹' }),
      el('div', { class: 'sess-titles' }, el('h1', { class: 'sess-title', text: row.title }), titleSub),
      more),
    tabs,
    statusLine,
    el('div', { class: 'sess-term-wrap' }, termBox, historyBox, resume),
    chips,
    draftsBox,
    composer,
    tray));

  if (s.remote) setStatus(`Streaming from ${s.machineNickname}…`);
  view.paintInput();
  startTerminal(view);
}

async function startTerminal(view) {
  const ok = await loadTerminalLib();
  if (st.view !== view) return;
  if (ok) {
    const term = new window.Terminal({
      theme: { background: '#0a0e17', foreground: '#d6dbe4', cursor: '#2dd4bf', selectionBackground: '#264f78' },
      fontSize: window.innerWidth <= 480 ? 10 : window.innerWidth <= 768 ? 11 : 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
      cursorBlink: false, cursorStyle: 'underline', scrollback: 50_000, convertEol: true,
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(view.termBox);
    view.term = term; view.fit = fit;
    const refit = () => { try { fit.fit(); } catch { /* not visible yet */ } };
    if (typeof ResizeObserver !== 'undefined') { view.ro = new ResizeObserver(refit); view.ro.observe(view.termBox); }
    requestAnimationFrame(refit);
    term.onScroll(() => {
      const b = term.buffer.active;
      const atBottom = b.baseY === 0 || (b.baseY - b.viewportY) <= 3;
      if (atBottom && !view.following) backToLive();
      else if (!atBottom && view.following) { view.following = false; view.resume.hidden = false; }
      if (b.viewportY <= 10) moreHistory(view);
    });
  } else {
    // The terminal library could not load: plain text, said honestly.
    view.pre = el('pre', { class: 'sess-pre' });
    view.termBox.append(view.pre);
    view.termBox.classList.add('plain');
    setStatus('The live terminal view could not load; showing plain text.');
    view.pre.addEventListener('scroll', () => {
      const atBottom = view.pre.scrollHeight - view.pre.scrollTop - view.pre.clientHeight < 24;
      if (atBottom && !view.following) backToLive(); else if (!atBottom && view.following) { view.following = false; view.resume.hidden = false; }
    });
  }
  if (st.wsUp) wsSend(frame('subscribe', view.s)); else setStatus('Live output paused, reconnecting.');
}

function writeOutput(data) {
  const v = st.view;
  if (!v.following) { v.pending = data; v.resume.hidden = false; return; }
  v.resume.hidden = true;
  if (v.term) { v.term.clear(); v.term.write(data); v.term.scrollToBottom(); }
  else if (v.pre) { v.pre.textContent = stripAnsi(data); v.pre.scrollTop = v.pre.scrollHeight; }
  if (v.statusLine.textContent.startsWith('Streaming from')) setStatus('');
}

function backToLive() {
  const v = st.view;
  v.following = true; v.resume.hidden = true;
  const data = v.pending; v.pending = null;
  if (v.term) { if (data != null) { v.term.clear(); v.term.write(data, () => v.term.scrollToBottom()); } else v.term.scrollToBottom(); }
  else if (v.pre) { if (data != null) v.pre.textContent = stripAnsi(data); v.pre.scrollTop = v.pre.scrollHeight; }
}

function moreHistory(v) {
  if (v.loading || v.exhausted) return;
  const next = nextHistoryBatch(v.loaded);
  if (!next) { v.exhausted = true; return; }
  v.loading = true;
  setStatus('Loading earlier output…');
  wsSend(frame('history', v.s, { lines: next }));
}

function writeHistory(msg) {
  const v = st.view;
  const prev = v.loaded;
  v.loaded = msg.lines || prev;
  const lines = String(msg.data || '').split('\n').length;
  if (lines <= prev + 10) v.exhausted = true;
  v.loading = false;
  setStatus('');
  if (!v.term) return;
  const y = v.term.buffer.active.viewportY;
  v.term.clear();
  v.term.write(msg.data || '');
  requestAnimationFrame(() => v.term.scrollToLine(Math.min(y + Math.max(0, lines - prev), v.term.buffer.active.baseY)));
}

function sendKey(key) {
  if (!st.view) return;
  if (!st.wsUp) { setStatus('Not sent: live updates are paused.'); return; }
  const r = inputFor(st.view.key, st.view.s).tracker.sendKey(key);
  if (!r.ok) setStatus(r.words);
}

// ── History: the conversation record, newest at the bottom, older on scroll-up ──
async function openHistory(view) {
  view.history = { before: null, done: false, loading: false, count: 0, phase: 'session', oldestMs: null, topicBefore: null };
  view.historyBox.addEventListener('scroll', () => { if (view.historyBox.scrollTop < 200) loadHistory(view); });
  await loadHistory(view);
}

function historyRow(e) {
  const text = historyText(e);
  if (!text) return null;
  const when = e.at ? new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  return e.role === 'tool'
    ? el('p', { class: 'sess-h sess-h-tool', text: `→ ${text}` })
    : el('div', { class: `sess-h sess-h-${e.role}` }, el('div', { class: 'sess-h-who', text: [e.role === 'user' ? 'Message in' : 'Session', when].filter(Boolean).join(' · ') }), el('div', { class: 'sess-h-text', text }));
}

async function loadHistory(view) {
  const h = view.history;
  if (!h || h.loading || h.done || st.view !== view) return;
  h.loading = true;
  const box = view.historyBox;
  const marker = el('p', { class: 'sess-history-note', text: h.count ? 'Loading earlier messages…' : 'Loading the conversation…' });
  box.prepend(marker);
  const topicPhase = h.phase === 'topic';
  const res = await send('GET', topicPhase ? topicHistoryUrl(topicOf(view.s), h.topicBefore) : historyUrl(view.s, h.before));
  marker.remove();
  h.loading = false;
  if (st.view !== view) return;
  const list = topicPhase ? res.data && res.data.messages : res.data && res.data.entries;
  if (!res.ok || !Array.isArray(list)) {
    h.done = true;
    box.prepend(el('p', { class: 'sess-history-note', text: topicPhase ? `Can’t load earlier messages: ${res.reason || 'the server did not answer'}.` : historyErrorWords(res) }));
    return;
  }
  const first = !h.count;
  const prevHeight = box.scrollHeight, prevTop = box.scrollTop;
  const frag = document.createDocumentFragment();
  // A server without scroll-back support ignores `before` and returns the newest
  // messages: keep only what is strictly older than the cursor, so nothing repeats.
  const entries = topicPhase
    ? list.map(topicHistoryEntry).filter((e) => e && e.atMs != null && e.atMs < h.topicBefore)
    : list;
  for (const e of entries) {
    const row = historyRow(e);
    if (row) frag.append(row);
    const ms = e.atMs ?? (e.at ? Date.parse(e.at) : NaN);
    if (Number.isFinite(ms)) h.oldestMs = h.oldestMs == null ? ms : Math.min(h.oldestMs, ms);
  }
  h.count += entries.length;
  if (topicPhase) {
    h.topicCount += entries.length;
    // Nothing earlier after all: the divider would introduce an empty section.
    if (!h.topicCount && h.divider) { h.divider.remove(); h.divider = null; }
    h.topicBefore = h.oldestMs;
    if (list.length < TOPIC_HISTORY_PAGE || entries.length === 0 || h.topicBefore == null) { h.done = true; frag.prepend(el('p', { class: 'sess-history-note', text: 'The start of this conversation.' })); }
  } else {
    h.before = res.data.nextBefore;
    if (h.before == null) {
      // This session's own record ends here. A conversation keeps going back
      // through its earlier sessions: continue with the topic's messages.
      if (topicOf(view.s)) {
        h.phase = 'topic';
        h.topicBefore = h.oldestMs ?? Date.now();
        h.divider = el('p', { class: 'sess-history-note', text: 'Earlier, from this conversation’s previous sessions:' });
        h.topicCount = 0;
        frag.prepend(h.divider);
      } else {
        h.done = true;
        frag.prepend(el('p', { class: 'sess-history-note', text: h.count ? 'The start of this conversation.' : 'Nothing has been said in this session yet.' }));
      }
    }
  }
  box.prepend(frag);
  if (first) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  // A short page may not fill the box: keep loading until it scrolls.
  if (!h.done && box.scrollHeight <= box.clientHeight + 200) loadHistory(view);
}

function leaveView() {
  const v = st.view;
  if (!v) return;
  wsSend(frame('unsubscribe', v.s));
  if (v.ro) v.ro.disconnect();
  if (v.term) { try { v.term.dispose(); } catch { /* already gone */ } }
  st.view = null;
}

// ── "⋯": door switch, paste, details, close ───────────────────────────────
function moreSheet(view) {
  const s = view.s;
  const blocks = [story([
    { label: 'Machine', text: s.machineNickname || 'This machine' },
    { label: 'Model', text: modelWords(s.model) || 'not recorded' },
    { label: 'Kind', text: s.type === 'job' ? 'a scheduled job' : 'a conversation' },
    { label: 'Chat', text: String(s.conversationRef || '').startsWith('app:') ? 'an Instar app conversation' : s.platform === 'telegram' ? 'a Telegram topic' : s.platform === 'slack' ? 'Slack' : s.platform === 'whatsapp' ? 'WhatsApp' : 'none (terminal only)' },
  ])];
  const actions = el('div', { class: 'sheet-actions sess-actions' });
  if (canSwitchDoor(s)) actions.append(el('button', { class: 'btn-primary btn-inline', type: 'button', text: `Switch ${DOOR.word} and model`, 'data-door': '1', onclick: () => doorSheet(view) }));
  blocks.push(actions, closeBlock(view));
  const t = s.telemetry || {};
  blocks.push(details({
    tmuxSession: s.tmuxSession, id: s.id, machineId: s.machineId, model: s.model, startedAt: s.startedAt,
    toolsUsed: Array.isArray(t.toolsUsed) && t.toolsUsed.length ? t.toolsUsed.join(', ') : null,
    backgroundTasks: Array.isArray(t.subagentsSpawned) ? t.subagentsSpawned.length : null,
    eventCount: t.eventCount ?? null, lastActivity: t.lastActivity || null,
  }, ['tmuxSession', 'id', 'machineId', 'model', 'startedAt', 'lastActivity', 'toolsUsed', 'backgroundTasks', 'eventCount']));
  sheet({ title: view.titleSub.closest('.sess-open').querySelector('.sess-title').textContent }, ...blocks);
}

function closeBlock(view) {
  const box = el('div', { class: 'sheet-danger' });
  const open = el('button', { class: 'btn-quiet', type: 'button', text: 'Close session', 'data-close': '1' });
  open.addEventListener('click', () => {
    const s = view.s;
    const title = view.titleSub.closest('.sess-open').querySelector('.sess-title').textContent;
    const status = el('p', { class: 'action-status', role: 'status' });
    const go = el('button', { class: 'btn-danger', type: 'button', text: 'Close it', 'data-close-confirm': '1' });
    const back = el('button', { class: 'btn-quiet', type: 'button', text: 'Keep it', onclick: () => setKids(box, open) });
    go.addEventListener('click', async () => {
      go.disabled = true; status.textContent = 'Closing…';
      const req = closeRequest(s);
      const x = await send(req.method, req.path, req.body);
      const w = closeResultWords(s, x.status, x.data);
      status.textContent = w.text;
      if (w.ok) setTimeout(() => { closeSheet(); if (st.view === view) location.hash = listHref; else if (st.ctx) renderSessions(st.main, st.ctx); }, 900);
      else if (w.unknown) setTimeout(() => { closeSheet(); renderSessions(st.main, st.ctx); }, 1500);
      else go.disabled = false;
    });
    setKids(box, el('div', { class: 'confirm' }, closeConfirmWords(s, title).map((t) => el('p', { class: 'confirm-text', text: t })), el('div', { class: 'confirm-row' }, back, go), status));
  });
  box.append(open);
  return box;
}

function fillSelect(sel, choices, value) {
  setKids(sel, choices.map((c) => el('option', { value: c.value, text: c.label, disabled: c.disabled || null })));
  const pick = choices.find((c) => c.value === value && !c.disabled) || choices.find((c) => !c.disabled);
  sel.value = pick ? pick.value : '';
}
function fillModels(sel, options, fw, selected) {
  const mc = modelChoices(options, fw, selected);
  fillSelect(sel, mc.choices, mc.value);
  sel.disabled = mc.disabled;
}
const field = (text, input, hint) => el('label', { class: 'limit-field' }, el('span', { text }), input, hint || null);
const WRITE = { 'X-Instar-Request': '1' };

async function doorSheet(view) {
  const s = view.s;
  const now = el('p', { class: 'card-line', text: `Reading this conversation’s ${DOOR.word}…` });
  const door = el('select', { class: 'reason-input', 'aria-label': DOOR.Word });
  const model = el('select', { class: 'reason-input', 'aria-label': 'Model' });
  const regime = el('p', { class: 'card-note', hidden: true });
  const status = el('p', { class: 'action-status', role: 'status' });
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Switch', 'data-switch': '1', disabled: true });
  sheet({ title: `${DOOR.Word} and model` }, now, field(DOOR.Word, door), field('Model', model), regime, go, status);
  const [opt, prof] = await Promise.all([st.ctx.get('/topic-profile/options'), st.ctx.get(`/topic-profile/${encodeURIComponent(profileKeyOf(s))}`)]);
  if (!opt.ok || !prof.ok) { now.textContent = `Can’t tell what it is on now: ${(!opt.ok ? opt : prof).reason}.`; return; }
  const options = opt.data; const p = prof.data;
  now.textContent = `Now: ${doorModelWords(options, p.resolved.framework, p.resolved.model)} (${profileSourceWords(p)}).`;
  fillSelect(door, doorChoices(options), p.resolved.framework);
  fillModels(model, options, door.value, p.resolved.model);
  door.addEventListener('change', () => fillModels(model, options, door.value, null));
  const rw = regimeWords(options); if (rw) { regime.textContent = rw; regime.hidden = false; }
  go.disabled = false;
  go.addEventListener('click', async () => {
    go.disabled = true; status.textContent = 'Working…';
    const pick = { framework: door.value, model: model.value || null };
    const x = await send('POST', `/topic-profile/${encodeURIComponent(profileKeyOf(s))}`, pick, WRITE);
    const d = x.data || {};
    status.textContent = d.message || d.error || (x.ok ? 'Done.' : 'Refused.');
    go.disabled = false;
    if (x.ok && !d.noop) watchSwitch({ topicId: profileKeyOf(s), model: pick.model, since: Date.now(), tmuxSession: s.tmuxSession, status });
  });
}

/** "switching…" until GET /sessions shows the LAUNCHED model, never an echo of the pick. */
async function watchSwitch(job) {
  st.switching.set(job.tmuxSession, 'switching…');
  paint();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const r = await st.ctx.get('/sessions');
    const arr = r.ok ? (Array.isArray(r.data) ? r.data : (r.data && r.data.sessions) || []) : [];
    const hit = switchLanded(arr, job);
    if (hit) {
      st.switching.delete(job.tmuxSession);
      if (job.status.isConnected) job.status.textContent = `Now on ${modelWords(hit.model) || 'the account default'}.`;
      if (st.main && st.ctx) renderSessions(st.main, st.ctx);
      return;
    }
  }
  st.switching.delete(job.tmuxSession);
  if (job.status.isConnected) job.status.textContent = 'The new model has not shown up yet. Check again in a minute.';
  paint();
}

// ── Session settings: the defaults new sessions start on ─────────────────
/**
 * The default door and model for new topics, in `box`. Used by the Session settings sheet and
 * inside New session. `base` is this machine's options; `onSaved` gets the fresh options.
 */
function defaultsForm(box, base, onSaved = () => {}) {
  const dDoor = el('select', { class: 'reason-input', 'aria-label': `Default ${DOOR.word}` });
  const dModel = el('select', { class: 'reason-input', 'aria-label': 'Default model' });
  const dStatus = el('p', { class: 'action-status', role: 'status' });
  const def = base.newTopicDefault || {};
  fillSelect(dDoor, doorChoices(base), def.framework || '');
  fillModels(dModel, base, dDoor.value, def.framework ? def.model : null);
  dDoor.addEventListener('change', () => fillModels(dModel, base, dDoor.value, null));
  const regime = regimeWords(base);
  const save = async (body) => {
    dStatus.textContent = 'Working…';
    const x = await send('POST', '/topic-profile/new-topic-default', body, WRITE);
    if (!x.ok) { dStatus.textContent = (x.data && x.data.error) || `Not saved: the server answered ${x.status || 'nothing'}.`; return; }
    const fresh = await st.ctx.get('/topic-profile/options');
    const after = fresh.ok ? fresh.data : base;
    if (fresh.ok) onSaved(after);
    dStatus.textContent = body.clear ? 'Cleared. Topics created here start on the agent defaults.' : `Saved: ${doorModelWords(after, body.framework, body.model)}.`;
  };
  setKids(box,
    // The two pickers show what is in force; one plain line says where it applies.
    el('p', { class: 'card-note', text: `For new sessions started from the dashboard or the app on ${(st.model && st.model.selfName) || 'this machine'}.` }),
    field(`Default ${DOOR.word}`, dDoor), field('Default model', dModel),
    regime ? el('p', { class: 'card-note', text: regime }) : null,
    el('div', { class: 'confirm-row' },
      el('button', { class: 'btn-quiet', type: 'button', text: 'Clear', 'data-default-clear': '1', onclick: () => save({ clear: true }) }),
      el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Save default', 'data-default-save': '1', onclick: () => { if (dDoor.value) save({ framework: dDoor.value, model: dModel.value || null }); } })),
    dStatus);
}

async function settingsSheet() {
  const box = el('div', { class: 'sess-settings' }, el('p', { class: 'card-line', text: 'Reading the defaults…' }));
  sheet({ title: 'Session settings' }, box);
  const opt = await st.ctx.get('/topic-profile/options');
  if (!opt.ok) {
    setKids(box, cantTell(`Can’t read the defaults: ${opt.reason}.`), el('button', { class: 'btn-quiet', type: 'button', text: 'Try again', onclick: () => { closeSheet(); settingsSheet(); } }));
    return;
  }
  defaultsForm(box, opt.data);
}

// ── New session ───────────────────────────────────────────────────────────
async function newSessionSheet() {
  const name = el('input', { class: 'reason-input', type: 'text', maxlength: '120', placeholder: 'Bug: login loop', 'aria-label': 'Name' });
  const platform = el('select', { class: 'reason-input', 'aria-label': 'Where to talk to it' }, PLATFORMS.map((p) => el('option', { value: p.value, text: p.label })));
  const door = el('select', { class: 'reason-input', 'aria-label': DOOR.Word });
  const model = el('select', { class: 'reason-input', 'aria-label': 'Model' });
  const machine = el('select', { class: 'reason-input', 'aria-label': 'Machine' });
  const doorHint = el('span', { class: 'card-note' });
  const machineField = field('Machine', machine);
  machineField.hidden = true;
  const regime = el('p', { class: 'card-note', hidden: true });
  const defLine = el('p', { class: 'card-note sess-default' });
  const defBox = el('div', { class: 'sess-default-box' });
  const status = el('p', { class: 'action-status', role: 'status' });
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Start session', 'data-create': '1' });
  let options = null; let localOptions = null; let machines = null;

  const sync = () => {
    const allow = platformAllowsDoor(platform.value) && options;
    door.disabled = !allow; model.disabled = !allow || !door.value;
    doorHint.textContent = !allow && options ? `${DOOR.Word} and model apply to a Telegram topic or an Instar app conversation.` : 'You can change this again later, from the session.';
    machineField.hidden = !(machines && platformAllowsMachine(platform.value));
    if (machineField.hidden && machine.value) { machine.value = ''; onMachine(); }
    defLine.textContent = defaultWords(options);
  };
  const fillDoors = () => {
    const def = options && options.newTopicDefault;
    fillSelect(door, doorChoices(options, { withAgentDefault: true }), def && def.framework ? def.framework : '');
    fillModels(model, options, door.value, def && def.framework ? def.model : null);
    const rw = regimeWords(options); regime.textContent = rw || ''; regime.hidden = !rw;
    sync();
  };
  const onMachine = async () => {
    const v = machine.value;
    status.textContent = '';
    if (v && machines && v !== machines.selfMachineId) {
      const r = await st.ctx.get(`/topic-profile/options?machine=${encodeURIComponent(v)}`);
      if (r.ok) options = r.data; else status.textContent = `Couldn’t read that machine’s ${DOOR.words} and models: ${r.reason}.`;
    } else options = localOptions;
    if (machine.value === v) fillDoors();
  };
  platform.addEventListener('change', sync);
  door.addEventListener('change', () => { fillModels(model, options, door.value, null); sync(); });
  machine.addEventListener('change', onMachine);

  const changeDefault = el('button', { class: 'link-btn', type: 'button', text: 'Change the default', 'data-default': '1' });
  changeDefault.addEventListener('click', () => {
    defaultsForm(defBox, localOptions || {}, (fresh) => {
      localOptions = fresh;
      if (!machine.value || (machines && machine.value === machines.selfMachineId)) options = localOptions;
      fillDoors();
    });
  });

  // One id per intended create: a retry after a timeout reuses it, so it never makes a second conversation.
  let requestId = newRequestId();
  go.addEventListener('click', async () => {
    const req = createBody({ name: name.value, platform: platform.value, framework: door.disabled ? '' : door.value, model: model.disabled ? '' : model.value, machine: machineField.hidden ? '' : machine.value, requestId }, options);
    if (!req.ok) { status.textContent = req.problems.join(' '); name.focus(); return; }
    go.disabled = true; status.textContent = 'Starting…';
    const x = await send('POST', '/sessions/create', req.body, WRITE);
    // A definite answer ends this create; a timeout or a server fault keeps the id for the retry.
    if (x.status >= 200 && x.status < 500) requestId = newRequestId();
    const w = createResultWords(x.status, x.data, req.body.name);
    status.textContent = w.text;
    go.disabled = false;
    if (w.ok) { setTimeout(() => { closeSheet(); renderSessions(st.main, st.ctx); }, w.warn ? 2500 : 1200); }
  });

  sheet({ title: 'New session' }, field('Name', name), field('Where to talk to it', platform), field(DOOR.Word, door, doorHint), field('Model', model), regime, machineField,
    el('div', { class: 'sess-default-row' }, defLine, changeDefault), defBox, go, status);
  setTimeout(() => name.focus(), 50);
  const [optRes, poolRes] = await Promise.all([st.ctx.get('/topic-profile/options'), st.ctx.get('/pool')]);
  localOptions = optRes.ok ? optRes.data : null; options = localOptions;
  if (!optRes.ok) doorHint.textContent = `Can’t list ${DOOR.words}: ${optRes.reason}. The session starts on the agent default.`;
  machines = machineChoices(poolRes);
  if (machines) fillSelect(machine, machines.choices, '');
  fillDoors();
  if (!optRes.ok) doorHint.textContent = `Can’t list ${DOOR.words}: ${optRes.reason}. The session starts on the agent default.`;
}
