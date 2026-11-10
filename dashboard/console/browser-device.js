// The browser as its own signed device (docs/specs/dashboard-conversations-browser-device.md §4.1, §4.2, §4.6).
//
// A WebCrypto P-256 key that page script cannot export (extractable: false), kept in IndexedDB
// (database `instar-console`, store `device`), one record per machine of the agent, keyed by the
// machineId the server reports. Every request to a conversation route is signed with it, exactly
// as the iPhone app signs (src/core/MobileDeviceKeys.ts canonicalString / verifyDeviceRequest):
//   instar-device-v1\n<deviceId>\n<host>\n<METHOD>\n<pathWithQuery>\n<timeMs>\n<sha256hex(body)>
// as a strict low-S DER ECDSA-SHA256 signature, base64url, in X-Instar-Device-Sig.
//
// The key is deleted only on a definite answer (§4.6): a ledger revocation from any machine, or a
// decline / expiry / not-found from the machine the key was set up on, or the operator's own Forget
// after a confirmed revoke. A wrong clock, a busy server or another machine answering never wipes it.

export const DB_NAME = 'instar-console';
export const STORE = 'device';
export const SETUP_LOCK = 'instar-browser-setup';
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const P256_HALF_N = P256_N >> 1n;
const enc = new TextEncoder();

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('secure-context-required');
  return c.subtle;
}

/** The key is only used by the console itself: a guard against casual reuse, not a boundary (§4.1). */
export function consolePathAllowed(pathname) {
  return typeof pathname === 'string' && pathname.startsWith('/dashboard/console/');
}

/** A secure context: https, or http on localhost / 127.0.0.1 (§4.1). */
export function secureContextOk(loc = globalThis.location, isSecure = globalThis.isSecureContext) {
  if (isSecure === true) return true;
  if (!loc) return false;
  return loc.protocol === 'https:' || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
}

// ── encodings ────────────────────────────────────────────────────────────
export function b64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data || new ArrayBuffer(0));
  return hex(new Uint8Array(await subtle().digest('SHA-256', bytes)));
}

/** sha256 of the raw key bytes, hex — the ledger's keyHash. */
export async function keyHashOf(publicKeyB64) { return sha256Hex(fromB64url(publicKeyB64)); }
/** First 16 hex of the key hash in groups of four, as the server shows it (deviceFingerprint). */
export async function fingerprintOf(publicKeyB64) {
  return (await keyHashOf(publicKeyB64)).slice(0, 16).toUpperCase().match(/.{4}/g).join('-');
}

// ── signatures ───────────────────────────────────────────────────────────
function bigFrom(u8) { return u8.length ? BigInt('0x' + hex(u8)) : 0n; }
function bytesFrom(n) {
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function derInt(n) {
  let b = bytesFrom(n);
  if (b[0] & 0x80) { const p = new Uint8Array(b.length + 1); p.set(b, 1); b = p; }
  return [0x02, b.length, ...b];
}

/**
 * WebCrypto returns ECDSA signatures as r||s (64 bytes). The server accepts only strict DER with
 * low S, so S above n/2 is replaced by n − S (the same signature, the other valid form).
 */
export function rawSigToLowSDer(raw) {
  const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (u8.length !== 64) throw new Error('unexpected signature length');
  const r = bigFrom(u8.subarray(0, 32));
  let s = bigFrom(u8.subarray(32));
  if (s > P256_HALF_N) s = P256_N - s;
  const body = [...derInt(r), ...derInt(s)];
  return new Uint8Array([0x30, body.length, ...body]);
}

export async function signText(privateKey, text) {
  const raw = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(text));
  return b64url(rawSigToLowSDer(new Uint8Array(raw)));
}

export function canonicalString({ deviceId, host, method, pathWithQuery, timeMs, bodyHash }) {
  return `instar-device-v1\n${deviceId}\n${String(host).toLowerCase()}\n${String(method).toUpperCase()}\n${pathWithQuery}\n${timeMs}\n${bodyHash}`;
}
export const enrollText = ({ host, publicKey, enrollmentId, timeMs }) => `instar-browser-enroll-v1\n${host}\n${publicKey}\n${enrollmentId}\n${timeMs}`;
export const replaceText = ({ oldDeviceId, newPublicKey, host, enrollmentId }) => `instar-browser-replace-v1\n${oldDeviceId}\n${newPublicKey}\n${host}\n${enrollmentId}`;

/** A fresh non-extractable P-256 key; the public half is exported as the raw 65-byte point, base64url. */
export async function generateDeviceKey() {
  const keyPair = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = b64url(new Uint8Array(await subtle().exportKey('raw', keyPair.publicKey)));
  return { keyPair, publicKey };
}

/** `<13-digit ms>-<uuid v4>` (the server's requestId format), time from the corrected clock. */
export function newRequestId(nowMs) {
  const ms = String(Math.floor(nowMs)).padStart(13, '0').slice(-13);
  return `${ms}-${globalThis.crypto.randomUUID()}`;
}
export function requestIdTime(id) {
  const m = /^(\d{13})-/.exec(String(id || ''));
  return m ? Number(m[1]) : null;
}

// ── clock (§4.6) ──────────────────────────────────────────────────────────
/** Keeps an offset from the server's time; signatures, proofs and requestIds use corrected time. */
export function createClock(now = () => Date.now()) {
  let offset = 0;
  return {
    now: () => now() + offset,
    offsetMs: () => offset,
    /** serverTimeMs read between sentAt and receivedAt (local times). */
    observe(serverTimeMs, sentAt, receivedAt) {
      const t = Number(serverTimeMs);
      if (!Number.isFinite(t) || t <= 0) return;
      const mid = Number.isFinite(sentAt) && Number.isFinite(receivedAt) ? (sentAt + receivedAt) / 2 : now();
      offset = Math.round(t - mid);
    },
    observeDateHeader(value, sentAt, receivedAt) {
      const t = Date.parse(value || '');
      // A Date header has one-second resolution: only use it when no better reading exists.
      if (Number.isFinite(t) && offset === 0) this.observe(t, sentAt, receivedAt);
    },
    /** Whole minutes off, when more than two (the page says so; signing still works). */
    skewMinutes() { return Math.abs(offset) > 120_000 ? Math.round(offset / 60_000) : 0; },
  };
}

/** The path and query the server signs over (req.originalUrl), as the browser will send it. */
export function pathWithQueryOf(path, base = globalThis.location ? globalThis.location.origin : 'http://localhost') {
  const u = new URL(path, base);
  return u.pathname + u.search;
}

/** The headers for one signed request. `body` is a string (JSON) or bytes; absent means empty. */
export async function signRequest({ record, privateKey, method, path, body, timeMs }) {
  const bytes = body == null ? new Uint8Array(0) : typeof body === 'string' ? enc.encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body);
  const pathWithQuery = pathWithQueryOf(path);
  const t = String(Math.floor(timeMs));
  const message = canonicalString({ deviceId: record.deviceId, host: record.host, method, pathWithQuery, timeMs: t, bodyHash: await sha256Hex(bytes) });
  return { 'X-Instar-Device': record.deviceId, 'X-Instar-Device-Time': t, 'X-Instar-Device-Sig': await signText(privateKey, message) };
}

// ── IndexedDB (one record per machine) ───────────────────────────────────
function idb() {
  const f = globalThis.indexedDB;
  if (!f) throw new Error('indexeddb-unavailable');
  return f;
}
function openDb() {
  return new Promise((resolve, reject) => {
    const r = idb().open(DB_NAME, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'machineId' }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('indexeddb-open-failed'));
  });
}
async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let out;
      Promise.resolve(fn(store, (v) => { out = v; })).catch(reject);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error || new Error('indexeddb-failed'));
      t.onabort = () => reject(t.error || new Error('indexeddb-aborted'));
    });
  } finally { db.close(); }
}
export function readRecord(machineId) {
  return tx('readonly', (s, set) => { const r = s.get(String(machineId)); r.onsuccess = () => set(r.result || null); });
}
export function readAllRecords() {
  return tx('readonly', (s, set) => { const r = s.getAll(); r.onsuccess = () => set(r.result || []); });
}
export function writeRecord(rec) {
  return tx('readwrite', (s) => { s.put(rec); });
}
export function deleteRecord(machineId) {
  return tx('readwrite', (s) => { s.delete(String(machineId)); });
}

// ── what to do with the stored key (§4.6) ────────────────────────────────
/**
 * Decides from a status answer whether this machine's key is deleted. Pure.
 * `answer` is the GET /mobile/browser-devices/status body; `record` the IndexedDB record.
 * → { action: 'delete' | 'keep', show: 'removed'|'declined'|'expired'|'not-approved'|'elsewhere'|'refused'|'unknown'|'active'|'pending', ... }
 */
export function keyDecision(answer, record) {
  const key = answer && answer.key ? answer.key : null;
  const state = key && typeof key.state === 'string' ? key.state : 'unknown';
  const sameMachine = Boolean(answer && record && answer.machineId && answer.machineId === record.machineId);
  if (state === 'revoked') return { action: 'delete', show: 'removed' };
  if (sameMachine && state === 'declined') return { action: 'delete', show: 'declined' };
  if (sameMachine && state === 'expired') return { action: 'delete', show: 'expired' };
  if (sameMachine && state === 'not-found') return { action: 'delete', show: 'not-approved' };
  if (state === 'elsewhere') return { action: 'keep', show: 'elsewhere', machineId: key.machineId || null, nickname: key.nickname || null };
  if (state === 'declined' || state === 'expired' || state === 'not-found') return { action: 'keep', show: 'elsewhere', machineId: record ? record.machineId : null, nickname: null };
  if (state === 'active') return { action: 'keep', show: 'refused', reason: key.reason || null };
  if (state === 'pending') return { action: 'keep', show: 'pending' };
  return { action: 'keep', show: 'unknown' };
}

/** The words for a deleted key (§4.6). */
export const DELETED_REASON = {
  removed: 'This browser was removed.',
  declined: 'Setting up this browser was declined.',
  expired: 'The approval window ran out — this can also happen when the agent restarts.',
  'not-approved': 'This browser was not approved.',
};

/** "your computer's clock is N minutes off" for a stale-time refusal. */
export function refusalWords(reason, skewMinutes) {
  if (reason === 'stale-time') return `This browser's messages are being refused: your computer's clock is ${Math.abs(skewMinutes) || 'several'} minutes off.`;
  if (reason === 'host-refused') return 'This browser\'s messages are being refused at this address. Open the dashboard at the address you set it up on.';
  if (reason === 'replay') return 'This browser\'s messages are being refused as repeats. Try again.';
  if (reason === 'rate-limited') return 'Too many requests from this browser right now. It will try again shortly.';
  return 'This browser\'s messages are being refused.';
}

// ── the device in use ─────────────────────────────────────────────────────
/**
 * A loaded device: the record for the machine answering this address, its key, and the clock.
 * `bearer()` returns the dashboard token (for the two Bearer routes: setup and status).
 */
export function createBrowserDevice({ bearer, fetchFn = (...a) => globalThis.fetch(...a), clock = createClock(), locks = globalThis.navigator && globalThis.navigator.locks } = {}) {
  let record = null;
  const statusInFlight = new Map(); // keyHash ('' for none) → promise

  const bearerHeaders = () => ({ Authorization: `Bearer ${bearer ? bearer() : ''}` });

  async function readStatus(keyHash) {
    const q = keyHash ? `?keyHash=${encodeURIComponent(keyHash)}` : '';
    const sentAt = Date.now();
    const r = await fetchFn(`/mobile/browser-devices/status${q}`, { headers: bearerHeaders(), cache: 'no-store' });
    const receivedAt = Date.now();
    if (r.status === 503) return { off: true };
    if (!r.ok) return { error: `status-${r.status}` };
    const d = await r.json().catch(() => null);
    if (!d) return { error: 'unreadable' };
    clock.observe(d.serverTime, sentAt, receivedAt);
    return { ok: true, data: d };
  }

  /** One status check at a time per page (§4.6); callers share the answer. */
  function status(keyHash) {
    const k = keyHash || '';
    if (!statusInFlight.has(k)) statusInFlight.set(k, readStatus(keyHash).finally(() => { statusInFlight.delete(k); }));
    return statusInFlight.get(k);
  }

  async function load(machineId) {
    record = machineId ? await readRecord(machineId) : null;
    return record;
  }

  async function signedFetch(method, path, { json, bytes, contentType, signal, headers = {} } = {}) {
    if (!record || !record.keyPair) throw new Error('no-device');
    const body = json !== undefined ? JSON.stringify(json) : bytes !== undefined ? bytes : undefined;
    const h = await signRequest({ record, privateKey: record.keyPair.privateKey, method, path, body, timeMs: clock.now() });
    const ct = json !== undefined ? { 'Content-Type': 'application/json' } : bytes !== undefined ? { 'Content-Type': contentType || 'application/octet-stream' } : {};
    return fetchFn(path, { method, headers: { ...headers, ...ct, ...h }, body, signal, cache: 'no-store' });
  }

  /** Signed JSON call → { ok, status, data }. Network failures come back as status 0. */
  async function call(method, path, opts = {}) {
    let r;
    try { r = await signedFetch(method, path, opts); } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      return { ok: false, status: 0, data: null, networkError: true };
    }
    const retryAfter = Number(r.headers && r.headers.get ? r.headers.get('Retry-After') : NaN);
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data, retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null };
  }

  /**
   * After a 401 from a signed call: ask the status route and delete this machine's key only on a
   * definite answer. Returns the decision (keyDecision) plus `deleted`.
   */
  async function checkAfter401() {
    if (!record) return { action: 'keep', show: 'unknown' };
    const st = await status(record.keyHash);
    if (!st.ok) return { action: 'keep', show: st.off ? 'off' : 'unknown' };
    const d = keyDecision(st.data, record);
    if (d.action === 'delete') { await deleteRecord(record.machineId); record = null; return { ...d, deleted: true }; }
    return d;
  }

  /**
   * Set up this browser (§4.2 client side). `askSession()` returns the operator-session token after
   * the PIN (the cached one is forgotten first). Runs under the Web Lock `instar-browser-setup`.
   * Returns { ok, answer } or { ok: false, status, error, detail }.
   */
  async function setup({ askSession, forgetSession, deviceName, replaceFrom } = {}) {
    const run = async () => {
      const st = await status(null);
      if (!st.ok) return { ok: false, status: st.off ? 503 : 0, error: st.off ? 'browser-devices-off' : 'status-unavailable' };
      const machineId = st.data.machineId;
      let rec = await readRecord(machineId);
      // A record still enrolling is reused: the same key and enrollmentId recover a lost answer (§4.2 step 4).
      if (!rec || !(rec.status === 'enrolling' || rec.status === 'pending' || rec.status === 'active')) {
        const { keyPair, publicKey } = await generateDeviceKey();
        rec = { machineId, keyPair, publicKey, keyHash: await keyHashOf(publicKey), fingerprint: await fingerprintOf(publicKey), enrollmentId: newRequestId(clock.now()), status: 'enrolling', createdAt: new Date().toISOString(), deviceName: deviceName || null };
        await writeRecord(rec); // stored BEFORE sending, so a lost answer never loses the key
      }
      if (rec.status !== 'enrolling') { record = rec; return { ok: true, answer: { deviceId: rec.deviceId, machineId: rec.machineId, host: rec.host, status: rec.status, fingerprint: rec.fingerprint } }; }
      // With a Telegram owner, the owner's approval on the phone or in Telegram is the proof: no PIN
      // (docs/specs/browser-setup-no-second-pin.md). If the server still asks for one (the owner was
      // removed in between), the PIN sheet is shown once.
      if (st.data.approvalPath === 'telegram') {
        const first = await send(rec, null, replaceFrom);
        if (first.ok || first.error !== 'operator-session-required') return first;
      }
      if (forgetSession) forgetSession();
      const session = askSession ? await askSession() : null;
      if (!session) return { ok: false, status: 0, error: 'cancelled' };
      return send(rec, session, replaceFrom);
    };
    return locks && typeof locks.request === 'function' ? locks.request(SETUP_LOCK, run) : run();
  }

  async function send(rec, session, replaceFrom) {
    const started = Date.now();
    for (;;) {
      const timeMs = Math.floor(clock.now());
      // The host the server binds is this page's own address (§4.2 step 2).
      const host = (globalThis.location ? globalThis.location.host : '').toLowerCase();
      const body = { publicKey: rec.publicKey, enrollmentId: rec.enrollmentId, timeMs, proof: await signText(rec.keyPair.privateKey, enrollText({ host, publicKey: rec.publicKey, enrollmentId: rec.enrollmentId, timeMs })) };
      if (rec.deviceName) body.deviceName = rec.deviceName;
      if (replaceFrom && replaceFrom.record && replaceFrom.record.keyPair && replaceFrom.record.deviceId) {
        body.replaces = { deviceId: replaceFrom.record.deviceId, sig: await signText(replaceFrom.record.keyPair.privateKey, replaceText({ oldDeviceId: replaceFrom.record.deviceId, newPublicKey: rec.publicKey, host, enrollmentId: rec.enrollmentId })) };
      }
      let r;
      try {
        r = await fetchFn('/mobile/browser-devices', { method: 'POST', headers: { ...bearerHeaders(), 'Content-Type': 'application/json', ...(session ? { 'X-Instar-Operator-Session': session } : {}) }, body: JSON.stringify(body), cache: 'no-store' });
      } catch {
        // Lost: the same request again recovers it (step 4), with no new PIN.
        if (Date.now() - started > 30_000) return { ok: false, status: 0, error: 'unreachable' };
        await sleep(2000); continue;
      }
      const d = await r.json().catch(() => ({}));
      if (r.status === 202 && d && d.state === 'notifying') {
        if (Date.now() - started > 30_000) return { ok: false, status: 202, error: 'not-delivered', detail: 'The approval message could not be sent.' };
        await sleep(2000); continue;
      }
      if (r.status === 200 || r.status === 201) {
        // The record's machine is the one the setup answer names, not the earlier status read.
        const next = { ...rec, deviceId: d.deviceId, host: d.host, status: d.status, approval: d.approval || null, expiresAt: d.expiresAt || null, fingerprint: d.fingerprint || rec.fingerprint };
        if (d.machineId && d.machineId !== rec.machineId) { await deleteRecord(rec.machineId); next.machineId = d.machineId; }
        await writeRecord(next);
        record = next;
        return { ok: true, answer: d };
      }
      // A refusal: the key was never registered, so it is discarded and the next try starts clean.
      if (r.status !== 429 && r.status !== 503) await deleteRecord(rec.machineId);
      return { ok: false, status: r.status, error: d.error || `http-${r.status}`, detail: d.detail || null, data: d };
    }
  }

  /** Mark the loaded record with a new status (from GET /mobile/device). */
  async function setStatus(s) {
    if (!record) return;
    record = { ...record, status: s };
    await writeRecord(record);
  }

  /** Delete this machine's key (only on a definite answer, or after a confirmed revoke). */
  async function forget() {
    if (!record) return;
    const id = record.machineId;
    record = null;
    await deleteRecord(id);
  }

  /** Forget this browser: self-revoke (signed); on failure the Bearer revoke; the key goes only after a confirmed revoke. */
  async function revokeSelf() {
    if (!record || !record.deviceId) { await forget(); return { ok: true }; }
    const path = `/mobile/devices/${encodeURIComponent(record.deviceId)}/revoke`;
    let res = await call('POST', path, { json: {} });
    if (!res.ok) {
      try {
        const r = await fetchFn(path, { method: 'POST', headers: { ...bearerHeaders(), 'Content-Type': 'application/json' }, body: '{}' });
        res = { ok: r.ok, status: r.status };
      } catch { res = { ok: false, status: 0 }; }
    }
    if (res.ok) await forget();
    return res;
  }

  return {
    clock, status, load, call, signedFetch, setup, setStatus, forget, revokeSelf, checkAfter401,
    get record() { return record; },
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
