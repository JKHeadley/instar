/**
 * SlackPrincipalResolver — resolve a VERIFIED Slack user id into a Principal.
 *
 * Identity is bound from the authenticated Slack `U…` id (Know Your Principal),
 * NEVER from a name in message content. An unknown id resolves to an unregistered
 * guest (the gate then refuses any actionable request and routes to registration).
 *
 * Decoupled from core: it depends only on a minimal `UserLookup` interface, which
 * `UserManager` satisfies structurally — so the permission system never imports core.
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.2.
 */

import type { OrgRole, Principal } from './types.js';
import { ORG_ROLES } from './types.js';

/** The minimal user-store shape the resolver needs (UserManager satisfies this). */
export interface ResolvedUserRecord {
  id: string;
  name: string;
  permissions: string[];
  orgRole?: string;
}

export interface UserLookup {
  resolveFromSlackUserId(slackUserId: string): ResolvedUserRecord | null;
}

/** Roles ordered highest → lowest, for "highest permission wins" derivation. */
const ROLE_PRECEDENCE: readonly OrgRole[] = ['owner', 'admin', 'operator', 'contributor', 'member', 'guest'];

/**
 * Derive an OrgRole. An explicit, valid `orgRole` wins; otherwise the highest role
 * named in `permissions` wins; otherwise default to `member` (a registered user is
 * at least a member). Legacy `permissions: ['admin']` therefore maps to admin.
 */
export function deriveRole(permissions: string[] = [], orgRole?: string): OrgRole {
  if (orgRole && (ORG_ROLES as readonly string[]).includes(orgRole)) {
    return orgRole as OrgRole;
  }
  for (const role of ROLE_PRECEDENCE) {
    if (permissions.includes(role)) return role;
  }
  return 'member';
}

export class SlackPrincipalResolver {
  constructor(private readonly users: UserLookup) {}

  /**
   * @param slackUserId the AUTHENTICATED Slack user id (U…) from the event envelope
   * @param displayName display name (for messages only — never a basis for authority)
   */
  resolve(slackUserId: string, displayName = ''): Principal {
    const profile = this.users.resolveFromSlackUserId(slackUserId);
    if (!profile) {
      return {
        userId: null,
        name: displayName || slackUserId,
        slackUserId,
        role: 'guest',
        registered: false,
      };
    }
    return {
      userId: profile.id,
      name: profile.name || displayName || slackUserId,
      slackUserId,
      role: deriveRole(profile.permissions ?? [], profile.orgRole),
      registered: true,
    };
  }
}
