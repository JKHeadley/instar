// Console sign-in from an owner's paired phone (docs/specs/mobile-console-device-signin.md §3.5).
// The Instar app puts a one-minute, single-use ticket in session storage; the console trades it
// once for the same token a PIN unlock returns. Any failure falls back to the PIN box.

import { frontCouldNotReach } from './net-state.js';

export const TICKET_KEY = 'instar_console_ticket';
export const REDEEM_PATH = '/dashboard/console-ticket';

/** Reads the ticket and removes it at once, before any request, on every outcome. */
export function takeTicket(storage) {
  let t = '';
  try { t = storage.getItem(TICKET_KEY) || ''; } catch { t = ''; }
  try { storage.removeItem(TICKET_KEY); } catch { /* storage blocked */ }
  return typeof t === 'string' && t.length > 0 && t.length <= 128 ? t : '';
}

/** POSTs the ticket; resolves to the token, or '' on any failure. */
export async function redeemTicket(fetchFn, ticket) {
  if (!ticket) return '';
  try {
    const r = await fetchFn(REDEEM_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }), cache: 'no-store' });
    if (!r || !r.ok) return '';
    const data = await r.json().catch(() => ({}));
    return data && typeof data.token === 'string' && data.token.length > 0 ? data.token : '';
  } catch { return ''; }
}

/** Only a previously stored sign-in can survive a reachability failure. */
export async function validToken(token, unreachableOk = false, fetchFn = globalThis.fetch) {
  if (!token) return false;
  try {
    const response = await fetchFn('/sessions', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (frontCouldNotReach(response.status)) return unreachableOk;
    if (!unreachableOk && response.headers.has('X-Instar-Saved-At')) return false;
    return response.ok;
  } catch { return unreachableOk; } // @silent-fallback-ok: a network exception preserves only an existing sign-in
}

/**
 * The boot decision: a valid stored token wins; else a ticket is redeemed; else the PIN box.
 * Returns { token, via: 'stored' | 'ticket' | 'pin' }.
 */
export async function signInAtBoot({ storedToken, ticket, fetchFn, validToken: checkStored = (token) => validToken(token, true, fetchFn) }) {
  if (storedToken && await checkStored(storedToken)) return { token: storedToken, via: 'stored' };
  const t = await redeemTicket(fetchFn, ticket);
  if (t) return { token: t, via: 'ticket' };
  return { token: '', via: 'pin' };
}
