/**
 * RolePolicy — the deterministic role→authority model (Layer 0 + role ceilings).
 *
 * Pure, synchronous, fully unit-testable. No LLM, no I/O. This is the part of the
 * permission system that is STRUCTURE, not judgment: the floor and the role
 * ceilings are enumerated here and cannot be talked around.
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.4–6.6.
 */

import type { OrgRole, SensitivityTier, FloorAction } from './types.js';

/** Default ceiling tier per role — the highest tier a role may authorize on its own. */
const DEFAULT_ROLE_CEILING: Record<OrgRole, SensitivityTier> = {
  guest: 0, // can be heard; cannot direct actions
  member: 1, // reads, summaries, drafts
  contributor: 2, // low-risk writes
  operator: 3, // operational actions (non-prod)
  admin: 4, // everything EXCEPT the floor without a grant (see canAuthorizeFloor)
  owner: 4, // everything, and may authorize floor actions + issue grants
};

/**
 * Roles that may authorize a FLOOR action without a separate grant. By default
 * ONLY the owner. An `admin` has a T4 ceiling but still cannot reach a floor
 * action without a grant — the floor is a harder boundary than the tier ceiling.
 */
const DEFAULT_FLOOR_AUTHORIZED_ROLES: readonly OrgRole[] = ['owner'];

/** The enumerated floor — actions that are NEVER discretionary (Layer 0). */
export const FLOOR_ACTIONS: readonly FloorAction[] = [
  'money-movement',
  'prod-deploy',
  'credential-access',
  'destructive-data',
  'external-send',
  'grant-authority',
];

export function isFloorAction(x: string | undefined | null): x is FloorAction {
  return !!x && (FLOOR_ACTIONS as readonly string[]).includes(x);
}

export interface RolePolicyConfig {
  /** Override one or more role ceilings (org-configurable). */
  roleCeilings?: Partial<Record<OrgRole, SensitivityTier>>;
  /** Override which roles may authorize floor actions without a grant. */
  floorAuthorizedRoles?: OrgRole[];
}

export class RolePolicy {
  private readonly ceilings: Record<OrgRole, SensitivityTier>;
  private readonly floorRoles: ReadonlySet<OrgRole>;

  constructor(config: RolePolicyConfig = {}) {
    this.ceilings = { ...DEFAULT_ROLE_CEILING, ...(config.roleCeilings ?? {}) };
    this.floorRoles = new Set(config.floorAuthorizedRoles ?? DEFAULT_FLOOR_AUTHORIZED_ROLES);
  }

  /** The highest tier this role may authorize on its own. */
  ceilingForRole(role: OrgRole): SensitivityTier {
    return this.ceilings[role] ?? 0;
  }

  /** Does this role's ceiling cover the requested tier? */
  roleCoversTier(role: OrgRole, tier: SensitivityTier): boolean {
    return this.ceilingForRole(role) >= tier;
  }

  /**
   * May this role authorize a FLOOR action without a separate grant?
   * Default: only `owner`. (An `admin` has a T4 ceiling but is NOT floor-authorized.)
   */
  roleCanAuthorizeFloor(role: OrgRole): boolean {
    return this.floorRoles.has(role);
  }
}
