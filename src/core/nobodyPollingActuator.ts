/**
 * MESH-SELF-HEAL G2 — enforce-mode ACTUATOR (dependency-injected, testable).
 *
 * Spec: MESH-SELF-HEAL-SPEC §3.2; build plan: MESH-SELF-HEAL-G2-BUILD.md.
 *
 * This is the ENFORCE half of G2: given a `claim` decision from
 * `decideNobodyPollingClaim`, actually take poll-ownership — win the fenced
 * epoch-CAS, RE-VERIFY live local poll-success (CAS-win is necessary-not-sufficient,
 * Adv2-F1), then either start polling (drive the existing poll-follows-lease lever)
 * or relinquish + self-exclude. The delicate cross-machine authority (the exact
 * code whose hasty version caused the 2026-06-27 tug-of-war) is isolated behind
 * INJECTED PORTS so it is unit-testable WITHOUT a live coordinator/lifeline, and so
 * the dryRun gate is a single, auditable chokepoint.
 *
 * Ships DARK + dryRun-first. In dryRun it records "would actuate" and performs ZERO
 * side effects (no CAS acquire, no poll-lever write) — pure observation. Only an
 * explicit `dryRun:false` (the enforce promotion) ever touches the lease or polling.
 *
 * SECOND-PASS REVIEW REQUIRED before merge (this holds poll-ownership authority).
 */

import type { NobodyPollingDecision, NobodyPollingLedger } from './nobodyPollingRecovery.js';
import { decidePostCasSelfReverify } from './nobodyPollingRecovery.js';

/**
 * The minimal authority surface the actuator needs — the real wiring supplies
 * these from MultiMachineCoordinator/LeaseCoordinator/the poll-intent writer.
 * Injected so the actuator is testable against fakes and so EVERY side effect is
 * named + mockable (no hidden I/O).
 */
export interface NobodyPollingActuatorPorts {
  /** Win the fenced epoch-CAS (LeaseCoordinator.acquireIfEligible). True = won. */
  acquireFencedCas: () => Promise<boolean>;
  /** This machine's OWN live poll-success freshness, read AFTER the CAS win. */
  localPollSucceededFresh: () => boolean;
  /** The won epoch (LeaseCoordinator.currentEpoch) — stamped into the poll intent. */
  currentEpoch: () => number;
  /** Start this machine polling: writePollIntent(shouldPoll:true, epoch) — the lever. */
  startPolling: (epoch: number) => void;
  /**
   * Relinquish the just-won epoch (signed tombstone + G1 quiesce) AND advertise
   * pollFresh:false + selfExcludedThisEpisode so peers skip this machine at once.
   */
  relinquishAndSelfExclude: () => void;
}

export type NobodyPollingActuationResult =
  | 'no-action'             // decision wasn't a self-claim — nothing to actuate
  | 'dry-run-would-claim'   // dryRun: would have acquired + served; NO side effect performed
  | 'cas-lost'             // another machine won the fenced epoch first — stand down
  | 'claimed-serving'       // won CAS + self-reverified fit → now polling
  | 'self-excluded';        // won CAS but self-unfit on re-verify → relinquished + excluded

export interface NobodyPollingActuationOutcome {
  result: NobodyPollingActuationResult;
  reason: string;
}

/**
 * Actuate a G2 claim decision. Pure control-flow over injected ports; the only
 * authority is exercised through the ports, and ONLY when `dryRun` is false and the
 * decision is a genuine self-claim. Idempotent per call.
 */
export async function applyNobodyPollingRecovery(args: {
  decision: NobodyPollingDecision;
  dryRun: boolean;
  ports: NobodyPollingActuatorPorts;
  ledger: NobodyPollingLedger;
  nowIso: string;
  log?: (msg: string) => void;
}): Promise<NobodyPollingActuationOutcome> {
  const { decision, dryRun, ports, ledger, nowIso, log } = args;

  // Only a genuine self-claim actuates. stand-down / veto / fail-closed / hold /
  // escalate / await / no-op are non-actuating (the decision recorder already
  // counted them); the actuator must NEVER touch the lease for those.
  if (!decision.selfClaims || decision.action !== 'claim') {
    return { result: 'no-action', reason: `decision=${decision.action}` };
  }

  // DARK / dryRun: observe only. Record the counterfactual; perform NO side effect.
  if (dryRun) {
    log?.(`[g2-actuator] DRY-RUN would claim poll-ownership (epoch n+1) — no CAS, no poll-lever write`);
    return { result: 'dry-run-would-claim', reason: 'dry-run-observe-only' };
  }

  // ENFORCE: win the fenced epoch-CAS. Losing means a peer won the same episode —
  // stand down (the single-claimant invariant holds via the fence, not our guess).
  const won = await ports.acquireFencedCas();
  if (!won) {
    return { result: 'cas-lost', reason: 'another-machine-won-the-fenced-epoch' };
  }

  // CAS-win is necessary but NOT sufficient (Adv2-F1): re-verify OWN live poll
  // freshness (current+local) before committing to serve.
  const reverify = decidePostCasSelfReverify({ localPollSucceededFresh: ports.localPollSucceededFresh() });
  if (!reverify.commit) {
    ports.relinquishAndSelfExclude();
    ledger.recordSelfExclusion(nowIso);
    log?.(`[g2-actuator] won CAS but self-unfit on re-verify → relinquished + self-excluded`);
    return { result: 'self-excluded', reason: reverify.reason };
  }

  // Committed: drive the poll-follows-lease lever to START polling at the won epoch.
  // (The caller's post-claim live-verify confirms lifeline-poll-active.json advances.)
  ports.startPolling(ports.currentEpoch());
  log?.(`[g2-actuator] claimed poll-ownership + started polling at epoch ${ports.currentEpoch()}`);
  return { result: 'claimed-serving', reason: 'cas-won-self-reverified-fit' };
}
