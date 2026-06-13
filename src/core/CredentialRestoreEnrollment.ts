/**
 * CredentialRestoreEnrollment — the teardown lever (spec §2.8, build-plan §7).
 *
 * `POST /credentials/restore-enrollment` moves every slot back to its enrollment layout (N
 * ordinary §2.3 swaps back), then the operator darks the feature — at which point ledger ==
 * enrollment and raw `configHome` reads are truthful again (the ordered-rollback the spec names).
 *
 * This module owns the ONE piece the plain swap executor does not: the per-slot DECISION of
 * whether a slot's current blob may be EXCHANGED back into a healthy enrollment slot, or must be
 * PARKED ONE-DIRECTIONALLY (moved out / the slot vacated for operator re-auth, NEVER exchanged in).
 *
 * ── Why a quarantine bypass that retains everything else (spec §0.g + §2.8) ──
 * restore-enrollment is a TEARDOWN, not a balancing move, so it carries a QUARANTINE BYPASS — it
 * must operate ON quarantined slots (the degraded state rollback exists for), or §2.3 step-1 would
 * hard-block it exactly when it is needed. Per §0.g a bypass drops ONLY the named guard: it RETAINS
 *   1. parse                       (an unparseable blob is parked, never exchanged)
 *   2. refresh-token-present       (a refresh-token-less blob is parked, never exchanged)
 *   3. IDENTITY-COHERENCE          (access-tenant == refresh-lineage; the §2.7 Frankenstein gap)
 *
 * ── The Frankenstein gap (spec §2.8 round-4) ──
 * "Parses + has a refresh token" is NOT sufficient. A legacy `AccountSwitcher` slip can leave
 * B's access token grafted onto A's PRESERVED refresh token: the blob parses, carries a refresh
 * token, and the oracle (on B's still-valid access token) resolves it to B — yet on first refresh
 * the client exchanges A's refresh token and silently resurrects A (a §0.d violation). So before
 * any exchange, the blob's access-token identity (oracle) MUST equal its refresh-token lineage's
 * expected account. A blob that fails coherence — Frankenstein, revoked-grant, access/refresh
 * tenant mismatch — is parked ONE-DIRECTIONALLY exactly like an unparseable one, NEVER exchanged
 * into a healthy slot (a teardown that exchanges garbage into a good slot, then post-commit-verify
 * quarantines THAT slot, would spread corruption during the exact degraded state rollback is for).
 *
 * This module is the DECISION (coherence classification + the park plan). It performs NO keychain
 * writes itself — the route drives the actual exchange through the §2.3 CredentialSwapExecutor and
 * the actual park through the ledger quarantine + an attention item. Pure + injectable.
 */

import type { ClaudeOauth } from './OAuthRefresher.js';

/** The expected refresh-lineage tenant of a slot's blob, and the oracle's access-token identity. */
export interface CoherenceProbe {
  /**
   * The account the blob's ACCESS token resolves to via the identity oracle, or null when the
   * oracle could not confirm it (timeout/401/5xx/etc — §2.11 unavailable, never a guess).
   */
  accessTenant: string | null;
  /**
   * The account the blob's REFRESH-token lineage is EXPECTED to belong to. When the oracle is
   * reachable this is derived from the recorded provenance; when it is down the spec's named cheap
   * proxy applies: the ledger's expected tenant for the slot. null = no expectation available.
   */
  refreshLineage: string | null;
}

export type CoherenceVerdict =
  | { coherent: true; tenant: string }
  | { coherent: false; reason: string; park: 'one-directional' };

/** A parsed blob to classify (the raw is round-tripped by the caller; we only read fields). */
export interface RestoreBlob {
  raw: string;
  oauth: ClaudeOauth | null;
}

/**
 * Classify a slot's current blob for restore-enrollment. Returns a COHERENT verdict (safe to
 * EXCHANGE back to its enrollment slot) ONLY when ALL THREE retained preconditions hold:
 *   parse + refresh-token-present + identity-coherence (accessTenant === refreshLineage).
 * Any failure → an INCOHERENT verdict with `park: 'one-directional'` and a named reason — the
 * caller must vacate the slot for operator re-auth and NEVER exchange this blob into a healthy slot.
 *
 * The oracle-down cheap proxy is the caller's job: it supplies `refreshLineage` from the ledger's
 * expected tenant for the slot, and `accessTenant` may be null (oracle unavailable). When BOTH are
 * known and equal → coherent; when the oracle is down (accessTenant null) we CANNOT certify
 * coherence → one-directional park (the safe direction: never exchange an unverifiable blob).
 */
export function classifyRestoreCoherence(blob: RestoreBlob, probe: CoherenceProbe): CoherenceVerdict {
  // 1. Parse — an unparseable/absent oauth is parked one-directionally.
  if (!blob.oauth || typeof blob.oauth !== 'object') {
    return { coherent: false, reason: 'blob is unparseable or has no claudeAiOauth — parked for re-auth', park: 'one-directional' };
  }
  // 2. Refresh-token-present — a refresh-token-less blob cannot be a healthy lineage.
  if (typeof blob.oauth.refreshToken !== 'string' || !blob.oauth.refreshToken) {
    return { coherent: false, reason: 'blob carries no refresh token — parked for re-auth', park: 'one-directional' };
  }
  // 3. Identity-coherence — access-tenant MUST equal refresh-lineage (the Frankenstein gap).
  if (!probe.accessTenant) {
    // Oracle could not confirm the access-token identity → CANNOT certify coherence. Park (safe
    // direction): never exchange a blob we cannot identity-verify back into a healthy slot.
    return { coherent: false, reason: 'access-token identity unavailable (oracle down) — cannot certify coherence, parked', park: 'one-directional' };
  }
  if (!probe.refreshLineage) {
    return { coherent: false, reason: 'no expected refresh-lineage for slot — cannot certify coherence, parked', park: 'one-directional' };
  }
  if (probe.accessTenant !== probe.refreshLineage) {
    // The §2.7 Frankenstein blob: access resolves to one account, refresh lineage belongs to
    // another. Exchanging it would resurrect the refresh-lineage account on first refresh.
    return {
      coherent: false,
      reason: `identity-incoherent: access-tenant != refresh-lineage — parked one-directionally, never exchanged into a healthy slot`,
      park: 'one-directional',
    };
  }
  return { coherent: true, tenant: probe.accessTenant };
}
