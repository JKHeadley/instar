/**
 * CredentialLocationResolver — the single read-side chokepoint for "which slot does this account's
 * credential CURRENTLY live in?" (Step 6 of live credential re-pointing, spec §2.2 consumer census).
 *
 * The whole point of the location ledger is that ~12 consumers stop treating a pool account's
 * enrollment `configHome` as its LIVE location (which goes stale the moment a swap re-points it).
 * Rather than each consumer re-implement "is the feature active? if so ask the ledger, else use the
 * enrollment home", they all route through this resolver — Structure beats Willpower.
 *
 * NO-OP WHILE DARK (the load-bearing safety property): the feature ships `enabled:false`, so
 * `active()` is false and every method returns EXACTLY today's behavior (the enrollment home / a null
 * tenant the caller already handles). The ledger is only consulted when the feature is enabled AND
 * the ledger is seeded AND not in UNKNOWN mode — so a dark or unseeded or corrupt ledger can never
 * change a consumer's answer. Re-routing therefore adds zero behavior change until the deliberate
 * two-flag flip, and even then returns today's answer until a real swap has re-pointed something.
 */

import type { CredentialLocationLedger } from './CredentialLocationLedger.js';

/** The slice of `subscriptionPool.credentialRepointing` config the resolver reads. */
export interface CredentialRepointingConfigView {
  enabled?: boolean;
  dryRun?: boolean;
}

export interface CredentialLocationResolverDeps {
  /** The location ledger (Step 2). Only its read surface is used here. */
  ledger: Pick<CredentialLocationLedger, 'slotOf' | 'tenantOf' | 'isSeeded' | 'isUnknownMode'>;
  /**
   * Reads the LIVE `subscriptionPool.credentialRepointing` config each call, so a config change is
   * honored without re-constructing the resolver. Returns undefined when the block is absent.
   */
  config: () => CredentialRepointingConfigView | undefined;
}

export class CredentialLocationResolver {
  private readonly ledger: CredentialLocationResolverDeps['ledger'];
  private readonly config: CredentialLocationResolverDeps['config'];

  constructor(deps: CredentialLocationResolverDeps) {
    this.ledger = deps.ledger;
    this.config = deps.config;
  }

  /** True when the feature's master switch is on (regardless of dry-run — re-routing is a READ). */
  isEnabled(): boolean {
    return this.config()?.enabled === true;
  }

  /**
   * True when the ledger is the authority for location: the feature is enabled AND the ledger has
   * been seeded AND is not in UNKNOWN (corrupt) mode. When false, every consumer keeps today's
   * behavior. This is the single gate the read methods consult.
   */
  active(): boolean {
    return this.isEnabled() && this.ledger.isSeeded() && !this.ledger.isUnknownMode();
  }

  /**
   * The config-home slot an account's credential CURRENTLY occupies. When the ledger is active, the
   * ledger's `slotOf` (falling back to the enrollment home if the ledger somehow lacks the account);
   * otherwise the enrollment home unchanged. Sync + never throws — safe on the spawn hot path.
   */
  slotForAccount(accountId: string, enrollmentHome: string): string {
    if (!this.active()) return enrollmentHome;
    return this.ledger.slotOf(accountId) ?? enrollmentHome;
  }

  /**
   * The account currently tenanting a slot, per the ledger — or null when the ledger is not active
   * (the caller then uses today's behavior). Sync + never throws.
   */
  tenantForSlot(slot: string): string | null {
    if (!this.active()) return null;
    return this.ledger.tenantOf(slot);
  }
}
