// Instar Documents — the document page (spec §3.6, §3.8; app contract items 2 and 7).
//
// Served at /docs/<id> under a strict CSP (script-src 'self', require-trusted-types-for 'script'):
// every node is built with createElement + textContent. Nothing from a document, a comment or a
// name is ever parsed as markup, and links survive only as http, https or mailto.
//
// ── Page ↔ app bridge (inside the Instar iPhone app's WKWebView) ─────────────────────────────────
// Detected by `window.webkit.messageHandlers.instarDocs`. In the app the composer and Send are
// NATIVE: the page never shows its own comment box or Send bar, and never signs anything.
//
// Page → app, via window.webkit.messageHandlers.instarDocs.postMessage(message):
//   {type:'ready', docId, title, openComments}       after the first render
//   {type:'selection', docId, start, end}             a text selection (debounced), projection
//                                                     offsets in the LATEST version; the app shows
//                                                     its own sheet and cuts the quote itself
//   {type:'write', id, op, docId, fields, text?}      a thread action: op ∈ reply | resolve |
//                                                     reopen | edit; `fields` are the signed
//                                                     payload's fields WITHOUT hashes
//                                                     (reply {docId, commentKey, replyId};
//                                                     resolve|reopen|edit {docId, commentKey});
//                                                     `text` (plain) for reply and edit; the app
//                                                     makes the salted blob, signs under
//                                                     instar-docpage-v1 and POSTs /docs/<id>/w/<op>.
//                                                     `id` is a uuid the page matches the result by;
//                                                     a retry of the same draft reuses replyId.
//   {type:'expired'}                                  the read cookie is gone (a 401): the app
//                                                     re-mints a code and reloads url#code=…
//
// App → page, via window.dispatchEvent(new CustomEvent('instar-docs', {detail})):
//   {type:'write-result', id, status, body}           the answer to a `write` (HTTP status + JSON)
//   {type:'refresh'}                                  re-fetch page data (after a native comment or Send)
//   {type:'focus-comment', commentKey}                open / scroll to that thread
//
// Opening: the app loads url#code=<code>[&comment=<commentKey>]; the page trades the code for its
// read cookie and removes the fragment. A computer browser signs an `open` with its browser device
// key (dashboard/console/browser-device.js, IndexedDB 'instar-console') instead.

import * as M from './doc-page-model.js';

const DOC_ID = M.docIdFromPath(location.pathname);
const bridge = (() => {
  try { return (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.instarDocs) || null; } catch { return null; }
})();
const IN_APP = Boolean(bridge);
const main = document.getElementById('doc');
const textStart = new WeakMap(); // text node → projection offset of its first character

const state = {
  page: null,
  versionId: null,
  projection: '',
  textNodes: [],
  device: null, // { bd, rec, privateKey, clock }
  focusKey: null,
  selection: null,
  lastPostedSelection: '',
  pendingBridge: new Map(),
  pendingBatch: null,
  readySent: false,
  reopenTried: false,
  sheet: null,
  compareOpen: false,
};

// ── small DOM helpers (text only) ──────────────────────────────────────────────────────────────

function el(tag, opts = {}, children = []) {
  const n = document.createElement(tag);
  if (opts.cls) n.className = opts.cls;
  if (opts.text !== undefined && opts.text !== null) n.textContent = String(opts.text);
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v));
  if (opts.on) for (const [k, f] of Object.entries(opts.on)) n.addEventListener(k, f);
  for (const c of children) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}
const button = (text, onClick, cls = 'btn', attrs = {}) => el('button', { cls, text, attrs: { type: 'button', ...attrs }, on: { click: onClick } });
const isWide = () => window.matchMedia('(min-width: 900px)').matches;
const randomUuid = () => crypto.randomUUID();
const newSalt = () => M.saltHex(crypto.getRandomValues(new Uint8Array(16)));

function storageGet(k) { try { return window.localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { window.localStorage.setItem(k, v); } catch { /* storage unavailable: drafts are a convenience */ } }
function storageDel(k) { try { window.localStorage.removeItem(k); } catch { /* storage unavailable */ } }

function loadDraft(key) {
  const d = M.parseDraft(storageGet(key));
  return d || { text: '', id: randomUuid(), salt: newSalt() };
}
function saveDraft(key, d) { storageSet(key, JSON.stringify(d)); }

function showMessage(words, { tone = 'info' } = {}) {
  main.replaceChildren(el('div', { cls: `page-message ${tone}`, attrs: { role: tone === 'bad' ? 'alert' : 'status' } }, [el('p', { text: words })]));
}

let noticeTimer = 0;
function notice(words, tone = 'bad') {
  const n = document.getElementById('doc-notice');
  if (!n) { showMessage(words, { tone }); return; }
  n.className = `notice ${tone}`;
  n.textContent = words;
  n.hidden = false;
  clearTimeout(noticeTimer);
  if (tone !== 'bad') noticeTimer = setTimeout(() => { n.hidden = true; }, 6000);
}

const errCtx = () => ({ inApp: IN_APP, agentName: state.page ? state.page.agentName : null, conversation: state.page && state.page.primary ? state.page.primary.name : null });

// ── network ────────────────────────────────────────────────────────────────────────────────────

async function fetchJson(path, init = {}) {
  const sentAt = Date.now();
  let r;
  try { r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init }); } catch { return { ok: false, status: 0, data: null }; }
  const receivedAt = Date.now();
  if (state.device) state.device.clock.observeDateHeader(r.headers.get('Date'), sentAt, receivedAt);
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

/** The read cookie expired or is missing. */
async function expired() {
  if (IN_APP) {
    showMessage('Opening the document again…');
    try { bridge.postMessage({ type: 'expired' }); } catch { showMessage('This page timed out. Open the document again from the app.', { tone: 'bad' }); }
    return false;
  }
  if (!state.reopenTried) {
    state.reopenTried = true;
    if (await browserOpen()) return true;
    return false;
  }
  showMessage('This page timed out. Reload it to continue.', { tone: 'bad' });
  return false;
}

// ── the computer browser's device key ──────────────────────────────────────────────────────────

async function loadDevice() {
  if (state.device) return state.device;
  try {
    const bd = await import('/dashboard/console/browser-device.js');
    const recs = await bd.readAllRecords();
    const host = location.host.toLowerCase();
    const rec = (recs || []).find((r) => r && r.deviceId && String(r.host || '').toLowerCase() === host && r.status === 'active');
    const privateKey = rec ? ((rec.keyPair && rec.keyPair.privateKey) || rec.privateKey || null) : null;
    if (!rec || !privateKey) return null;
    state.device = { bd, rec, privateKey, clock: bd.createClock() };
    return state.device;
  } catch {
    return null; // no IndexedDB, not a secure context, or the console module is unavailable
  }
}

/** The instar-docpage-v1 headers for one signed operation. */
async function docpageHeaders(op, payload) {
  const { bd, rec, privateKey, clock } = state.device;
  const requestId = bd.newRequestId(clock.now());
  const timeMs = String(Math.floor(clock.now()));
  const message = await M.docpageString({ deviceId: rec.deviceId, host: location.host, docId: DOC_ID, op, requestId, timeMs }, payload, bd.sha256Hex);
  return {
    'X-Instar-Device': rec.deviceId,
    'X-Instar-Device-Time': timeMs,
    'X-Instar-Docpage-Sig': await bd.signText(privateKey, message),
    'X-Instar-Docpage-Payload': bd.b64url(new TextEncoder().encode(M.canonicalJson(payload))),
    'X-Instar-Request-Id': requestId,
  };
}

/** Signs an `open` for this document and trades it for the read cookie. */
async function browserOpen() {
  const dev = await loadDevice();
  if (!dev) { showLinkComputer(); return false; }
  let headers;
  try { headers = await docpageHeaders('open', M.buildPayload('open', { docId: DOC_ID })); } catch { showMessage('This browser could not sign in to the document.', { tone: 'bad' }); return false; }
  const r = await fetchJson(`/docs/${DOC_ID}/session`, { method: 'POST', headers: { ...headers, 'X-Instar-Request': '1', 'Content-Type': 'application/json' }, body: '{}' });
  if (r.ok) return true;
  if (r.status === 401) { showLinkComputer(); return false; }
  showMessage(M.errorWords(r.status, r.data, errCtx()), { tone: 'bad' });
  return false;
}

/** This computer has no linked browser key for this address: it can't open the document. */
export function showLinkComputer() {
  main.replaceChildren(el('div', { cls: 'page-message link-computer', attrs: { role: 'status' } }, [
    el('p', { text: 'To comment from this computer, link it to your phone: open the Instar app, then People → Link a computer.' }),
  ]));
}

/** A signed page write from this computer. → {ok, status, data} */
async function writeSigned(op, fields, text, salt) {
  if (!state.device) return { ok: false, status: 403, data: { error: 'not-allowed' } };
  const f = { ...fields, docId: DOC_ID };
  let body = '{}';
  if (text !== undefined) {
    const s = salt || newSalt();
    f.bodyHash = await state.device.bd.sha256Hex(M.blobHashInput(s, text));
    body = JSON.stringify({ blobs: [{ salt: s, text }] });
  }
  let headers;
  try { headers = await docpageHeaders(op, M.buildPayload(op, f)); } catch { return { ok: false, status: 0, data: null }; }
  return fetchJson(`/docs/${DOC_ID}/w/${op}`, { method: 'POST', headers: { ...headers, 'X-Instar-Request': '1', 'Content-Type': 'application/json' }, body });
}

/** A thread action through the app (in-app) — resolves with the app's write-result. */
function writeBridge(op, fields, text) {
  const id = randomUuid();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { state.pendingBridge.delete(id); resolve({ ok: false, status: 0, data: null }); }, 60_000);
    state.pendingBridge.set(id, (res) => { clearTimeout(timer); resolve(res); });
    const msg = { type: 'write', id, op, docId: DOC_ID, fields: M.bridgeFields(op, { ...fields, docId: DOC_ID }) };
    if (text !== undefined) msg.text = text;
    try { bridge.postMessage(msg); } catch { clearTimeout(timer); state.pendingBridge.delete(id); resolve({ ok: false, status: 0, data: null }); }
  });
}

const canWrite = () => IN_APP || Boolean(state.device);
function threadWrite(op, fields, text, salt) {
  return IN_APP ? writeBridge(op, fields, text) : writeSigned(op, fields, text, salt);
}

// ── boot ───────────────────────────────────────────────────────────────────────────────────────

async function boot() {
  if (!main) return;
  if (!M.isUuid4(DOC_ID) && !/^[0-9a-f-]{36}$/.test(DOC_ID)) { showMessage('This isn\'t a document address.', { tone: 'bad' }); return; }
  const frag = M.parseFragment(location.hash);
  state.focusKey = frag.comment;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  if (!IN_APP) await loadDevice();
  if (frag.code) {
    const r = await fetchJson(`/docs/${DOC_ID}/session`, { method: 'POST', headers: { 'X-Instar-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: frag.code }) });
    if (!r.ok) {
      if (r.status === 401) { await expired(); if (IN_APP) return; } else { showMessage(M.errorWords(r.status, r.data, errCtx()), { tone: 'bad' }); return; }
    }
  }
  installGlobalHandlers();
  await load(null);
}

async function load(versionId) {
  const q = versionId ? `?version=${encodeURIComponent(versionId)}` : '';
  let r = await fetchJson(`/docs/${DOC_ID}/page-data${q}`);
  if (r.status === 401) {
    if (!(await expired())) return;
    r = await fetchJson(`/docs/${DOC_ID}/page-data${q}`);
    if (r.status === 401) { if (IN_APP) { await expired(); return; } showMessage('This page timed out. Reload it to continue.', { tone: 'bad' }); return; }
  }
  if (!r.ok || !r.data) { if (state.page) notice(M.errorWords(r.status, r.data, errCtx())); else showMessage(M.errorWords(r.status, r.data, errCtx()), { tone: 'bad' }); return; }
  state.reopenTried = false;
  state.page = r.data;
  state.versionId = r.data.version ? r.data.version.id : null;
  render();
  if (IN_APP && !state.readySent) {
    state.readySent = true;
    try { bridge.postMessage({ type: 'ready', docId: DOC_ID, title: r.data.title, openComments: M.openCount(r.data) }); } catch { /* the app reads the page anyway */ }
  }
  if (state.focusKey) { const k = state.focusKey; state.focusKey = null; focusThread(k); }
}

// ── render ─────────────────────────────────────────────────────────────────────────────────────

function render() {
  const page = state.page;
  closeSheet(false);
  hidePill();
  document.title = page.title || 'Document';
  state.projection = M.projectionOf(page.blocks || []);
  state.textNodes = [];

  const article = el('article', { cls: 'doc-body', attrs: { id: 'doc-body', 'aria-label': 'Document text' } });
  renderBlocks(article, page);
  const threads = el('aside', { cls: 'threads', attrs: { id: 'doc-threads', 'aria-label': 'Comments' } });
  renderThreads(threads, page);

  const children = [
    renderHeader(page),
    el('p', { cls: 'notice', attrs: { id: 'doc-notice', role: 'status', 'aria-live': 'polite', hidden: true } }),
  ];
  if (state.compareOpen) children.push(renderCompare(page));
  if (page.version && !page.version.latest) {
    children.push(el('p', { cls: 'note older' }, [
      'You\'re reading an older version. Comments are placed on the newest one. ',
      button('Go to the newest version', () => load(null), 'link-btn'),
    ]));
  }
  if (!IN_APP && page.me && page.me.canComment && canWrite() && page.version && page.version.latest) {
    children.push(el('p', { cls: 'hint', text: isWide() ? 'Select text to comment. Press C with a selection to open the comment box.' : 'Select text to comment.' }));
  }
  children.push(el('div', { cls: 'layout' }, [article, threads]));
  if (!IN_APP) children.push(renderBar(page));
  main.replaceChildren(...children);
  main.classList.toggle('in-app', IN_APP);
  main.classList.toggle('with-bar', !IN_APP);
  requestAnimationFrame(positionThreads);
}

function renderHeader(page) {
  const meta = el('div', { cls: 'meta' });
  if (page.versions && page.versions.length) {
    const select = el('select', { attrs: { id: 'doc-version', 'aria-label': 'Version' }, on: { change: (e) => load(e.target.value) } });
    for (const v of page.versions) {
      const o = el('option', { text: `Version ${v.label}`, attrs: { value: v.id } });
      if (page.version && v.id === page.version.id) o.selected = true;
      select.appendChild(o);
    }
    meta.appendChild(el('span', { cls: 'version' }, [el('span', { cls: 'version-words', text: M.versionWords(page) }), select]));
    if (page.versions.length > 1) meta.appendChild(button(state.compareOpen ? 'Hide changes' : 'Compare', () => { state.compareOpen = !state.compareOpen; render(); }, 'btn small', { 'aria-expanded': String(state.compareOpen) }));
  }
  const lines = [];
  if (page.primary && page.primary.ref) lines.push(el('p', { cls: 'discussed', text: `Discussed in: ${page.primary.name || 'a conversation'}` }));
  else lines.push(el('p', { cls: 'discussed warn', text: 'This document\'s conversation was removed' }));
  if (page.audience) lines.push(el('p', { cls: 'audience', text: page.audience }));
  if (page.concurrentEdits) lines.push(el('p', { cls: 'note', text: 'Two versions were written at the same time; showing the newest.' }));
  return el('header', { cls: 'doc-header' }, [el('h1', { text: page.title || 'Untitled' }), meta, ...lines]);
}

function renderBlocks(article, page) {
  const blocks = page.blocks || [];
  const ranges = M.highlightRanges(page);
  const numbers = M.itemNumbers(blocks);
  if (!blocks.length) { article.appendChild(el('p', { cls: 'empty', text: 'This document is empty.' })); return; }
  blocks.forEach((b, i) => {
    let node;
    if (b.kind === 'heading') node = el(`h${Math.min(6, Math.max(1, (b.level || 1) + 1))}`, { cls: 'blk heading' });
    else if (b.kind === 'code') node = el('pre', { cls: 'blk code' });
    else if (b.kind === 'html') node = el('pre', { cls: 'blk html' });
    else if (b.kind === 'item') {
      node = el('div', { cls: `blk item ${b.ordered ? 'ordered' : 'bullet'}`, attrs: { role: 'listitem' } });
      node.style.marginInlineStart = `${Math.min(6, (b.level || 1)) * 1.25}em`;
      if (numbers[i] !== null) node.setAttribute('data-n', `${numbers[i]}.`);
    } else if (b.kind === 'row') node = el('div', { cls: `blk row${b.header ? ' header' : ''}` });
    else node = el('p', { cls: 'blk para' });
    if (b.quote) { node.classList.add('quoted'); node.style.borderInlineStartWidth = `${Math.min(4, b.quote) * 3}px`; }
    node.setAttribute('data-start', String(b.start));
    const host = b.kind === 'code' ? node.appendChild(el('code')) : node;
    const pieces = M.segmentBlock(b, ranges);
    let runIndex = -1; let runEl = null;
    for (const piece of pieces) {
      if (piece.runIndex !== runIndex) { runIndex = piece.runIndex; runEl = runElement(b.runs[runIndex], b.kind === 'code'); host.appendChild(runEl.outer); }
      const t = document.createTextNode(piece.text);
      textStart.set(t, piece.start);
      state.textNodes.push(t);
      if (piece.keys.length) {
        const mark = el('mark', { cls: 'hl', attrs: { 'data-keys': piece.keys.join(' ') } });
        if (piece.keys.length > 1) mark.classList.add('multi');
        mark.appendChild(t);
        runEl.inner.appendChild(mark);
      } else runEl.inner.appendChild(t);
    }
    article.appendChild(node);
  });
}

/** Nested inline elements for a run's marks; text goes into `inner`. */
function runElement(run, inCode) {
  let outer = null; let inner = null;
  const wrap = (n) => { if (!outer) outer = n; else inner.appendChild(n); inner = n; };
  const marks = run.marks || [];
  if (marks.includes('link')) {
    const href = M.safeHref(run.href);
    if (href) wrap(el('a', { attrs: { href, rel: 'noopener noreferrer', target: '_blank' } }));
    else wrap(el('span', { cls: 'link-text' }));
  }
  if (marks.includes('strong')) wrap(el('strong'));
  if (marks.includes('em')) wrap(el('em'));
  if (marks.includes('del')) wrap(el('del'));
  if (marks.includes('code') && !inCode) wrap(el('code'));
  if (!outer) wrap(el('span'));
  return { outer, inner };
}

// ── threads ────────────────────────────────────────────────────────────────────────────────────

function nameOf(authorKey) {
  const page = state.page;
  if (page.me && authorKey === page.me.key) return 'You';
  const c = (page.comments || []).find((x) => x.author === authorKey && x.authorName);
  if (c) return c.authorName;
  if (authorKey === 'owner') return 'Owner';
  if (String(authorKey).startsWith('agent.')) return page.agentName || 'Agent';
  return String(authorKey);
}

function renderThreads(aside, page) {
  const comments = page.comments || [];
  const latest = page.version && page.version.latest;
  const placed = comments.filter((c) => !c.resolved && c.anchorState !== 'orphaned').sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const orphaned = comments.filter((c) => !c.resolved && c.anchorState === 'orphaned');
  const resolved = comments.filter((c) => c.resolved);
  aside.appendChild(el('h2', { cls: 'threads-title', text: M.openWords(placed.length + orphaned.length) }));
  if (!comments.length) aside.appendChild(el('p', { cls: 'empty', text: 'No comments yet.' }));
  if (!latest && comments.length) aside.appendChild(el('p', { cls: 'note', text: 'Comments are shown without highlights on older versions.' }));
  const list = el('div', { cls: 'thread-list' });
  for (const c of placed) list.appendChild(threadCard(c));
  aside.appendChild(list);
  if (orphaned.length) {
    aside.appendChild(el('h3', { cls: 'threads-sub', text: 'Passage changed or removed' }));
    const l2 = el('div', { cls: 'thread-list static' });
    for (const c of orphaned) l2.appendChild(threadCard(c));
    aside.appendChild(l2);
  }
  if (resolved.length) {
    const d = el('details', { cls: 'resolved' }, [el('summary', { text: `Resolved (${resolved.length})` })]);
    for (const c of resolved) d.appendChild(threadCard(c));
    aside.appendChild(d);
  }
}

function threadCard(c, { inSheet = false } = {}) {
  const page = state.page;
  const card = el('article', { cls: `thread${c.resolved ? ' is-resolved' : ''}`, attrs: { 'data-key': inSheet ? null : c.key, tabindex: '-1', 'aria-label': `Comment by ${c.authorName || nameOf(c.author)}` } });
  if (c.quote) card.appendChild(el('blockquote', { cls: 'quote', text: c.quote.length > 280 ? `${c.quote.slice(0, 280)}…` : c.quote }));
  const note = M.anchorNote(c.anchorState);
  if (note) card.appendChild(el('p', { cls: 'anchor-note', text: note }));
  const badges = [];
  if (c.resolved) badges.push('Resolved');
  if (c.mine && c.sent) badges.push(`Sent to ${page.agentName}`);
  else if (c.mine && !c.resolved && !c.sent) badges.push('Not sent yet');
  card.appendChild(el('div', { cls: 'entry' }, [
    el('p', { cls: 'who' }, [el('span', { cls: 'name', text: (page.me && c.author === page.me.key) ? 'You' : (c.authorName || nameOf(c.author)) }), c.time ? el('span', { cls: 'time', text: ` · ${c.time}` }) : null]),
    el('p', { cls: 'body', text: c.body === null || c.body === undefined ? '(This comment\'s text was removed.)' : c.body }),
  ]));
  for (const r of c.replies || []) {
    card.appendChild(el('div', { cls: 'entry reply' }, [
      el('p', { cls: 'who' }, [el('span', { cls: 'name', text: nameOf(r.author) }), r.time ? el('span', { cls: 'time', text: ` · ${r.time}` }) : null]),
      el('p', { cls: 'body', text: r.body === null || r.body === undefined ? '(This reply\'s text was removed.)' : r.body }),
    ]));
  }
  if (badges.length) card.appendChild(el('p', { cls: 'badges', text: badges.join(' · ') }));

  const actions = el('div', { cls: 'actions' });
  const err = el('p', { cls: 'error', attrs: { role: 'alert' } });
  if (!inSheet && page.version && page.version.latest && Number.isInteger(c.start) && c.anchorState !== 'orphaned' && !c.resolved) {
    actions.appendChild(button('Show passage', () => showPassage(c.key), 'link-btn'));
  }
  if (canWrite()) {
    if (page.me && page.me.canComment) actions.appendChild(button('Reply', () => inlineEditor(card, c, 'reply'), 'btn small'));
    if (c.mine && c.body !== null) actions.appendChild(button('Edit', () => inlineEditor(card, c, 'edit'), 'btn small'));
    actions.appendChild(button(c.resolved ? 'Reopen' : 'Resolve', async (e) => {
      const b = e.currentTarget; b.disabled = true; err.textContent = '';
      const r = await threadWrite(c.resolved ? 'reopen' : 'resolve', { commentKey: c.key });
      b.disabled = false;
      if (r.ok) { closeSheet(false); await load(state.versionId); } else err.textContent = M.errorWords(r.status, r.data, errCtx());
    }, 'btn small'));
  }
  card.appendChild(actions);
  card.appendChild(err);
  return card;
}

/** A reply or edit box inside a thread card. Drafts survive reloads; retries reuse the same id. */
function inlineEditor(card, c, kind) {
  const existing = card.querySelector('.inline-editor');
  if (existing) { existing.querySelector('textarea').focus(); return; }
  const key = M.draftKey(DOC_ID, kind, c.key);
  const draft = loadDraft(key);
  if (kind === 'edit' && !draft.text) draft.text = c.body || '';
  const taId = `ta-${randomUuid()}`;
  const ta = el('textarea', { attrs: { id: taId, rows: '3' }, on: { input: () => { draft.text = ta.value; saveDraft(key, draft); } } });
  ta.value = draft.text;
  const err = el('p', { cls: 'error', attrs: { role: 'alert' } });
  const box = el('div', { cls: 'inline-editor' });
  const close = () => { box.remove(); };
  const post = button(kind === 'reply' ? 'Reply' : 'Save', async () => {
    const text = ta.value;
    const problem = M.bodyProblem(text);
    if (problem) { err.textContent = problem; return; }
    post.disabled = true; err.textContent = '';
    const r = kind === 'reply'
      ? await threadWrite('reply', { commentKey: c.key, replyId: draft.id }, text, draft.salt)
      : await threadWrite('edit', { commentKey: c.key }, text, draft.salt);
    post.disabled = false;
    if (r.ok) { storageDel(key); closeSheet(false); await load(state.versionId); } else err.textContent = M.errorWords(r.status, r.data, errCtx());
  }, 'btn primary small');
  box.append(
    el('label', { cls: 'label', text: kind === 'reply' ? 'Your reply' : 'Edit your comment', attrs: { for: taId } }),
    ta, err,
    el('div', { cls: 'row-buttons' }, [post, button('Cancel', () => { close(); }, 'btn small')]),
  );
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  card.insertBefore(box, card.querySelector('.error'));
  ta.focus();
}

function marksFor(key) {
  const article = document.getElementById('doc-body');
  if (!article) return [];
  return Array.from(article.querySelectorAll('mark.hl')).filter((m) => (m.getAttribute('data-keys') || '').split(' ').includes(key));
}

function showPassage(key) {
  const marks = marksFor(key);
  if (!marks.length) return;
  for (const m of document.querySelectorAll('mark.hl.active')) m.classList.remove('active');
  for (const m of marks) m.classList.add('active');
  marks[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** Open a thread: a sheet on a phone, the margin card on a computer. */
function focusThread(key) {
  const page = state.page;
  const c = page && (page.comments || []).find((x) => x.key === key);
  if (!c) return;
  for (const m of document.querySelectorAll('mark.hl.active')) m.classList.remove('active');
  for (const m of marksFor(key)) m.classList.add('active');
  if (isWide()) {
    const card = document.querySelector(`.threads [data-key="${CSS.escape(key)}"]`);
    if (card) {
      const d = card.closest('details'); if (d) d.open = true;
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1600);
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.focus({ preventScroll: true });
      return;
    }
  }
  openSheet('Comment thread', (body) => { body.appendChild(threadCard(c, { inSheet: true })); });
}

/** Threads beside their passages on a computer; a list when they'd overlap (or on a phone). */
function positionThreads() {
  const aside = document.getElementById('doc-threads');
  const article = document.getElementById('doc-body');
  if (!aside || !article) return;
  const list = aside.querySelector('.thread-list');
  const cards = list ? Array.from(list.children) : [];
  for (const c of cards) c.style.top = '';
  list && (list.style.minHeight = '');
  aside.classList.remove('margin');
  if (!isWide() || !state.page.version || !state.page.version.latest || !cards.length) return;
  const base = list.getBoundingClientRect().top;
  const items = [];
  for (const card of cards) {
    const m = marksFor(card.getAttribute('data-key'))[0];
    if (!m) return; // a thread without a highlight: keep the list
    items.push({ key: card.getAttribute('data-key'), top: m.getBoundingClientRect().top - base, height: card.offsetHeight });
  }
  const layout = M.marginLayout(items);
  if (layout.mode !== 'margin') return;
  aside.classList.add('margin');
  let bottom = 0;
  for (const card of cards) {
    const top = layout.tops[card.getAttribute('data-key')];
    card.style.top = `${Math.max(0, Math.round(top))}px`;
    bottom = Math.max(bottom, top + card.offsetHeight);
  }
  list.style.minHeight = `${Math.ceil(bottom)}px`;
}

// ── compare ────────────────────────────────────────────────────────────────────────────────────

function renderCompare(page) {
  const vs = page.versions || [];
  const mk = (id, label, sel) => {
    const s = el('select', { attrs: { id, 'aria-label': label } });
    for (const v of vs) { const o = el('option', { text: `Version ${v.label}`, attrs: { value: v.id } }); if (v.id === sel) o.selected = true; s.appendChild(o); }
    return s;
  };
  const cur = page.version ? vs.findIndex((v) => v.id === page.version.id) : vs.length - 1;
  const toIdx = cur >= 0 ? cur : vs.length - 1;
  const fromIdx = Math.max(0, toIdx - 1);
  const from = mk('cmp-from', 'Compare from', vs[fromIdx] && vs[fromIdx].id);
  const to = mk('cmp-to', 'Compare to', vs[toIdx] && vs[toIdx].id);
  const out = el('div', { cls: 'diff', attrs: { role: 'region', 'aria-label': 'Changes', 'aria-live': 'polite' } });
  const run = async () => {
    if (from.value === to.value) { out.replaceChildren(el('p', { cls: 'note', text: 'Pick two different versions.' })); return; }
    out.replaceChildren(el('p', { cls: 'note', text: 'Working out the changes…' }));
    const r = await fetchJson(`/docs/${DOC_ID}/page-compare?from=${encodeURIComponent(from.value)}&to=${encodeURIComponent(to.value)}`);
    if (r.status === 401) { await expired(); return; }
    if (!r.ok || !r.data) { out.replaceChildren(el('p', { cls: 'error', text: M.errorWords(r.status, r.data, errCtx()) })); return; }
    const text = el('div', { cls: 'diff-text' });
    const pieces = M.diffPieces(r.data.ops);
    for (const p of pieces) text.appendChild(p.kind === 'eq' ? document.createTextNode(p.text) : el(p.kind, { text: p.text }));
    const kids = [];
    if (!pieces.some((p) => p.kind !== 'eq')) kids.push(el('p', { cls: 'note', text: 'No changes between these versions.' }));
    kids.push(text);
    if (r.data.truncated) kids.push(el('p', { cls: 'note', text: 'Only part of the changes could be shown.' }));
    out.replaceChildren(...kids);
  };
  const panel = el('section', { cls: 'compare', attrs: { 'aria-label': 'Compare versions' } }, [
    el('div', { cls: 'compare-pick' }, [from, el('span', { text: '→' }), to, button('Show changes', run, 'btn small primary')]),
    el('p', { cls: 'legend' }, [el('ins', { text: 'added' }), ' ', el('del', { text: 'removed' })]),
    out,
  ]);
  setTimeout(run, 0);
  return panel;
}

// ── Send (computer browser) ────────────────────────────────────────────────────────────────────

function renderBar(page) {
  const n = M.openCount(page);
  const bar = el('div', { cls: 'bar', attrs: { role: 'region', 'aria-label': 'Send comments' } });
  bar.appendChild(el('span', { cls: 'count', text: M.openWords(n) }));
  const label = `Send comments to ${page.agentName || 'the agent'}`;
  const send = button(label, () => sendComments(send), 'btn primary');
  const ok = canWrite() && M.canSend(page);
  send.disabled = !ok;
  if (!page.primary || !page.primary.sendPath) send.title = 'This document\'s conversation was removed';
  else if (!ok && M.unsentMine(page).length === 0) send.title = 'Nothing new to send';
  bar.appendChild(send);
  return bar;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendComments(btn) {
  const page = state.page;
  if (!state.device || !M.canSend(page)) return;
  const { bd, rec, privateKey, clock } = state.device;
  const covered = M.unsentMine(page);
  const keys = M.commentKeysJson(M.myOpenKeys(page));
  // A retry of an unfinished Send reuses its batch, so the chat route's requestId makes the
  // message a no-op and only the `send` row is written again (§3.8).
  if (!state.pendingBatch || state.pendingBatch.keys !== keys) state.pendingBatch = { batchId: bd.newRequestId(clock.now()), keys, messageSent: false };
  const { batchId } = state.pendingBatch;
  const messageRequestId = M.messageRequestIdFor(batchId);
  const latest = (page.versions || [])[page.versions.length - 1];
  const text = M.sendMessage({ count: covered.length, title: page.title, label: latest ? latest.label : page.version.label, origin: location.origin, id: DOC_ID });
  btn.disabled = true;
  notice('Sending…', 'info');
  try {
    if (!state.pendingBatch.messageSent) {
      const path = page.primary.sendPath;
      const body = JSON.stringify({ text, requestId: messageRequestId });
      let r = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const h = await bd.signRequest({ record: rec, privateKey, method: 'POST', path, body, timeMs: clock.now() });
        r = await fetchJson(path, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body });
        if (r.status !== 202) break;
        await sleep(1500);
      }
      if (!r || !r.ok || r.status === 202) {
        notice(r && r.status === 202 ? 'The message is still on its way. Send again in a moment.' : M.errorWords(r ? r.status : 0, r ? r.data : null, errCtx()));
        return;
      }
      state.pendingBatch.messageSent = true;
    }
    // The signed set is all my open comments; if it changed meanwhile (409 comments-changed),
    // re-read the page and sign the new set once more. The message itself is not re-sent.
    const sendRow = async (p) => writeSigned('send', { batchId, commentKeysHash: await bd.sha256Hex(M.commentKeysJson(M.myOpenKeys(p))), primaryRow: p.primary.primaryRow, messageRequestId });
    let w = await sendRow(page);
    if (!w.ok && w.data && w.data.error === 'comments-changed') {
      const fresh = await fetchJson(`/docs/${DOC_ID}/page-data${state.versionId ? `?version=${encodeURIComponent(state.versionId)}` : ''}`);
      // Retry only when the fresh set adds nothing the message didn't count: comments added since
      // (another tab, another device) must never be marked sent without being sent.
      const before = new Set(M.myOpenKeys(page));
      const after = fresh.ok && fresh.data ? M.myOpenKeys(fresh.data) : null;
      if (after && after.every((k) => before.has(k)) && fresh.data.primary && fresh.data.primary.primaryRow) w = await sendRow(fresh.data);
      else if (after) { state.pendingBatch = null; await load(state.versionId); notice('New comments arrived while sending. Tap Send again to include them.'); return; }
    }
    if (w.ok) {
      state.pendingBatch = null;
      notice(`Sent to ${page.agentName}.`, 'ok');
      await load(state.versionId);
      notice(`Sent to ${page.agentName}.`, 'ok');
      return;
    }
    if (w.data && w.data.error === 'document-moved') { state.pendingBatch = null; await load(state.versionId); notice(M.errorWords(409, w.data, errCtx())); return; }
    notice(`Your message reached ${page.agentName}, but the comments couldn't be marked as sent. ${M.errorWords(w.status, w.data, errCtx())}`);
  } finally {
    btn.disabled = !(canWrite() && M.canSend(state.page));
  }
}

// ── selection, the Comment pill and the composer ───────────────────────────────────────────────

/** A DOM boundary → projection offset, through the text-node map. */
function boundaryOffset(node, offset) {
  if (node.nodeType === Node.TEXT_NODE && textStart.has(node)) return textStart.get(node) + Math.min(offset, node.data.length);
  const nodes = state.textNodes;
  if (!nodes.length) return 0;
  const r = document.createRange();
  try { r.setStart(node, offset); } catch { return 0; }
  r.collapse(true);
  // First text node starting at or after the boundary (comparePoint is monotonic in document order).
  let lo = 0; let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let cmp;
    try { cmp = r.comparePoint(nodes[mid], 0); } catch { cmp = 1; }
    if (cmp >= 0) hi = mid; else lo = mid + 1;
  }
  if (lo < nodes.length) return textStart.get(nodes[lo]);
  const last = nodes[nodes.length - 1];
  return textStart.get(last) + last.data.length;
}

function currentSelection() {
  const sel = window.getSelection();
  const article = document.getElementById('doc-body');
  if (!sel || !article || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!article.contains(range.commonAncestorContainer)) return null;
  const a = boundaryOffset(range.startContainer, range.startOffset);
  const b = boundaryOffset(range.endContainer, range.endOffset);
  const norm = M.normalizeSelection(a, b, state.projection);
  if (!norm) return null;
  return { ...norm, rect: range.getBoundingClientRect() };
}

let selTimer = 0;
function onSelectionChange() {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    if (state.sheet) return;
    const page = state.page;
    const s = page ? currentSelection() : null;
    state.selection = s;
    if (!s || !page.version || !page.version.latest || !page.me || !page.me.canComment) { hidePill(); return; }
    if (IN_APP) {
      const sig = `${s.start}-${s.end}`;
      if (sig === state.lastPostedSelection) return;
      state.lastPostedSelection = sig;
      try { bridge.postMessage({ type: 'selection', docId: DOC_ID, start: s.start, end: s.end }); } catch { /* the app shows nothing */ }
      return;
    }
    if (canWrite()) showPill(s);
  }, IN_APP ? 350 : 200);
}

let pill = null;
function showPill(s) {
  if (!pill) {
    pill = button('Comment', () => openComposer(state.selection), 'pill', { 'aria-label': 'Comment on the selected text (C)' });
    pill.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
    document.body.appendChild(pill);
  }
  pill.hidden = false;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const w = pill.offsetWidth || 96; const h = pill.offsetHeight || 40;
  // Above the selection, clear of the system copy menu (which sits right above it on touch).
  const above = s.rect.top - h - (coarse ? 64 : 10);
  const top = above >= 8 ? above : Math.min(window.innerHeight - h - 8, s.rect.bottom + (coarse ? 40 : 10));
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, s.rect.left + s.rect.width / 2 - w / 2));
  pill.style.top = `${Math.round(top)}px`;
  pill.style.left = `${Math.round(left)}px`;
}
function hidePill() { if (pill) pill.hidden = true; }

function openComposer(s) {
  const page = state.page;
  if (!s || IN_APP || !canWrite() || !page.version || !page.version.latest) return;
  hidePill();
  const quote = state.projection.slice(s.start, s.end);
  const key = M.draftKey(DOC_ID, 'comment', s.start, s.end);
  const draft = loadDraft(key);
  const onVersion = page.version.id;
  openSheet('Comment on the selected passage', (body, close) => {
    const taId = `ta-${randomUuid()}`;
    const ta = el('textarea', { attrs: { id: taId, rows: '4' }, on: { input: () => { draft.text = ta.value; saveDraft(key, draft); } } });
    ta.value = draft.text;
    const err = el('p', { cls: 'error', attrs: { role: 'alert' } });
    const post = button('Post', async () => {
      const text = ta.value;
      const problem = M.bodyProblem(text);
      if (problem) { err.textContent = problem; return; }
      post.disabled = true; err.textContent = '';
      saveDraft(key, draft);
      const r = await writeSigned('comment', { commentId: draft.id, onVersion, start: s.start, end: s.end }, text, draft.salt);
      post.disabled = false;
      if (r.ok) { storageDel(key); close(); window.getSelection()?.removeAllRanges(); await load(null); }
      else err.textContent = M.errorWords(r.status, r.data, errCtx());
    }, 'btn primary');
    body.append(
      el('blockquote', { cls: 'quote', text: quote.length > 400 ? `${quote.slice(0, 400)}…` : quote }),
      el('label', { cls: 'label', text: 'Your comment', attrs: { for: taId } }),
      ta, err,
      el('div', { cls: 'row-buttons' }, [post, button('Cancel', () => close(), 'btn')]),
    );
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post.click(); });
    return ta;
  });
}

// ── sheets (dialogs) ───────────────────────────────────────────────────────────────────────────

function openSheet(label, build) {
  closeSheet(false);
  const returnTo = document.activeElement;
  const backdrop = el('div', { cls: 'sheet-backdrop' });
  const sheet = el('div', { cls: 'sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': label } });
  const body = el('div', { cls: 'sheet-body' });
  const close = () => closeSheet(true);
  sheet.append(el('div', { cls: 'sheet-head' }, [el('h2', { text: label }), button('Close', close, 'btn small', { 'aria-label': 'Close' })]), body);
  backdrop.addEventListener('click', close);
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      const f = Array.from(sheet.querySelectorAll('button, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')).filter((n) => !n.disabled && n.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  state.sheet = { backdrop, sheet, returnTo };
  document.body.append(backdrop, sheet);
  const first = build(body, close);
  (first || sheet.querySelector('textarea, button') || sheet).focus();
}

function closeSheet(restoreFocus) {
  const s = state.sheet;
  if (!s) return;
  state.sheet = null;
  s.backdrop.remove(); s.sheet.remove();
  if (restoreFocus && s.returnTo && typeof s.returnTo.focus === 'function' && document.contains(s.returnTo)) s.returnTo.focus();
}

// ── global handlers ────────────────────────────────────────────────────────────────────────────

let installed = false;
function installGlobalHandlers() {
  if (installed) return;
  installed = true;
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable);
    if (e.key === 'Escape') { if (state.sheet) closeSheet(true); else hidePill(); return; }
    if (!typing && !state.sheet && (e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const s = currentSelection();
      if (s && !IN_APP && canWrite()) { e.preventDefault(); openComposer(s); }
    }
  });
  main.addEventListener('click', (e) => {
    const mark = e.target && e.target.closest ? e.target.closest('mark.hl') : null;
    if (!mark) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // selecting, not tapping
    const keys = (mark.getAttribute('data-keys') || '').split(' ').filter(Boolean);
    if (keys.length) focusThread(keys[0]);
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(positionThreads, 150); });
  if (IN_APP) {
    window.addEventListener('instar-docs', (e) => {
      const ev = M.parseAppEvent(e.detail);
      if (!ev) return;
      if (ev.type === 'write-result') {
        const done = state.pendingBridge.get(ev.id);
        if (done) { state.pendingBridge.delete(ev.id); done({ ok: ev.status >= 200 && ev.status < 300, status: ev.status, data: ev.body }); }
      } else if (ev.type === 'refresh') {
        state.lastPostedSelection = '';
        load(state.versionId);
      } else if (ev.type === 'focus-comment') {
        if (state.page) focusThread(ev.commentKey); else state.focusKey = ev.commentKey;
      }
    });
  }
}

boot();
