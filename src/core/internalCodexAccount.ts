/**
 * Which pool Codex account an INTERNAL call (sentinels, gates, extractors) runs under.
 *
 * The providers are built early in server boot; the subscription pool much later. This
 * module is the late binding between them: providers are handed `resolveInternalCodexAccount`
 * at build time, and the server sets the source once the pool exists. Until then (or with
 * selection switched off) it answers null, which the provider treats as "the ambient
 * login" — the behavior before this existed.
 *
 * One server per process, so one source per process. Reads are per call, never cached,
 * so a wall or a reset is reflected on the next call.
 *
 * fb-feb1652a-948: a walled ambient login stranded every internal check while other
 * enrolled Codex accounts had room.
 */

import type { CodexCallAccount } from './CodexCliIntelligenceProvider.js';

type Source = () => CodexCallAccount | null;

let source: Source | null = null;
let lastPicked: string | null = null;

/** Set (or clear, with null) where internal Codex calls get their account from. */
export function setInternalCodexAccountSource(next: Source | null): void {
  source = next;
  lastPicked = null;
}

/**
 * The account id the most recent internal call was given, or null when it ran ambient.
 *
 * The router's sibling tail only knows the failed account when the CALLER named one; an
 * internal call's account is chosen inside the provider, so without this the tail could
 * offer the very account that just failed (it is, by construction, the one with the most
 * room). Picks are re-read on every call from slow-moving quota readings, so the latest
 * pick is the account a concurrent failure ran on in practice.
 */
export function lastInternalCodexAccountId(): string | null {
  return lastPicked;
}

/** The account for this call, or null for ambient. Never throws. */
export function resolveInternalCodexAccount(): CodexCallAccount | null {
  if (!source) return null;
  try {
    const picked = source() ?? null;
    lastPicked = picked?.accountId ?? null;
    return picked;
  } catch {
    lastPicked = null;
    /* @silent-fallback-ok: ambient is the previous behavior; losing account
       selection for one call is better than failing the call. */
    return null;
  }
}
