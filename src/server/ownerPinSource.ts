/**
 * identity-security-piece1c: who a signed-in owner-PIN guess belongs to.
 *
 * Behind the auth middleware every caller has already proven something, so the PIN budget is
 * keyed on that credential, never on the socket address (which is 127.0.0.1 for all tunnel
 * traffic). Order (docs/specs/identity-security-piece1c-pin-policy.md, section 1):
 *   1. a dashboard `dst_` session  → its session FAMILY (a refresh grants no fresh guesses);
 *   2. a verified peer machine     → `forwarded:<machine>` (the caller passes it in);
 *   3. a valid remembered-browser cookie (`instar_pin_ok`) → that cookie's id, so the owner's
 *      dashboard (which holds the agent key while scoped sessions are off) is never refused by a
 *      confused local script;
 *   4. otherwise `agent-bearer`, shared by local scripts and sessions.
 */
import type { Request } from 'express';
import { PIN_MARKER_COOKIE, verifyPinMarker } from './pinUnlockMarker.js';

export interface OwnerPinSourceDeps {
  agentToken: () => unknown;
  dashboardSessionFamily?: (token: string) => string | null;
}

function markerId(req: Request, agentToken: unknown): string | null {
  if (typeof agentToken !== 'string' || !agentToken) return null;
  const raw = String(req.headers.cookie ?? '');
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(PIN_MARKER_COOKIE + '='));
  if (!hit) return null;
  let value: string;
  try { value = decodeURIComponent(hit.slice(PIN_MARKER_COOKIE.length + 1)); } catch { return null; } // @silent-fallback-ok — a malformed cookie is no marker
  return verifyPinMarker(agentToken, value, Date.now());
}

/** Set by the server: the live dashboard session store's token → family lookup. */
let registeredFamilyLookup: ((token: string) => string | null) | null = null;
export function setDashboardSessionFamilyLookup(fn: ((token: string) => string | null) | null): void { registeredFamilyLookup = fn; }

export function signedInPinSource(req: Request, deps: OwnerPinSourceDeps, forwardedBucketKey?: string): string {
  const auth = String(req.headers.authorization ?? '');
  if (auth.startsWith('Bearer dst_')) {
    const lookup = deps.dashboardSessionFamily ?? registeredFamilyLookup;
    let family: string | null = null;
    try { family = lookup?.(auth.slice(7)) ?? null; } catch { family = null; /* @silent-fallback-ok: an unresolvable session falls through to the next key, never a crash */ }
    if (family) return `session:${family}`;
  }
  if (forwardedBucketKey) return forwardedBucketKey;
  const marker = markerId(req, deps.agentToken());
  if (marker) return `browser:${marker}`;
  return 'agent-bearer';
}
