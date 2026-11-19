// One place for a weak or missing connection (docs/specs/app-weak-network.md).
//
// Every console read goes through the browser's fetch, so this wraps fetch once
// instead of asking each page to remember:
//  - an allowlisted status read (needs, work board, development, promises, ...)
//    is saved when it answers; next time the saved answer shows after a short
//    first try (FIRST_TRY_MS) while the real read carries on in the background;
//  - with no connection, a read answers at once (the saved copy, or a failure)
//    instead of after the pages' 20 s deadline, twice;
//  - one line at the top says plainly what is shown and how old it is, and the
//    agent is checked again in the background until it answers; then the page
//    reads again.
// Privacy: conversation text, titles, grants, owner proof and anything read
// with an operator (PIN) session are never saved; saved copies are keyed to
// the sign-in and wiped on sign-out.

export const FIRST_TRY_MS = 4000;
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SAVED_BYTES = 256 * 1024;
export const RETRY_STEPS_MS = [2000, 5000, 15000, 30000, 60000];
export const BACK_GAP_MS = 15000;
export const SLOW_LINE_MS = 8000;
export const PROBE_TIMEOUT_MS = 3000;
const PREFIX = 'instar-net:';
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/;

// Status reads only. Never conversations, topics (their names are conversation
// titles), threadline, secrets, accounts, people or preferences.
const STORED = [
  /^\/needs$/, /^\/attention$/, /^\/commitments$/, /^\/sessions$/, /^\/pool$/,
  /^\/work\//, /^\/projects(\/[^/]+)?$/, /^\/local-verify$/, /^\/green-pr-automerge$/,
  /^\/health$/, /^\/maturation\/board$/, /^\/jobs$/, /^\/queue-pace$/, /^\/guards$/, /^\/mandate$/,
  /^\/work-board$/, /^\/release-readiness$/, /^\/throughput\/series$/,
  /^\/feedback-factory\/(readiness-authorities\/proposal|triage\/summary|triage\/authority\/proposal|execute\/status|triage\/queue|drain\/status)$/,
];

/** A front or proxy answering for an agent it could not reach (Cloudflare 52x/530, a proxy's 502/504). */
export function frontCouldNotReach(status) {
  return status === 502 || status === 504 || (status >= 520 && status <= 530);
}

function headerOf(init, name, input) {
  const h = (init && init.headers) || (input && typeof input === 'object' && input.headers);
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : null;
}

/** The same-origin path + query of a request, or null for another origin. */
export function requestPath(input, origin) {
  try {
    const u = new URL(typeof input === 'string' ? input : input.url, origin + '/');
    return u.origin === origin ? u.pathname + u.search : null;
  } catch { return null; } // @silent-fallback-ok: an unparseable address is simply not saved
}

export function isStorable(path, init, input) {
  if (!path) return false;
  const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
  if (method !== 'GET') return false;
  if (headerOf(init, 'X-Instar-Operator-Session', input)) return false;
  // Saved copies belong to the sign-in that read them: no bearer, nothing saved.
  if (!bearerOf(init, input)) return false;
  const [bare, query] = path.split('?');
  // A continuation must check the viewer and the current list every time it opens.
  if (bare === '/needs' && new URLSearchParams(query).has('cursor')) return false;
  return STORED.some((re) => re.test(bare));
}

/** The bearer a request carries (its own sign-in), or ''. */
export function bearerOf(init, input) {
  const v = String(headerOf(init, 'Authorization', input) || '');
  return v.startsWith('Bearer ') ? v.slice(7) : '';
}

/** A short, non-secret tag for a sign-in, so one sign-in never sees another's saved copies. */
export function signInTag(token) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(token || '').length; i++) { h ^= String(token).charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** "1:52 pm" today, "yesterday 6:10 pm", or "Nov 14, 6:10 pm". */
export function whenWords(at, now) {
  const d = new Date(at); const n = new Date(now);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(/\s+/g, ' ');
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  if (diff <= 0) return time;
  if (diff === 1) return `yesterday ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/** The top line, or '' when the connection is fine. */
export function lineText(state, now) {
  if (!state || state.mode === 'fresh') return '';
  const offline = state.mode === 'offline';
  if (state.shownAt) {
    return offline
      ? `Offline. Showing what I had at ${whenWords(state.shownAt, now)}.`
      : `Weak connection. Showing what I had at ${whenWords(state.shownAt, now)}. Trying again.`;
  }
  return offline
    ? 'Offline. Nothing saved on this device yet. I’ll load it when the connection is back.'
    : 'Weak connection. Still trying to reach the agent.';
}

/**
 * The fetch wrapper and its state. Every dependency is passed in so it can be tested.
 * onChange(state) repaints the line; onBack() re-reads the current page once the agent answers again.
 */
export function createNetState({ fetchFn, storage, origin, now = () => Date.now(), isOnline = () => true,
  getToken = () => '', setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {}, onBack = () => {}, probePath = '/health' }) {
  let state = { mode: 'fresh', shownAt: null };
  let retryTimer = null; let retryStep = 0; let probing = false;

  const key = (path, bearer) => `${PREFIX}${signInTag(bearer)}:${path}`;
  const set = (next) => {
    const changed = next.mode !== state.mode || next.shownAt !== state.shownAt;
    state = next;
    if (changed) onChange(state);
  };
  const read = (path, bearer) => {
    try {
      const v = JSON.parse(storage.getItem(key(path, bearer)) || 'null');
      if (!v || typeof v.at !== 'number' || !('data' in v)) return null;
      if (now() - v.at > KEEP_MS) { storage.removeItem(key(path, bearer)); return null; }
      return v;
    } catch { return null; } // @silent-fallback-ok: unreadable or blocked storage means nothing saved
  };
  const write = (path, bearer, data) => {
    try {
      // The sign-in changed while this read was out (sign-out, a new PIN): it is not saved under either.
      if (bearer !== getToken()) return;
      const s = JSON.stringify({ at: now(), data });
      if (s.length <= MAX_SAVED_BYTES) storage.setItem(key(path, bearer), s);
    } catch { /* @silent-fallback-ok: storage full or blocked; the page still shows the live answer */ }
  };
  const savedResponse = (v) => new Response(JSON.stringify(v.data), {
    status: 200, headers: { 'Content-Type': 'application/json', 'X-Instar-Saved-At': String(v.at) },
  });
  const offlineError = () => new TypeError('Offline: the device has no connection');

  let lastBack = -Infinity;
  const good = () => {
    const wasBad = state.mode !== 'fresh';
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    retryStep = 0;
    set({ mode: 'fresh', shownAt: null });
    // Read the page again once the agent answers, at most every BACK_GAP_MS so a
    // flickering connection cannot turn into a refresh every few seconds.
    if (wasBad && now() - lastBack >= BACK_GAP_MS) { lastBack = now(); onBack(); }
  };
  const bad = (shownAt) => {
    const mode = isOnline() ? 'weak' : 'offline';
    // Keep the oldest copy on screen in the line: that is what the person is looking at.
    const at = shownAt && state.shownAt ? Math.min(shownAt, state.shownAt) : (shownAt || state.shownAt || null);
    set({ mode, shownAt: at });
    scheduleRetry();
  };
  function scheduleRetry() {
    if (retryTimer) return;
    const wait = RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)];
    retryStep++;
    retryTimer = setTimer(() => { retryTimer = null; probe(); }, wait);
  }
  /** Does the agent answer a tiny read quickly? Tells a weak connection from a page that is just slow. */
  async function reachable() {
    if (!isOnline()) return false;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctl ? setTimer(() => ctl.abort(), PROBE_TIMEOUT_MS) : null;
    try {
      const r = await fetchFn(probePath, { cache: 'no-store', ...(ctl ? { signal: ctl.signal } : {}) });
      return !!r && r.status > 0 && !frontCouldNotReach(r.status);
    } catch { return false; } // @silent-fallback-ok: no answer is the answer: not reachable
    finally { if (t) clearTimer(t); }
  }
  async function probe() {
    if (probing) return;
    probing = true;
    try { if (await reachable()) good(); else bad(null); } finally { probing = false; }
  }

  async function wrapped(input, init) {
    const path = requestPath(input, origin);
    if (!isStorable(path, init, input)) {
      // Sends and unsaved reads: no waiting on a device that says it is offline.
      if (!isOnline()) { bad(null); throw offlineError(); }
      try {
        const r = await fetchFn(input, init);
        if (path) { if (frontCouldNotReach(r.status)) bad(null); else good(); }
        return r;
      } catch (e) {
        if (path && !(e && e.name === 'AbortError')) bad(null);
        throw e;
      }
    }
    const bearer = bearerOf(init, input);
    const saved = read(path, bearer);
    if (!isOnline()) {
      bad(saved ? saved.at : null);
      if (saved) return savedResponse(saved);
      throw offlineError();
    }
    const suspect = state.mode !== 'fresh';
    const live = (async () => {
      const r = await fetchFn(input, init);
      // A front answering for an agent it could not reach is no answer from the agent.
      if (frontCouldNotReach(r.status)) { const e = new TypeError(`The agent could not be reached (${r.status})`); e.frontResponse = r; throw e; }
      if (r.ok) {
        try { write(path, bearer, await r.clone().json()); } catch { /* @silent-fallback-ok: not JSON; returned as is, not saved */ }
      }
      good();
      return r;
    })();
    const settled = live.then((r) => ({ r }), (e) => ({ e }));
    const after = (ms) => { let id = null; const p = new Promise((resolve) => { id = setTimer(() => resolve('slow'), ms); }); return { p, stop: () => clearTimer(id) }; };
    if (!saved) {
      // Nothing to show yet: never a bare placeholder past SLOW_LINE_MS on a weak connection.
      const wait = after(SLOW_LINE_MS);
      const first = await Promise.race([settled, wait.p]);
      wait.stop();
      const asIs = (e) => { if (e && e.frontResponse) return e.frontResponse; throw e; };
      if (first === 'slow') { reachable().then((ok) => { if (!ok) bad(null); }); return live.catch((e) => { if (!(e && e.name === 'AbortError')) bad(null); return asIs(e); }); }
      if (first.e) { if (!(first.e && first.e.name === 'AbortError')) bad(null); return asIs(first.e); }
      return first.r;
    }
    // Something is saved: show it if the agent cannot be reached, or the connection is
    // already known to be weak and the agent is slow. A page that is merely slow on a good
    // connection keeps waiting for the real answer.
    const wait = after(FIRST_TRY_MS);
    const first = await Promise.race([settled, wait.p]);
    wait.stop();
    if (first !== 'slow') {
      if (first.e && first.e.name !== 'AbortError') { bad(saved.at); return savedResponse(saved); }
      if (first.e) throw first.e;
      return first.r;
    }
    if (suspect || !(await reachable())) {
      live.catch(() => {}); // @silent-fallback-ok: the saved copy is on screen and the line says how old it is; the retry loop takes over
      bad(saved.at);
      return savedResponse(saved);
    }
    // The agent answered the check but this read then failed (or a front answered for it): the saved copy.
    return live.catch((e) => { if (e && e.name !== 'AbortError') { bad(saved.at); return savedResponse(saved); } throw e; });
  }

  return {
    fetch: wrapped,
    state: () => state,
    probeNow: () => { if (retryTimer) { clearTimer(retryTimer); retryTimer = null; } return probe(); },
    wentOffline: () => bad(null),
    clear: () => {
      try {
        const keys = [];
        for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(PREFIX)) keys.push(k); }
        keys.forEach((k) => storage.removeItem(k));
      } catch { /* @silent-fallback-ok: blocked storage holds nothing to wipe */ }
    },
  };
}

/** Wires the wrapper into the page: replaces the global fetch (window.fetch in a browser) and draws the top line. */
export function installNetState({ getToken, onBack }) {
  const original = globalThis.fetch;
  if (typeof original !== 'function') {
    // No fetch to wrap (never in a browser): nothing is saved and no line is drawn.
    const idle = document.createElement('div'); idle.hidden = true;
    return { fetch: original, state: () => ({ mode: 'fresh', shownAt: null }), probeNow: () => {}, wentOffline: () => {}, clear: () => {}, lineElement: () => idle };
  }
  const raw = (...a) => original.apply(globalThis, a);
  let storage = null;
  try { storage = window.localStorage; } catch { storage = null; } // @silent-fallback-ok: no storage, nothing is saved
  const mem = new Map();
  const store = storage || { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k), get length() { return mem.size; }, key: (i) => [...mem.keys()][i] };
  // One element for the life of the page; the console's shell puts it back on every page (lineElement()).
  const line = document.createElement('div');
  line.className = 'net-line';
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  line.hidden = true;
  const paint = (state) => {
    const text = lineText(state, Date.now());
    line.textContent = text;
    line.hidden = !text;
    line.dataset.mode = state.mode;
  };
  const net = createNetState({
    // The dashboard on the agent's own machine reaches it with no network at all: never "offline" there.
    fetchFn: raw, storage: store, origin: location.origin,
    isOnline: () => LOOPBACK.test(location.hostname) || !(globalThis.navigator && globalThis.navigator.onLine === false),
    getToken, onChange: paint, onBack,
  });
  globalThis.fetch = net.fetch;
  window.addEventListener('online', () => { net.probeNow(); });
  window.addEventListener('offline', () => { net.wentOffline(); });
  // Keep the time words right ("yesterday") on a page left open.
  setInterval(() => { if (net.state().mode !== 'fresh') paint(net.state()); }, 60000);
  return { ...net, lineElement: () => line };
}
