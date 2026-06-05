/**
 * Update-notification policy — decides which auto-update notifications reach
 * the user's Updates topic and which are housekeeping (logs only).
 *
 * ## Why this exists
 *
 * The Agent Updates topic was flooding with update *mechanics* — raw version
 * numbers and restart plumbing the user has no use for:
 *
 *   "Just updated to v1.3.217. Restarting to pick up the changes."
 *   "Update to v1.3.217 was applied but I'm still running v1.3.218 —
 *    the next restart should pick it up."
 *   "Update v1.3.215 queued — rolling into the pending restart at 02:21…"
 *
 * None of that is user-relevant; it is operational status that leaked into a
 * user-facing topic. The `user_announcement` / maturity layer
 * (mature-update-announcements spec) made the *feature-announcement* path
 * silent-by-default. This module does the same for the *mechanics* path.
 *
 * ## Policy (option A — full silence, the default)
 *
 * The user hears about an update only when one of these is true:
 *   1. A genuinely new capability shipped — governed ELSEWHERE by the
 *      `user_announcement` front-matter layer, not by this module.
 *   2. A restart is actually interrupting them right now (`interruption`).
 *   3. They must take an action — e.g. a manual update is available and
 *      auto-apply is off (`actionable`).
 *   4. An update is genuinely stuck after retries (`failure-escalated`).
 *
 * Everything else — version churn, restart coordination, transient version
 * skew that self-heals on the next restart — is `mechanics` and goes to the
 * logs only.
 *
 * ## Option B — background-refresh heartbeat
 *
 * Some operators prefer a single, quiet "I just refreshed in the background"
 * note over total silence. That is opt-in via
 * `updates.backgroundRefreshHeartbeat` (default false = option A). When on, it
 * surfaces ONLY the post-restart background-refresh confirmation as a plain,
 * version-free line; every other `mechanics` event stays silent regardless, so
 * the flag can never re-introduce the version-churn flood.
 *
 * Pure module — no I/O, no side effects — so it is trivially unit-testable on
 * both sides of every branch.
 */

export type UpdateNotifyKind =
  | 'mechanics'
  | 'interruption'
  | 'actionable'
  | 'failure-escalated';

export interface UpdateNotifyDecision {
  /** True ⇒ send to the user's Updates topic. False ⇒ log only (housekeeping). */
  reachUser: boolean;
  /** Human-readable rationale — surfaced in logs for the silent path. */
  reason: string;
}

export interface UpdateNotifyPolicyOptions {
  /**
   * Option B: when true, the single background-refresh confirmation is allowed
   * to surface as a quiet heartbeat instead of being fully silent. Default
   * false (= option A, full silence). Has no effect on any other `mechanics`
   * event.
   */
  backgroundRefreshHeartbeat?: boolean;
  /**
   * True only for the specific post-restart "I'm refreshed and current" event.
   * The heartbeat flag is honored ONLY when this is set — every other
   * `mechanics` event ignores the flag and stays silent.
   */
  isBackgroundRefreshConfirmation?: boolean;
}

/**
 * Decide whether an update notification of the given kind should reach the
 * user. See the module header for the full policy.
 */
export function decideUpdateNotify(
  kind: UpdateNotifyKind,
  opts: UpdateNotifyPolicyOptions = {},
): UpdateNotifyDecision {
  switch (kind) {
    case 'interruption':
      return {
        reachUser: true,
        reason: 'a restart is interrupting the user right now',
      };
    case 'actionable':
      return {
        reachUser: true,
        reason: 'the user must take an action (e.g. apply a manual update)',
      };
    case 'failure-escalated':
      return {
        reachUser: true,
        reason: 'an update is genuinely stuck after retries',
      };
    case 'mechanics':
      if (opts.backgroundRefreshHeartbeat && opts.isBackgroundRefreshConfirmation) {
        return {
          reachUser: true,
          reason: 'background-refresh heartbeat enabled (option B)',
        };
      }
      return {
        reachUser: false,
        reason: 'update mechanics — housekeeping, logs only',
      };
    default: {
      // Exhaustiveness guard: an unhandled kind defaults to silent so a new,
      // unaudited notification can never accidentally spam the user.
      const _never: never = kind;
      return {
        reachUser: false,
        reason: `unknown notify kind (${String(_never)}) — defaulting to silent`,
      };
    }
  }
}
