// The one-time local dashboard link, browser side (docs/specs/identity-security-piece1a-local-link.md).
//
// Holds the local credential a redeemed link created (a non-extractable key plus the credential id,
// in this origin's IndexedDB) and adds a signed `localAccess` proof to a dashboard PIN unlock. Every
// dashboard page that posts to /dashboard/unlock goes through `unlockBody` (a ratchet test enforces
// it). The proof only selects the verified-local PIN budget; the PIN is still required.
import { signText } from '/dashboard/console/browser-device.js';

export const DB_NAME = 'instar-local-access';
const STORE = 'credential';
const RECORD = 'current';
const PREFIX = '/local-access/v1';

function idb() { return globalThis.indexedDB || null; }

function openDb() {
  return new Promise((resolve, reject) => {
    const f = idb();
    if (!f) { reject(new Error('indexeddb-unavailable')); return; }
    const r = f.open(DB_NAME, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('indexeddb-open-failed'));
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      let out;
      fn(t.objectStore(STORE), (v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error || new Error('indexeddb-failed'));
      t.onabort = () => reject(t.error || new Error('indexeddb-aborted'));
    });
  } finally { db.close(); }
}

/** Save the credential this page just redeemed (one per origin; a newer one replaces it). */
export function saveCredential(rec) {
  return tx('readwrite', (s) => { s.put(rec, RECORD); });
}

/** The saved credential, if it is still live; null otherwise. Never throws. */
export async function liveCredential(now = Date.now()) {
  try {
    const rec = await tx('readonly', (s, set) => { const r = s.get(RECORD); r.onsuccess = () => set(r.result || null); });
    if (!rec || typeof rec.credentialId !== 'string' || !(rec.expiresAt > now) || !rec.privateKey) return null;
    if (rec.origin !== globalThis.location.origin) return null;
    return rec;
  } catch { return null; }
}

/**
 * The body for POST /dashboard/unlock: `{ pin }`, plus a signed `localAccess` proof when this
 * browser holds a live local credential. Any failure simply leaves the proof out: unlock then
 * follows today's rules.
 */
export async function unlockBody(pin, fetchFn = (...a) => globalThis.fetch(...a)) {
  const body = { pin };
  try {
    const rec = await liveCredential();
    if (!rec) return body;
    const r = await fetchFn(`${PREFIX}/use-challenge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
      body: JSON.stringify({ credentialId: rec.credentialId, action: 'dashboard-unlock' }),
    });
    if (!r.ok) return body;
    const { challenge } = await r.json();
    if (typeof challenge !== 'string') return body;
    const text = `instar-local-use-v1\n${rec.agentName}\n${rec.credentialId}\ndashboard-unlock\n${challenge}\n${rec.origin}\nPOST /dashboard/unlock`;
    body.localAccess = { credentialId: rec.credentialId, challenge, signature: await signText(rec.privateKey, text) };
  } catch { /* the proof is optional: today's rules apply without it */ }
  return body;
}

/**
 * POST /dashboard/unlock with the PIN (and the local proof when this browser holds one). The one
 * place in the dashboard that posts a PIN to the unlock route; returns the fetch Response.
 */
export async function postUnlock(pin, fetchFn = (...a) => globalThis.fetch(...a)) {
  const body = await unlockBody(pin, fetchFn);
  return fetchFn('/dashboard/unlock', {
    method: 'POST', cache: 'no-store', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
