// The project app wrapper (docs/specs/project-apps-sandbox.md §3.6-3.7). Instar code: it draws the
// fixed bar, loads the sealed frame with a single-use ticket, and holds the app's narrow key, which
// it renews on its OWN timer for the version it loaded, never because the frame asked.
import { backoffDelay, renewDelay, acceptMessage, classifyKeyAnswer, safeConversationHref } from './wrapper-model.js';

const $ = (id) => document.getElementById(id);
const frame = $('app-frame');
const appId = new URLSearchParams(location.search).get('app') || '';
const KEY_MESSAGE = 'instar-project-app-key';

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

async function post(path, body) {
  try {
    const r = await fetch(path, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    let json = null;
    try { json = await r.json(); } catch { json = null; }
    return { status: r.status, body: json };
  } catch {
    return { status: 0, body: null };
  }
}

const state = {
  meta: null,
  loadedSha: null,   // the version this frame load runs; renewal is bound to it
  key: null,
  exp: 0,
  readySeen: false,  // the key is handed once per frame load, after the frame's ready
  failures: 0,
  timer: null,
  stopped: false,
  loading: false,
};

function setStatus(text) { $('bar-status').textContent = text || ''; }
function note(text) {
  const n = $('stage-note');
  n.textContent = text; n.hidden = !text;
  frame.hidden = !!text;
}
function clearTimer() { if (state.timer) { clearTimeout(state.timer); state.timer = null; } }
function schedule(ms, fn) { clearTimer(); if (!document.hidden && !state.stopped) state.timer = setTimeout(fn, ms); }

function drawBar(meta) {
  $('bar-title').textContent = meta?.title || 'Project app';
  $('bar-made').textContent = meta?.project ? `made by your agent for ${meta.project}` : 'made by your agent';
  document.title = meta?.title ? `${meta.title} · Instar` : 'Project app';
  $('btn-conversation').disabled = !safeConversationHref(meta?.conversationHref);
}

function stop(text) {
  state.stopped = true; clearTimer();
  state.key = null; state.loadedSha = null;
  frame.removeAttribute('src');
  setStatus('');
  note(text);
}

function handKey() {
  if (!state.key || !state.readySeen || !frame.contentWindow) return;
  // The frame's origin is opaque, so '*' is the only target that reaches it (accepted on purpose).
  frame.contentWindow.postMessage({ type: KEY_MESSAGE, key: state.key, exp: state.exp }, '*');
}

/** Load (or reload) the frame: a fresh ticket, a key for that exact version, then the frame. */
async function load() {
  if (state.loading) return;
  state.loading = true; clearTimer();
  try {
    if (!/^pa_[0-9a-f]{16}$/.test(appId)) { stop('There is no such app.'); return; }
    const t = await post(`/project-apps/${appId}/ticket`, {});
    if (t.body?.meta) { state.meta = t.body.meta; drawBar(state.meta); }
    if (t.status === 401 || t.status === 403) { stop('Unlock the dashboard first, then open this app again from your project.'); return; }
    if (t.status === 409 && t.body?.error === 'not-served') {
      stop(t.body.state === 'disabled' ? 'This app is switched off.' : t.body.state === 'copying' ? 'The approved version of this app is still copying to this machine. Try again in a minute.' : 'This app has no approved version yet. Approve it on your phone first.');
      return;
    }
    if (t.status === 404) { stop('There is no such app.'); return; }
    if (t.status !== 200 || !t.body?.frameUrl) { failed(); return; }
    const k = await post(`/project-apps/${appId}/key`, { contentSha: t.body.contentSha });
    const verdict = classifyKeyAnswer(k.status, k.body);
    if (verdict === 'reload') { state.loading = false; schedule(0, load); return; }
    if (verdict === 'stopped') { stop('This app has nothing to run right now.'); return; }
    if (verdict !== 'ok') { failed(); return; }
    state.loadedSha = t.body.contentSha;
    state.key = k.body.key; state.exp = k.body.exp;
    state.readySeen = false; state.failures = 0; state.stopped = false;
    setStatus(''); note('');
    frame.src = t.body.frameUrl;
    schedule(renewDelay(state.exp, Date.now()), renew);
  } finally {
    state.loading = false;
  }
}

function failed() {
  state.failures += 1;
  setStatus('Reconnecting…');
  schedule(backoffDelay(state.failures), state.loadedSha ? renew : load);
}

/** Renew on the wrapper's own timer, only for the loaded version, only while visible. */
async function renew() {
  state.timer = null;
  if (document.hidden || state.stopped) return;
  if (!state.loadedSha) { load(); return; }
  const k = await post(`/project-apps/${appId}/key`, { contentSha: state.loadedSha });
  const verdict = classifyKeyAnswer(k.status, k.body);
  if (verdict === 'ok') {
    state.key = k.body.key; state.exp = k.body.exp; state.failures = 0;
    setStatus('');
    handKey();
    schedule(renewDelay(state.exp, Date.now()), renew);
    return;
  }
  if (verdict === 'reload') { state.key = null; load(); return; }
  if (verdict === 'stopped') { stop('This app has nothing to run right now.'); return; }
  failed();
}

window.addEventListener('message', (event) => {
  const type = acceptMessage(event, frame.contentWindow);
  if (!type) return;
  if (type === 'ready') {
    if (state.readySeen) return;
    state.readySeen = true;
    handKey();
  } else if (type === 'open-conversation') {
    const href = safeConversationHref(state.meta?.conversationHref);
    if (href) location.href = href;
  } else if (type === 'summary-changed') {
    // The project's Work row reads the summary from the server; nothing is taken from the frame.
    try { new BroadcastChannel('instar-project-apps').postMessage({ type: 'summary-changed', appId }); } catch { /* not available */ }
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimer(); return; }
  if (state.stopped || state.timer) return;
  if (!state.loadedSha) { load(); return; }
  // Back on screen: renew now if the key is near its end or renewal was failing, else on schedule.
  const due = state.failures > 0 ? 0 : renewDelay(state.exp, Date.now());
  schedule(due, renew);
});

$('btn-close').addEventListener('click', () => {
  // Not history.back(): frame reloads add history entries, so back could land on the app again.
  location.href = '/dashboard/console/#/work';
});
$('btn-conversation').addEventListener('click', () => {
  const href = safeConversationHref(state.meta?.conversationHref);
  if (href) location.href = href;
});

load();
