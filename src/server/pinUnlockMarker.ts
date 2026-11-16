/**
 * Prior-unlock marker for the dashboard PIN (docs/specs/dashboard-pin-throttle.md §3).
 *
 * On a successful unlock the server sets an httpOnly, Secure, SameSite=Strict cookie `instar_pin_ok`
 * proving "this browser unlocked before", which lets a returning owner skip the stranger throttle.
 * The value is `<expiryMs>.<id>.<hmac>` where the HMAC covers `<expiryMs>.<id>` and is keyed by a
 * key DERIVED from the agent token (HKDF), never the raw token — so the token is not reused for a
 * second purpose, the expiry cannot be altered, and the whole id is in the signed payload.
 *
 * The marker grants only the throttle bypass; the PIN is still required, so a replayed or forged
 * marker is worthless without the PIN, and it cannot be forged without the derived key. There is no
 * per-cookie revocation other than agent-token rotation, which invalidates every marker at once.
 */

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const PIN_MARKER_COOKIE = 'instar_pin_ok';
const INFO = 'instar-pin-ok-cookie-v1';
const SALT = 'instar-pin-ok-cookie';

function deriveKey(agentToken: string): Buffer {
  // 32-byte key derived from the agent token; a different purpose than the API bearer.
  return Buffer.from(hkdfSync('sha256', Buffer.from(agentToken, 'utf8'), Buffer.from(SALT), Buffer.from(INFO), 32));
}

/** Mint a marker value valid until now + ttlMs. */
export function issuePinMarker(agentToken: string, now: number, ttlMs: number): string {
  const expiry = Math.floor(now + ttlMs);
  const id = randomBytes(16).toString('hex');
  const payload = `${expiry}.${id}`;
  const mac = createHmac('sha256', deriveKey(agentToken)).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

/** If `value` is a well-formed marker, correctly signed for this agent token, and not expired,
 *  return its signed id; otherwise null. The id keys the throttle's marked-abuse accounting, so a
 *  leaked cookie is bounded by ITS OWN failures across any addresses, not per IP. */
export function verifyPinMarker(agentToken: string | undefined, value: unknown, now: number): string | null {
  if (!agentToken || typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [expiryStr, id, macHex] = parts;
  if (!/^\d{1,15}$/.test(expiryStr) || !/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(macHex)) return null;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry <= now) return null;
  const expected = createHmac('sha256', deriveKey(agentToken)).update(`${expiryStr}.${id}`).digest();
  let got: Buffer;
  try { got = Buffer.from(macHex, 'hex'); } catch { return null; }
  if (got.length !== expected.length) return null;
  return timingSafeEqual(got, expected) ? id : null;
}

/** Cookie attributes for Express `res.cookie` (maxAge is MILLISECONDS for Express). */
export function pinMarkerCookieOptions(ttlMs: number): { httpOnly: true; secure: true; sameSite: 'strict'; maxAge: number; path: string } {
  return { httpOnly: true, secure: true, sameSite: 'strict', maxAge: ttlMs, path: '/' };
}
