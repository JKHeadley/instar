/**
 * replayPolicy — the pure decision for what to do with a queued message after
 * one forward attempt during lifeline queue replay.
 *
 * Why this exists (2026-06-06 incident, topic 21487 "Initiatives and maturation
 * check-ins"): a user's substantive message was queued while the server was
 * CPU-starved (up enough to pass health, too slow to accept the forward). The
 * old policy used a single counter and incremented it on EVERY failure while
 * `supervisor.healthy` was true — so a slow-but-up server burned all 3 attempts
 * in ~90s and the real message was DROPPED. The user then sent a short nudge,
 * a fresh session spawned with no context, and it confabulated an unrelated
 * status report — the "incoherent reply to a one-message topic" symptom.
 *
 * The fix: distinguish WHY a forward failed.
 *   - 'poison'    → the server actively rejected THIS message (HTTP 400
 *                   bad-request). Message-specific. This — and only this — is
 *                   what the drop budget exists for.
 *   - 'transient' → timeout / 5xx / 503-boot / network refusal / server down.
 *                   A capacity/availability failure that says NOTHING about the
 *                   message. Must NOT burn the poison budget (the false-drop bug).
 *   - 'skew'      → version skew (HTTP 426). Handled out-of-band by a coordinated
 *                   restart; re-queue without burning anything.
 *   - 'ok'        → delivered.
 *
 * A generous transient backstop still bounds unbounded queue growth against a
 * PERMANENT outage (a server that is unreachable forever), but it is set far
 * above any normal restart/starvation window so it never false-drops a real
 * message during a transient episode.
 */

/** Classification of a single forward attempt's result. */
export type ForwardOutcome = 'ok' | 'poison' | 'transient' | 'skew';

/** Replay strike counters carried on a queued message. */
export interface ReplayBudget {
  /** Strikes from genuine HTTP-400 rejections (message-specific / poison). */
  poisonFailures: number;
  /** Strikes from transient capacity/availability failures. */
  transientFailures: number;
}

/** What replay should do with the message after this attempt. */
export interface ReplayDecision {
  action: 'delivered' | 'requeue' | 'drop';
  /** Counters to persist when the action is 'requeue'. */
  poisonFailures: number;
  transientFailures: number;
  /** Honest, human-readable reason when the action is 'drop'. */
  dropReason?: string;
}

/**
 * Max times the SERVER may actively reject a specific message (HTTP 400) before
 * we give up on it. Small — a genuinely malformed forward won't get better.
 */
export const MAX_POISON_REPLAY_FAILURES = 3;

/**
 * Max transient (capacity/availability) failures before we stop re-queuing a
 * message against a PERMANENTLY unreachable server. Deliberately generous: a
 * normal restart or CPU-starvation episode accrues at most a handful of strikes
 * (replay ticks are seconds-to-minutes apart), so this never trips during a
 * real transient outage — it only bounds the pathological forever-down case.
 */
export const MAX_TRANSIENT_REPLAY_FAILURES = 100;

/**
 * Decide the fate of a queued message after one forward attempt. Pure — no I/O,
 * no clock, no instance state. Both sides of every boundary are unit-tested.
 */
export function decideReplay(outcome: ForwardOutcome, budget: ReplayBudget): ReplayDecision {
  const poison = budget.poisonFailures ?? 0;
  const transient = budget.transientFailures ?? 0;

  switch (outcome) {
    case 'ok':
      return { action: 'delivered', poisonFailures: poison, transientFailures: transient };

    case 'skew':
      // Version skew is resolved by a coordinated restart, not by dropping the
      // message. Re-queue without burning any budget (mirrors the in-flight
      // versionSkewActive guard in replayQueue).
      return { action: 'requeue', poisonFailures: poison, transientFailures: transient };

    case 'poison': {
      const next = poison + 1;
      if (next >= MAX_POISON_REPLAY_FAILURES) {
        return {
          action: 'drop',
          poisonFailures: next,
          transientFailures: transient,
          dropReason: `Server rejected the message ${next} times (bad request) — it cannot be delivered as-is`,
        };
      }
      return { action: 'requeue', poisonFailures: next, transientFailures: transient };
    }

    case 'transient': {
      const next = transient + 1;
      if (next >= MAX_TRANSIENT_REPLAY_FAILURES) {
        return {
          action: 'drop',
          poisonFailures: poison,
          transientFailures: next,
          dropReason: `Server was unreachable across ${next} delivery attempts`,
        };
      }
      // The crucial fix: a transient failure NEVER burns the poison budget, so a
      // slow/overloaded/restarting server can no longer drop a real message.
      return { action: 'requeue', poisonFailures: poison, transientFailures: next };
    }
  }
}
