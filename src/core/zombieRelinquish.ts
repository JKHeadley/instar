/**
 * MESH-SELF-HEAL G1 — lease↔job binding via a THREE-SIGNAL liveness model (pure core).
 *
 * Spec: MESH-SELF-HEAL-SPEC §3.1. The DEEPEST fix: the "in charge" lease means two
 * things at once — "I'm the coordinator" AND "I'm actually serving you" — and
 * conflating them is what let the 2026-06-19/27 zombie hold the badge while serving
 * nothing. G1 binds the two: a holder that has stopped doing the JOB must relinquish
 * the badge, decided from THREE machine-local, monotonic liveness signals sourced
 * from the lifeline's ACTUAL-poll truth (FD10: server-intent ≠ lifeline-actual is
 * exactly what hid the incident).
 *
 * This module is the PURE decision (no I/O) so every branch is unit-testable on both
 * sides. The caller supplies freshness booleans (computed by comparing each
 * machine-local monotonic watermark against `jobStaleThresholdMs` on its OWN clock —
 * never a cross-process/cross-machine monotonic subtraction), the debounce result,
 * and POSITIVE peer-evidence of a global outage. It is SIGNAL/decision only; the
 * caller actuates via F3's `relinquishAndBroadcast()` (signed tombstone). Ships DARK.
 *
 * The three signals (all machine-local, evaluated by the machine about ITSELF):
 *   - pollAttemptedMonoMs   — a getUpdates cycle was attempted (alive + trying)
 *   - pollSucceededMonoMs   — a getUpdates response succeeded (channel reachable)
 *   - serveProgressedMonoMs — a fetched update was dispatched/served (end-to-end)
 */

export interface ZombieRelinquishInput {
  /** This machine currently holds the fenced lease. */
  holdsLease: boolean;
  /** The `active` lease role (NOT observe-only/deferential — those are F3's path,
   *  not G1; finding Int-LOW). G1 only ever acts on an active holder. */
  isActiveLeaseRole: boolean;
  /**
   * Updates are PENDING = `lastFetchedUpdateId > lastServedUpdateId` (the two
   * poll-side counters) — NOT serve-queue depth, NOT the Telegram-acked offset
   * (Adv2-F5/Adv3-F-D: the poller advances the offset on FETCH, so "offset not
   * advanced" would falsely read non-pending even when serve silently dropped).
   */
  pending: boolean;
  /** pollAttemptedMonoMs fresh (within jobStaleThresholdMs, own clock). */
  pollAttemptedFresh: boolean;
  /** pollSucceededMonoMs fresh. */
  pollSucceededFresh: boolean;
  /** serveProgressedMonoMs fresh (boot-epoch-fenced — a prior incarnation's stamp
   *  reads as NOT fresh; round-4 Adv4-B). */
  serveProgressedFresh: boolean;
  /** The relevant-staleness has PERSISTED across N fresh evaluator ticks (Adv-F8 —
   *  defeats an evaluator-resume false trip). The caller debounces. */
  staleConfirmed: boolean;
  /**
   * POSITIVE evidence the outage is GLOBAL: a fresh, signed heartbeat from ≥1 live
   * peer in-window that ALSO reports pollSucceeded-stale. "I can't hear any peer"
   * must NEVER set this true (Adv2-F2 — a heartbeat-transport partition is not a
   * global outage; misreading it would HOLD and protect a real zombie).
   */
  peerConfirmsGlobalOutage: boolean;
}

export type ZombieRelinquishAction =
  | 'not-applicable'      // not an active holder — G1 does not act (F3 owns observe-only)
  | 'healthy'             // the relevant liveness signal is fresh — keep serving
  | 'await-confirm'       // relevant-stale but not yet confirmed across N ticks
  | 'hold-global'         // confirmed-stale BUT peer-confirmed global outage → HOLD + route to G2
  | 'relinquish'          // confirmed LOCAL staleness → relinquish (safe direction; G2 backstops)
  | 'relinquish-wedged';  // poll loop itself wedged (pollAttempted stale) → relinquish unconditionally

export interface ZombieRelinquishDecision {
  action: ZombieRelinquishAction;
  /** Should the caller run relinquishAndBroadcast() now? */
  relinquish: boolean;
  /** Short machine-readable reason for the audit log. */
  reason: string;
}

/**
 * Decide whether an active lease-HOLDER is a zombie that must relinquish. Pure;
 * the caller actuates only on `relinquish` (quiesce the renew path + draw a
 * tombstone nonce > the highest it will emit this epoch, then relinquishAndBroadcast).
 */
export function decideZombieRelinquish(input: ZombieRelinquishInput): ZombieRelinquishDecision {
  const {
    holdsLease, isActiveLeaseRole, pending,
    pollAttemptedFresh, pollSucceededFresh, serveProgressedFresh,
    staleConfirmed, peerConfirmsGlobalOutage,
  } = input;

  // G1 only acts on an ACTIVE holder. A non-holder / observe-only / deferential
  // machine is handled elsewhere (F3 / G2), never here.
  if (!holdsLease || !isActiveLeaseRole) {
    return { action: 'not-applicable', relinquish: false, reason: 'not-an-active-holder' };
  }

  // The relevant liveness signal: end-to-end SERVE progress when updates are
  // pending, else the poll-SUCCESS heartbeat when idle (no pending work to serve).
  const relevantStale = pending ? !serveProgressedFresh : !pollSucceededFresh;
  if (!relevantStale) {
    return { action: 'healthy', relinquish: false, reason: pending ? 'serve-progressing' : 'poll-succeeding' };
  }

  // Debounce: a single stale read is not a zombie (an evaluator-resume blip).
  if (!staleConfirmed) {
    return { action: 'await-confirm', relinquish: false, reason: 'stale-not-yet-confirmed' };
  }

  // The poll LOOP itself is wedged (not even attempting) → relinquish unconditionally;
  // a wedged holder serves nothing and HOLD cannot be justified.
  if (!pollAttemptedFresh) {
    return { action: 'relinquish-wedged', relinquish: true, reason: 'poll-loop-wedged-pollattempted-stale' };
  }

  // pollAttempted is fresh (alive + trying) but the channel/serve is stale. Only a
  // POSITIVE peer confirmation that the outage is shared justifies HOLD; absent it,
  // treat as LOCAL failure and relinquish (the safe direction — G2 picks a server).
  if (peerConfirmsGlobalOutage) {
    return { action: 'hold-global', relinquish: false, reason: 'global-outage-peer-confirmed-hold' };
  }
  return { action: 'relinquish', relinquish: true, reason: 'local-failure-relinquish-safe-direction' };
}

/**
 * G1 soak/observability ledger — evaluable evidence (mirrors G2/G3 close-the-loop).
 * Counts each decision-class transition. SIGNAL only.
 */
export interface ZombieRelinquishLedgerSummary {
  evaluations: number;
  relinquishedLocal: number;
  relinquishedWedged: number;
  heldGlobal: number;
  healthy: number;
  awaitConfirm: number;
  firstAt: string | null;
  lastAt: string | null;
}

export class ZombieRelinquishLedger {
  private s: ZombieRelinquishLedgerSummary = {
    evaluations: 0, relinquishedLocal: 0, relinquishedWedged: 0, heldGlobal: 0,
    healthy: 0, awaitConfirm: 0, firstAt: null, lastAt: null,
  };

  record(decision: ZombieRelinquishDecision, nowIso: string): void {
    if (decision.action === 'not-applicable') return; // a non-holder is a non-event
    this.s.evaluations += 1;
    switch (decision.action) {
      case 'relinquish': this.s.relinquishedLocal += 1; break;
      case 'relinquish-wedged': this.s.relinquishedWedged += 1; break;
      case 'hold-global': this.s.heldGlobal += 1; break;
      case 'healthy': this.s.healthy += 1; break;
      case 'await-confirm': this.s.awaitConfirm += 1; break;
    }
    if (this.s.firstAt === null) this.s.firstAt = nowIso;
    this.s.lastAt = nowIso;
  }

  summary(): ZombieRelinquishLedgerSummary {
    return { ...this.s };
  }
}

/** Process-wide shared G1 ledger (mirrors sharedG2NobodyPollingLedger). */
export const sharedG1ZombieRelinquishLedger = new ZombieRelinquishLedger();
