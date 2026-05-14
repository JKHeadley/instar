/**
 * TrustElevationSource — Tier-2 / F-5 of the Self-Healing Remediator v2
 * spec. Authoritative gate for runbook lifecycle transitions.
 *
 * Spec: docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md
 * Anchors: A11 (different-principal commit), A22 (drop git-author-only),
 *          A25 (un-quarantine via authenticated endpoint), A41 (Telegram
 *          countersignature payload binding + user_id principal),
 *          A53 (essential-runbook real second factor), A57 (Tier-2 phase
 *          tiering — TrustElevationSource lives here), A59 (channel
 *          abstraction).
 *
 * The promotion path is asymmetric per the spec's trust-elevation table:
 *
 *   - Proposal → Registered : `/instar-dev` commit + spec-converge
 *                              approval. NO programmatic path. The
 *                              source ALWAYS refuses this transition;
 *                              it can only happen via source-level
 *                              human review.
 *   - Registered → Live      : `collaborative` trust profile AND a
 *                              fresh dry-run trace (≤ 48h) AND ≥ 1 week
 *                              of dry-run history.
 *   - Live → Quarantined     : automatic (pessimistic — always allowed,
 *                              even from `supervised` or below).
 *   - Quarantined → Live     : `collaborative` trust profile AND one
 *                              countersigned approval via a
 *                              `TrustedApprovalChannel`. For ESSENTIAL
 *                              runbooks (A53), TWO channels of
 *                              different kinds are required.
 *   - Live → Deprecated      : `/instar-dev` source change. Source
 *                              always refuses programmatically.
 *   - Deprecated → Removed   : `/instar-dev` source change + migration
 *                              note. Source always refuses
 *                              programmatically.
 *
 * The module exposes ONLY policy decisions. It does NOT mutate runbook
 * registry state — the dispatcher (F-8) consults this source and acts
 * on the boolean / reason it returns. The asymmetric "always allow
 * down" pattern (Live → Quarantined) means a bug in the gate can
 * worsen availability (false quarantines) but cannot escalate
 * authority — and a human is required to un-quarantine regardless.
 */

import type { AutonomyProfileLevel } from '../core/types.js';

// ── Public types ─────────────────────────────────────────────────────

export type RunbookTransition =
  | 'proposal-to-registered'
  | 'registered-to-live'
  | 'live-to-quarantined'
  | 'quarantined-to-live'
  | 'live-to-deprecated'
  | 'deprecated-to-removed';

/**
 * Re-export `AutonomyProfileLevel` so the trust-elevation source is the
 * single import-path for Remediator-side trust policy. Canonical type
 * lives in `src/core/types.ts`.
 */
export type { AutonomyProfileLevel };

/**
 * Approval-verification input shared across channels. Channels MAY
 * ignore fields they don't care about (e.g., a CLI channel doesn't
 * read `messageId`). The dispatcher provides whatever it has.
 */
export interface TrustedApprovalVerifyInput {
  /** Proposal-id when the approval is bound to a candidate-proposal flow (A41). */
  proposalId?: string;
  /** Runbook-id when the approval is bound to a runbook lifecycle action. */
  runbookId?: string;
  /** Action being approved, e.g. 'unquarantine', 'promote-to-live'. */
  action: string;
  /** Channel-specific message-id watermark (A41 replay defence). */
  messageId?: string;
  /** Set true by callers when the runbook is essential (A53). */
  essential?: boolean;
}

/**
 * Channel-side verification result. `approved: false` MAY include a
 * reason string for audit logging; the source does not interpret the
 * reason, only the boolean.
 */
export interface TrustedApprovalVerifyResult {
  approved: boolean;
  /** A41 principal-binding: which user_id (or local-operator id) signed. */
  principalUserId?: string;
  /** Channel-specific reason code for audit (e.g. 'expired', 'replay'). */
  reason?: string;
}

/**
 * `TrustedApprovalChannel` — the abstract approval channel from A59.
 * Concrete implementations: Telegram, Slack, Email, WebAuthn, CLI doctor,
 * Threadline. F-5 ships Telegram + CLI stubs; the rest are
 * Tier-2 follow-ups.
 *
 * Per A59, the source consumes channels through this interface; the
 * config picks one as primary and (for essential un-quarantine) one
 * of a DIFFERENT KIND as secondary. The source enforces the
 * "different-kind" rule by reading `channel.kind`.
 */
export interface TrustedApprovalChannel {
  /** Human-readable instance name for audit logs ('telegram', 'cli-doctor'). */
  readonly name: string;
  /** Channel-kind discriminator used for A53's different-kind requirement. */
  readonly kind: string;
  verifyApproval(input: TrustedApprovalVerifyInput): Promise<TrustedApprovalVerifyResult>;
}

/**
 * Context passed to `canTransition`. Callers supply only the fields
 * relevant to the transition; the source surfaces an explicit
 * `reason` when a required field is missing.
 */
export interface CanTransitionContext {
  /** Age (ms) of the most-recent dry-run trace. Required for registered→live. */
  dryRunTraceAge?: number;
  /** Total dry-run history span (ms). Required for registered→live. */
  dryRunHistoryDays?: number;
  /** Whether the runbook is essential (A53). Triggers two-channel rule. */
  essential?: boolean;
  /** Approval inputs forwarded to channels (A25 / A41 / A53). */
  approval?: TrustedApprovalVerifyInput;
}

export interface CanTransitionResult {
  allowed: boolean;
  /** Stable reason code suitable for audit-log routing. */
  reason: string;
}

export interface TrustElevationSourceOpts {
  profile: AutonomyProfileLevel;
  channels: TrustedApprovalChannel[];
}

// ── Constants ─────────────────────────────────────────────────────────

/** A53: 48h freshness window for the most-recent dry-run trace. */
export const FRESH_TRACE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Spec: ≥ 1 week of dry-run history required for promotion. */
export const MIN_DRY_RUN_HISTORY_DAYS = 7;

/** Numeric trust-level order so we can compare ≥ collaborative. */
const TRUST_LEVEL_ORDER: Record<AutonomyProfileLevel, number> = {
  cautious: 0,
  supervised: 1,
  collaborative: 2,
  autonomous: 3,
};

const COLLABORATIVE_MIN: number = TRUST_LEVEL_ORDER.collaborative;

// ── TrustElevationSource ─────────────────────────────────────────────

export class TrustElevationSource {
  private readonly profile: AutonomyProfileLevel;
  private readonly channels: ReadonlyArray<TrustedApprovalChannel>;

  constructor(opts: TrustElevationSourceOpts) {
    if (!opts || typeof opts.profile !== 'string') {
      throw new Error('TrustElevationSource: profile is required');
    }
    if (!Array.isArray(opts.channels)) {
      throw new Error('TrustElevationSource: channels must be an array');
    }
    this.profile = opts.profile;
    this.channels = opts.channels.slice();
  }

  /**
   * Authoritative gate for runbook lifecycle transitions.
   *
   * Always returns a `{allowed, reason}` shape; never throws on
   * policy-level refusal. Throws only on programmer error (unknown
   * transition kind).
   */
  async canTransition(
    runbookId: string,
    transition: RunbookTransition,
    context: CanTransitionContext = {},
  ): Promise<CanTransitionResult> {
    if (!runbookId || typeof runbookId !== 'string') {
      return { allowed: false, reason: 'runbook-id-required' };
    }

    switch (transition) {
      case 'proposal-to-registered':
        // Spec: only via /instar-dev commit + spec-converge. No
        // programmatic path. The source ALWAYS refuses.
        return {
          allowed: false,
          reason: 'proposal-to-registered-requires-instar-dev-commit',
        };

      case 'live-to-deprecated':
        return {
          allowed: false,
          reason: 'live-to-deprecated-requires-instar-dev-source-change',
        };

      case 'deprecated-to-removed':
        return {
          allowed: false,
          reason: 'deprecated-to-removed-requires-instar-dev-source-change-and-migration-note',
        };

      case 'live-to-quarantined':
        // Pessimistic — always allowed regardless of profile.
        return { allowed: true, reason: 'pessimistic-quarantine-always-allowed' };

      case 'registered-to-live':
        return this.evaluateRegisteredToLive(runbookId, context);

      case 'quarantined-to-live':
        return this.evaluateQuarantinedToLive(runbookId, context);

      default: {
        const exhaustive: never = transition;
        throw new Error(`TrustElevationSource: unknown transition ${String(exhaustive)}`);
      }
    }
  }

  /**
   * A53: essential-runbook un-quarantine requires a real second
   * channel of a DIFFERENT KIND. Returns true when the source has
   * enough distinct-kind channels to satisfy the rule.
   *
   * Non-essential runbooks need exactly one channel.
   */
  async requireSecondChannel(opts: {
    runbookId: string;
    essential: boolean;
  }): Promise<boolean> {
    if (!opts.runbookId) return false;
    if (!opts.essential) {
      return this.channels.length >= 1;
    }
    const distinctKinds = new Set(this.channels.map((c) => c.kind));
    return distinctKinds.size >= 2;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private hasCollaborativeTrust(): boolean {
    return (TRUST_LEVEL_ORDER[this.profile] ?? -1) >= COLLABORATIVE_MIN;
  }

  private async evaluateRegisteredToLive(
    _runbookId: string,
    context: CanTransitionContext,
  ): Promise<CanTransitionResult> {
    if (!this.hasCollaborativeTrust()) {
      return {
        allowed: false,
        reason: `trust-level-below-collaborative:${this.profile}`,
      };
    }
    if (typeof context.dryRunTraceAge !== 'number') {
      return { allowed: false, reason: 'missing-dry-run-trace-age' };
    }
    if (context.dryRunTraceAge > FRESH_TRACE_MAX_AGE_MS) {
      return { allowed: false, reason: 'stale-dry-run-trace' };
    }
    if (typeof context.dryRunHistoryDays !== 'number') {
      return { allowed: false, reason: 'missing-dry-run-history' };
    }
    if (context.dryRunHistoryDays < MIN_DRY_RUN_HISTORY_DAYS) {
      return { allowed: false, reason: 'insufficient-dry-run-history' };
    }
    return { allowed: true, reason: 'registered-to-live-approved' };
  }

  private async evaluateQuarantinedToLive(
    runbookId: string,
    context: CanTransitionContext,
  ): Promise<CanTransitionResult> {
    if (!this.hasCollaborativeTrust()) {
      return {
        allowed: false,
        reason: `trust-level-below-collaborative:${this.profile}`,
      };
    }

    const essential = context.essential === true;
    const haveEnoughChannels = await this.requireSecondChannel({
      runbookId,
      essential,
    });
    if (!haveEnoughChannels) {
      return {
        allowed: false,
        reason: essential
          ? 'essential-unquarantine-no-second-channel'
          : 'unquarantine-no-channel-configured',
      };
    }

    if (!context.approval) {
      return { allowed: false, reason: 'missing-approval-input' };
    }

    // Run all channels concurrently. For essential runbooks we require
    // BOTH a successful approval from at least two DIFFERENT-KIND
    // channels (A53). For non-essential we need exactly one.
    const verifyInput: TrustedApprovalVerifyInput = {
      ...context.approval,
      runbookId,
      essential,
    };

    const channelResults = await Promise.all(
      this.channels.map(async (channel) => ({
        channel,
        result: await channel.verifyApproval(verifyInput),
      })),
    );

    const approvedKinds = new Set<string>();
    for (const { channel, result } of channelResults) {
      if (result.approved) approvedKinds.add(channel.kind);
    }

    if (essential) {
      if (approvedKinds.size < 2) {
        return {
          allowed: false,
          reason: 'essential-unquarantine-requires-two-distinct-channel-approvals',
        };
      }
      return { allowed: true, reason: 'essential-unquarantine-approved-two-channels' };
    }

    if (approvedKinds.size < 1) {
      return { allowed: false, reason: 'unquarantine-no-channel-approved' };
    }
    return { allowed: true, reason: 'unquarantine-approved' };
  }
}
