/**
 * MandateBackedGrantStore — resolves a Slack FLOOR-action grant for a verified
 * principal from the SIGNED Coordination Mandate(s).
 *
 * This is the production `GrantStore` for `SlackPermissionGate`: instead of an
 * ad-hoc grant table, a floor-action grant is a `UserAuthorityGrant` carried inside
 * a mandate and covered by the mandate's `authProof`. That makes the grant:
 *   - deny-by-default     (no mandate / no matching grant → undefined → refuse)
 *   - signed              (an agent cannot mint or widen a grant; only the PIN-gated
 *                          issuance/grant route can sign one in)
 *   - bounded + expiring  (the grant has its own expiry, clamped to never outlive the
 *                          mandate that carries it)
 *   - revocable           (revoking the mandate voids every grant it carries)
 *
 * `activeGrant` returns a grant ONLY when, for a mandate that is authorship-valid,
 * not expired, and not revoked, there exists a grant whose `grantedTo` equals the
 * verified Slack user id, whose `floorAction` equals the requested scope, and whose
 * effective expiry (min of grant.expiresAt and mandate.expiresAt) is still in the
 * future. Otherwise `undefined` — the gate then falls back to the role floor.
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md (Pillar 2, floor grants) +
 * docs/specs/coordination-mandate.md (the signed-delegation model the grant rides on).
 */

import type { GrantStore } from './SlackPermissionGate.js';
import type { AuthorityGrant, FloorAction, SensitivityTier } from './types.js';
import type { MandateStore } from '../coordination/MandateStore.js';

export interface MandateBackedGrantStoreDeps {
  /** The signed mandate store the grants live in. */
  store: MandateStore;
}

export class MandateBackedGrantStore implements GrantStore {
  private readonly store: MandateStore;
  constructor(deps: MandateBackedGrantStoreDeps) {
    this.store = deps.store;
  }

  /**
   * Resolve an active floor-action grant for `slackUserId` + `scope` as of `now` (ms).
   * Returns the FIRST matching grant across all mandates; `undefined` if none.
   */
  activeGrant(slackUserId: string, scope: string, now: number): AuthorityGrant | undefined {
    if (!slackUserId || !scope) return undefined;

    for (const mandate of this.store.list()) {
      // Deny-by-default: a mandate must be authorship-valid, unrevoked, and unexpired
      // before ANY grant it carries can be honored.
      if (mandate.revoked) continue;
      if (!this.store.verifyAuthorship(mandate)) continue;
      const mandateExpiryMs = Date.parse(mandate.expiresAt);
      if (isNaN(mandateExpiryMs) || mandateExpiryMs <= now) continue;

      const grants = mandate.grants;
      if (!Array.isArray(grants) || grants.length === 0) continue;

      for (const g of grants) {
        if (g.grantedTo !== slackUserId) continue;
        if (g.floorAction !== scope) continue;
        const grantExpiryMs = Date.parse(g.expiresAt);
        if (isNaN(grantExpiryMs)) continue;
        // The grant is void the moment EITHER clock passes — clamp to the mandate.
        const effectiveExpiryMs = Math.min(grantExpiryMs, mandateExpiryMs);
        if (effectiveExpiryMs <= now) continue;

        return {
          scope: scope as FloorAction | `tier:${SensitivityTier}`,
          grantedTo: g.grantedTo,
          authorizedBy: g.authorizedBy,
          expiresAt: effectiveExpiryMs,
        };
      }
    }

    return undefined;
  }
}
