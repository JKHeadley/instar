// Instar Documents — a member's computer joins from the owner's team invite (no app needed).
// Spec: docs/specs/member-browser-any-computer.md §3.1. Served at /docs/_join under the document
// page's CSP: every node is built with createElement + textContent.
//
// The invite link's code arrives in the fragment (#v=1&c=<code>[&d=<docId>]), never in a request
// line. The page clears it from history, makes a non-extractable key in this origin's IndexedDB
// ('instar-docs', the same store the document page reads), posts the code in a body to redeem,
// then asks for the six-digit code the owner sees on their phone and signs it with the key.

import * as M from './doc-page-model.js';

const main = document.getElementById('doc');
const DOCS_DB = 'instar-docs';
const DOCS_STORE = 'device';

function el(tag, opts = {}, children = []) {
  const n = document.createElement(tag);
  if (opts.cls) n.className = opts.cls;
  if (opts.text !== undefined && opts.text !== null) n.textContent = String(opts.text);
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v));
  if (opts.on) for (const [k, f] of Object.entries(opts.on)) n.addEventListener(k, f);
  for (const c of children) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}
const button = (text, onClick, cls = 'btn') => el('button', { cls, text, attrs: { type: 'button' }, on: { click: onClick } });
const view = (children) => main.replaceChildren(el('div', { cls: 'page-message link-computer' }, children));
const say = (words, tone = 'info') => view([el('p', { cls: tone === 'bad' ? 'bad' : '', attrs: { role: tone === 'bad' ? 'alert' : 'status' }, text: words })]);

function docsDb() {
  return new Promise((resolve, reject) => {
    const f = globalThis.indexedDB;
    if (!f) { reject(new Error('indexeddb-unavailable')); return; }
    const r = f.open(DOCS_DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(DOCS_STORE)) r.result.createObjectStore(DOCS_STORE, { keyPath: 'machineId' }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('indexeddb-open-failed'));
  });
}
async function tx(mode, fn) {
  const db = await docsDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(DOCS_STORE, mode);
      let out;
      fn(t.objectStore(DOCS_STORE), (v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error || new Error('indexeddb-failed'));
    });
  } finally { db.close(); }
}
const readAll = () => tx('readonly', (s, set) => { const r = s.getAll(); r.onsuccess = () => set(r.result || []); });
const write = (rec) => tx('readwrite', (s) => { s.put(rec); });

async function post(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Instar-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => null) };
  } catch { return { status: 0, ok: false, data: null }; }
}

const host = location.host.toLowerCase();

async function boot() {
  const frag = M.parseJoinFragment(location.hash);
  // The code never stays in this page's history entry (a shared computer's back button).
  try { history.replaceState(null, '', location.pathname); } catch { /* history unavailable */ }
  try { await navigator.storage?.persist?.(); } catch { /* best effort: Safari may still clear idle storage */ }
  let bd;
  try { bd = await import('/dashboard/console/browser-device.js'); } catch { say('This browser can\'t be set up here. It needs a recent browser.', 'bad'); return; }
  const recs = await readAll().catch(() => null);
  if (recs === null) { say('This browser can\'t be set up here. It needs private storage turned on.', 'bad'); return; }
  // Already waiting for a code here (the tab was closed and reopened): resume.
  const waiting = recs.find((r) => r && r.status === 'joining' && r.host === host && r.keyPair && r.deviceId);
  if (waiting && !frag) { askForCode(bd, waiting); return; }
  const active = recs.find((r) => r && r.status === 'active' && r.host === host && r.joinedVia === 'team-invite');
  if (!frag) {
    if (active) { done(null, active.ownerName); return; }
    say('This page needs the invite link you were sent. Open that link again on this computer.', 'bad');
    return;
  }
  view([el('p', { attrs: { role: 'status' }, text: 'Setting up this computer…' })]);
  const key = await bd.generateDeviceKey().catch(() => null);
  if (!key) { say('This browser can\'t make a key here. It needs a recent browser with private storage turned on.', 'bad'); return; }
  const r = await post('/docs/_join/redeem', { code: frag.code, browserPublicKey: key.publicKey });
  if (!r.ok || !r.data || typeof r.data.deviceId !== 'string') { failed(M.joinErrorWords(r.status, r.data, r.data && r.data.ownerName)); return; }
  const rec = {
    machineId: r.data.machineId || `join:${host}`, keyPair: key.keyPair, publicKey: key.publicKey,
    keyHash: await bd.keyHashOf(key.publicKey), fingerprint: await bd.fingerprintOf(key.publicKey),
    deviceId: r.data.deviceId, host, status: 'joining', linkedFor: M.LINK_PURPOSE, joinedVia: 'team-invite',
    ownerName: r.data.ownerName || '', checkLetters: r.data.checkLetters || '', docId: frag.docId, createdAt: new Date().toISOString(),
  };
  await write(rec);
  askForCode(bd, rec);
}

function failed(words) {
  view([el('p', { cls: 'bad', attrs: { role: 'alert' }, text: words })]);
}

function askForCode(bd, rec) {
  const owner = rec.ownerName || 'the owner';
  const input = el('input', { cls: 'join-code', attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', 'aria-label': 'Code', maxlength: '7', placeholder: '123 456' } });
  const status = el('p', { cls: 'link-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const submit = async () => {
    const code = M.cleanJoinCode(input.value);
    if (!code) { status.textContent = `The code is six digits, shown on ${owner}'s phone in People.`; return; }
    status.textContent = 'Checking…';
    const timeMs = String(Date.now());
    const sig = await bd.signText(rec.keyPair.privateKey, M.joinConfirmString({ deviceId: rec.deviceId, host, timeMs, code }));
    const r = await post('/docs/_join/confirm', { deviceId: rec.deviceId, code, timeMs, sig });
    if (r.ok && r.data && r.data.status === 'active') {
      const { checkLetters: _c, ...rest } = rec;
      await write({ ...rest, machineId: (r.data.machineId || rec.machineId), status: 'active', linkedAt: new Date().toISOString(), computerEndsAt: r.data.expiresAt || null });
      done(rec.docId, owner);
      return;
    }
    status.textContent = M.joinErrorWords(r.status, r.data, owner);
    if (r.data && (r.data.error === 'declined' || r.data.error === 'code-not-waiting' || r.data.error === 'person-unknown')) {
      input.disabled = true;
      await write({ ...rec, status: 'ended' });
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); });
  view([
    el('h1', { cls: 'link-title', text: 'Use this computer for documents' }),
    el('p', { text: `Ask ${owner} for your code. It's on their phone, in People, under your name.` }),
    el('p', {}, ['Your check letters: ', el('strong', { cls: 'link-fingerprint', text: rec.checkLetters || '' })]),
    el('p', { cls: 'scope', text: `${owner} may ask you to read these out before giving you the code.` }),
    el('p', {}, [input, ' ', button('Continue', () => { void submit(); }, 'btn primary')]),
    status,
    el('p', { cls: 'scope', text: 'This computer will only read and comment on documents you can see, and you can remove it at any time.' }),
  ]);
  input.focus();
}

function done(docId, owner) {
  if (docId) { location.assign(`/docs/${docId}`); return; }
  view([
    el('h1', { cls: 'link-title', text: 'You\'re set up' }),
    el('p', { text: `Open any document link ${owner || 'the owner'} or the agent sends you, on this computer.` }),
  ]);
}

boot().catch(() => say('Something went wrong setting up this computer. Reload the page to try again.', 'bad'));
