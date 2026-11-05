/**
 * B1 (multimachine-lease-poll-robustness, Decisions 4/5/7) — the poll-ownership
 * decision: should THIS machine's lifeline start, stop, or hold its Telegram
 * getUpdates poll right now?
 *
 * Poll ownership FOLLOWS the fenced lease (awake → poll) instead of a static
 * boot-time flag — but with ASYMMETRIC hysteresis, because the two error
 * directions are not equal: a SECOND poller (a 409-conflict war / split handling)
 * is the harm, while losing the slot for a moment is safe. So:
 *   - STOP is immediate (lose the lease → stop now).
 *   - START is guarded: never start while another machine is polling (or a 409
 *     says one is), and debounce a flapping intent — UNLESS this is a genuine
 *     failover (the prior awake machine is gone), where silence is the harm and
 *     we start immediately.
 *   - A stale/corrupt/missing intent → HOLD current (never a surprise stop, never
 *     start blind).
 *   - The operator override (force-poll / force-mute) is a LOCAL floor above the
 *     lease intent (Phase-0's pin survives as force-mute).
 *
 * Pure + deterministic → fully unit-testable. The lifeline supplies the inputs
 * (intent file, observed peer poll state, a recent-409 flag, the debounce timer)
 * and applies the returned action.
 */

export type PollAction = 'start' | 'stop' | 'hold';
export type PollOverride = 'force-poll' | 'force-mute' | null;

export interface PollDecisionInputs {
  /** Is the lifeline currently running getUpdates? */
  currentlyPolling: boolean;
  /**
   * The server-written poll intent (from the fenced-lease role). null = the
   * intent file is stale / corrupt / missing / from a prior boot — i.e. "no
   * current opinion".
   */
  intentShouldPoll: boolean | null;
  /** Operator override (local config only). Wins over the lease intent. */
  override: PollOverride;
  /** A peer's pollingActive is observed true RIGHT NOW (don't spawn a 2nd poller). */
  anotherMachinePolling: boolean;
  /** This lifeline recently got a Telegram 409 (someone else is polling the token). */
  recentLocal409: boolean;
  /** The intent has been stably "awake" for ≥ pollStartDebounceMs (rode out a flap). */
  startDebounceElapsed: boolean;
  /** Strong failover signal: the prior awake machine is presumed gone → start NOW. */
  peerPresumedGone: boolean;
}

export function decidePollAction(i: PollDecisionInputs): PollAction {
  // 1. Operator override is the local floor (Phase-0 pin survives as force-mute).
  if (i.override === 'force-mute') return i.currentlyPolling ? 'stop' : 'hold';
  if (i.override === 'force-poll') return i.currentlyPolling ? 'hold' : 'start';

  // 2. No current opinion (stale/corrupt/missing intent) → HOLD. Never a surprise
  //    stop (silence), never start blind.
  if (i.intentShouldPoll === null) return 'hold';

  // 3. Lease says standby → STOP immediately (losing the slot is the safe harm).
  if (i.intentShouldPoll === false) return i.currentlyPolling ? 'stop' : 'hold';

  // 4. Lease says awake.
  if (i.currentlyPolling) return 'hold'; // already the poller — good.

  // START gate — never spawn a SECOND poller.
  if (i.anotherMachinePolling || i.recentLocal409) return 'hold';

  // Genuine failover (prior awake machine gone) → start immediately (silence is
  // the harm). Otherwise wait out the start debounce (ride a flap without
  // thrashing the poll on/off).
  if (i.peerPresumedGone || i.startDebounceElapsed) return 'start';
  return 'hold';
}

/** How long a held boot waits for the lease's opinion before polling as it always did. */
export const BOOT_POLL_HOLD_MAX_MS = 180_000;

/**
 * Does this boot wait for the lease before polling? An absent `telegramPolling` defers to
 * the lease, but the boot path polled before the lease had a say, so a standby took the
 * slot on every start. Only when poll-follows-lease is live (`enabled` already resolved by
 * the caller, `dryRun:false`); `telegramPolling:false` is the force-mute and never polls.
 */
export function holdPollAtBoot(i: { followsLeaseEnabled: boolean; dryRun: boolean | undefined; telegramPolling: boolean | undefined; pollOverride: string | undefined }): boolean {
  if (!i.followsLeaseEnabled || i.dryRun !== false) return false;
  if (i.telegramPolling === false || i.pollOverride === 'force-mute' || i.pollOverride === 'force-poll') return false;
  return true;
}

/**
 * What a held boot does on one reconcile. With an opinion the normal decision runs; the
 * caller ends the hold only once a poll has started or the lease says standby, so an
 * opinion that vanishes still reaches the bound. No opinion past the bound starts the
 * poll: a single machine or a
 * server that never came up writes no intent, and holding forever would be silence. That
 * is the same blind start every boot made before the hold, only later.
 */
export function bootHoldStep(i: { heldSinceMs: number; nowMs: number; intentShouldPoll: boolean | null }): 'wait' | 'release' | 'expired' {
  if (i.intentShouldPoll !== null) return 'release';
  return i.nowMs - i.heldSinceMs >= BOOT_POLL_HOLD_MAX_MS ? 'expired' : 'wait';
}
