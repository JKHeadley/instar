/**
 * CredentialLocationGate — the SINGLE re-routing chokepoint for the §2.2 consumer census
 * (Step 6 of live credential re-pointing).
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §2.2 (the consumer census table).
 *
 * ── What this is ──
 * Every place in the live code that today treats a pool account's enrollment `configHome` as the
 * LIVE location of its credential (the QuotaPoller token read / 401-refresh / email auto-patch /
 * needs-reauth attribution; spawn placement + session attribution; the InUseAccountResolver
 * default badge) is re-routed through ONE gate object instead of reaching into the ledger
 * directly. Centralizing the gate keeps the load-bearing safety contract in a single auditable
 * place — every consumer inherits the same flag-gating, back-compat-on-unknown, and
 * fail-open-loud posture by construction (Structure > Willpower).
 *
 * ── The load-bearing safety contract (spec §2.2; build-prompt invariants 1, 5) ──
 *   1. FLAG-GATED. With `enabled:false` (always, while the feature ships dark) every read returns
 *      the caller's `enrollmentHome` (or null for tenant reads) — byte-for-byte today's behavior.
 *   2. BACK-COMPAT ON UNKNOWN. With the flag ON but the ledger holding no record for that
 *      account/slot (never-seeded), the gate ALSO falls back to today's behavior. The ledger only
 *      ever ADDS truth, never removes the working path.
 *   3. SYNC + FAIL-OPEN-LOUD. `ledger.slotOf/tenantOf` are in-memory sync reads that return null in
 *      UNKNOWN mode (corrupt on-disk state). This gate NEVER throws into a hot path (QuotaPoller /
 *      spawn): on UNKNOWN mode it returns the enrollment fallback AND raises ONE deduped HIGH
 *      attention item naming the degradation, then the caller continues on today's behavior.
 *
 * The gate performs NO credential writes. It is a pure read-router over the ledger + flag.
 */

import type { CredentialLocationLedger } from './CredentialLocationLedger.js';
import { credentialSlotKey } from './OAuthRefresher.js';

/** Attention-item shape (mirrors CredentialLocationLedger.CredentialLedgerAttentionInput). */
export interface CredentialGateAttentionInput {
  id: string;
  title: string;
  summary: string;
  description?: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
}

export interface CredentialLocationGateDeps {
  /**
   * Reads the live `subscriptionPool.credentialRepointing.enabled` flag. Read EACH call (not
   * cached) so a restartless config flip is honored on the next read — the same restartless
   * posture the rest of the feature uses.
   */
  isEnabled: () => boolean;
  /** The machine-local ledger (the single source of truth for "which account is in which slot"). */
  ledger: CredentialLocationLedger;
  /** Emit a deduped HIGH attention item on UNKNOWN-mode degradation (best-effort). */
  emitAttention?: (item: CredentialGateAttentionInput) => void | Promise<void>;
}

/**
 * Re-routes the §2.2 census consumers' `configHome`-as-location reads through the ledger.
 *
 * Construct ONE per process and hand it to each consumer (QuotaPoller, SessionManager spawn,
 * InUseAccountResolver). The consumers stay dumb — they ask the gate "where does account X live
 * now?" and "who tenants slot Y now?" and otherwise behave exactly as today.
 */
export class CredentialLocationGate {
  private readonly isEnabledFn: () => boolean;
  private readonly ledger: CredentialLocationLedger;
  private readonly emitAttention?: (item: CredentialGateAttentionInput) => void | Promise<void>;
  /** Dedupe the UNKNOWN-mode attention item so a read storm raises it once per process. */
  private unknownAttentionRaised = false;

  constructor(deps: CredentialLocationGateDeps) {
    this.isEnabledFn = deps.isEnabled;
    this.ledger = deps.ledger;
    this.emitAttention = deps.emitAttention;
  }

  /** Live flag read — true only when re-pointing is enabled. */
  isEnabled(): boolean {
    return this.isEnabledFn();
  }

  /**
   * The config-home SLOT where `accountId`'s credential CURRENTLY lives.
   *
   * - flag OFF                       → `enrollmentHome` (today's behavior, byte-identical).
   * - flag ON + ledger has a record  → the ledger's current slot for the account.
   * - flag ON + ledger UNKNOWN/empty → `enrollmentHome` (back-compat) AND, if UNKNOWN mode,
   *   one deduped HIGH attention item (fail-open-LOUD). NEVER throws.
   *
   * The returned slot is in the SAME shape the caller passed (a config-home path); it is NOT
   * canonicalized here so a caller that does its own `expandHome` keeps working unchanged.
   */
  slotForAccount(accountId: string, enrollmentHome: string): string {
    if (!this.isEnabledFn()) return enrollmentHome;
    // ledger.slotOf is a sync in-memory read; null in UNKNOWN mode or when never-seeded.
    const slot = this.ledger.slotOf(accountId);
    if (slot) return slot;
    if (this.ledger.isUnknownMode()) this.raiseUnknownModeAttention();
    return enrollmentHome;
  }

  /**
   * The pool account id CURRENTLY tenanting `slot` per the ledger, or null.
   *
   * - flag OFF                       → null (caller keeps its existing attribution path).
   * - flag ON + ledger has a record  → the ledger's tenant account id.
   * - flag ON + ledger UNKNOWN/empty → null (back-compat) AND, if UNKNOWN mode, one deduped HIGH
   *   attention item (fail-open-LOUD). NEVER throws.
   *
   * `slot` is matched against the ledger as-passed; pass the same shape the ledger stores (the
   * consumers use `~/.claude` for the default badge, matching seedFromOracle's slot keys).
   */
  tenantForSlot(slot: string): string | null {
    if (!this.isEnabledFn()) return null;
    const tenant = this.ledger.tenantOf(slot);
    if (tenant) return tenant;
    if (this.ledger.isUnknownMode()) this.raiseUnknownModeAttention();
    return null;
  }

  /**
   * True iff `slot` (any spelling) canonicalizes to the DEFAULT `~/.claude` home. Used by the
   * swap-commit cache-bust: only a swap touching the default slot need bust the in-use badge.
   */
  static touchesDefaultHome(slot: string): boolean {
    return credentialSlotKey(slot) === credentialSlotKey('~/.claude');
  }

  private raiseUnknownModeAttention(): void {
    if (this.unknownAttentionRaised || !this.emitAttention) return;
    this.unknownAttentionRaised = true;
    try {
      void this.emitAttention({
        id: 'credential-location-gate-unknown-mode',
        title: 'Credential location ledger UNKNOWN — consumers fell back to enrollment homes',
        summary:
          'A census consumer (quota poll / spawn placement / in-use badge) read the credential ' +
          'location ledger while it was in UNKNOWN mode (corrupt on-disk state). The read fell ' +
          'back to enrollment-home behavior (no path broke), but credential re-pointing is not ' +
          'authoritative until the ledger is re-seeded via the identity oracle.',
        category: 'credential-repointing',
        priority: 'HIGH',
        sourceContext: 'credential-location-gate',
      });
    } catch {
      // @silent-fallback-ok — the attention emitter is best-effort; a delivery failure must never
      // throw into the QuotaPoller / spawn hot path. The actual safety behavior (the enrollment-
      // home fallback) is already in force regardless of whether the notice was delivered, so the
      // path's correctness does not depend on this emit.
    }
  }
}
