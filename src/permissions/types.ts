/**
 * Slack organizational permission system — core types.
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md (Pillar 2).
 *
 * The model composes three orthogonal questions:
 *   who is this (identity)  ·  what may they do (authority)  ·  does this feel like them (relationship)
 *
 * Slice 0 (this module + RolePolicy + SlackPermissionGate) implements the
 * authority axis end-to-end for one floor action (prod deploy), with a
 * relationship-anomaly step-up hook. Enforcement is OBSERVE-ONLY first.
 */

/** Organizational role, lowest → highest authority. */
export type OrgRole = 'guest' | 'member' | 'contributor' | 'operator' | 'admin' | 'owner';

export const ORG_ROLES: readonly OrgRole[] = [
  'guest',
  'member',
  'contributor',
  'operator',
  'admin',
  'owner',
];

/**
 * Action sensitivity tier.
 *   T0 ambient    — being present / listening / reacting; no action
 *   T1 read       — summarize, answer, look up, draft (not send)
 *   T2 low-write  — post a message/doc she authored, file a ticket
 *   T3 operational— run a job, modify non-prod, schedule, small spend
 *   T4 privileged — the floor: money / prod-deploy / credentials / destructive / external / grant
 */
export type SensitivityTier = 0 | 1 | 2 | 3 | 4;

/** The verdict the permission gate returns for a (principal, request) pair. */
export type PermissionDecision = 'allow' | 'clarify' | 'refuse' | 'step-up';

/**
 * Enumerated floor actions — NEVER discretionary (Layer 0). Each requires an
 * explicit verified grant (owner role, or a Coordination Mandate). No amount of
 * persuasive phrasing reaches one of these without a real grant.
 */
export type FloorAction =
  | 'money-movement'
  | 'prod-deploy'
  | 'credential-access'
  | 'destructive-data'
  | 'external-send'
  | 'grant-authority';

/**
 * The VERIFIED principal making a request. Resolved from authenticated identity
 * (a Slack `U…` id), NEVER from a name that appears in message content
 * (Know Your Principal).
 */
export interface Principal {
  /** Stable instar user id, or null if unregistered. */
  userId: string | null;
  /** Display name — for messages only; never a basis for authority. */
  name: string;
  /** Authenticated Slack user id (U…) — the basis of identity. */
  slackUserId?: string;
  /** Resolved org role; 'guest' when unregistered. */
  role: OrgRole;
  /** True iff this principal is registered in the user store. */
  registered: boolean;
}

/** The interpreted request (output of the intent classifier). */
export interface RequestIntent {
  /** Short action label, e.g. 'prod-deploy', 'summarize', 'send-draft', 'ambiguous'. */
  action: string;
  /** Sensitivity tier of the action. */
  tier: SensitivityTier;
  /** If this maps to an enumerated floor action, which one. */
  floorAction?: FloorAction;
  /** Classifier confidence in [0,1]. Low confidence on a possibly-floor action → clarify. */
  confidence: number;
  /**
   * Was the request DIRECTED at the agent (a mention or a clear ask)? Overheard
   * channel chatter is context, never command (§6.9) — an undirected actionable
   * request is never authorized.
   */
  directed: boolean;
}

/** Relationship/behavioral anomaly assessment for this principal+request. */
export interface AnomalyAssessment {
  /** 0 (perfectly in character) .. 1 (wildly out of character). */
  score: number;
  /** Human-readable reasons contributing to the score. */
  reasons: string[];
}

/** The full verdict returned by the gate. */
export interface PermissionVerdict {
  decision: PermissionDecision;
  /**
   * Machine-readable basis code:
   *   'within-authority' | 'role-ceiling' | 'floor-no-grant' | 'floor-granted'
   *   | 'ambiguous-intent' | 'anomaly-stepup' | 'overheard' | 'unregistered'
   *   | 'content-name-not-authority'
   */
  basis: string;
  /** Conversational message to send back (refusal/clarify/step-up text). Empty for a clean allow. */
  message: string;
  /** For a step-up decision: the suggested out-of-band channel(s) and why. */
  stepUp?: { channels: string[]; reason: string };
  principal: Principal;
  intent: RequestIntent;
  anomaly?: AnomalyAssessment;
  /** ISO timestamp. */
  evaluatedAt: string;
}

/** A grant that lifts a principal above their role ceiling (or authorizes a floor action). */
export interface AuthorityGrant {
  /** The floor action (or 'tier:N') this grant authorizes. */
  scope: FloorAction | `tier:${SensitivityTier}`;
  /** The slackUserId this grant is for. */
  grantedTo: string;
  /** Who authorized it (must differ from grantedTo — requester ≠ authorizer). */
  authorizedBy: string;
  /** Epoch ms after which the grant is void. */
  expiresAt: number;
}
