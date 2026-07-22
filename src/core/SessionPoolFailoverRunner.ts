/**
 * SessionPoolFailoverRunner — the in-agent PRODUCER of a real failover E2E result
 * for the Multi-Machine Session Pool rollout gate (§Rollout, Track H).
 *
 * The gate is a two-part machine:
 *   - `SessionPoolE2EResultStore` holds the signed Tier-3 E2E verdict per stage.
 *   - `StageAdvancer` promotes shadow→live-transfer ONLY on a green prior-stage
 *     E2E for the CURRENT commit, and auto-reverts on red.
 *   - `SessionPoolRolloutDriver` (the cadenced driver) turns a recorded green into
 *     an actual promotion toward an operator ceiling.
 *
 * What was missing (the track-H "real-hardware / test-as-self proof" follow-up):
 * the store is written by the vitest failover E2E in CI, but a DEPLOYED agent has
 * no green of its OWN — nothing inside a running agent proves that agent's actual
 * shipped code can fail a live conversation over to its standby and records that
 * proof. Without an in-agent green, the driver has nothing to promote, so a
 * deployed agent's sessionPool stays at `shadow` forever (the 2026-07-22 overnight
 * incident: a mentee agent sat at watch-only, so when its primary machine slept the
 * standby could not take over).
 *
 * This runner closes that gap. On each `tick()` it runs an injected failover CHECK
 * and, on a genuine pass, records a `green` for the proven stage into the E2E store
 * — the honest, self-earned proof the driver needs to promote the agent.
 *
 * ── Honesty line (load-bearing) ──
 * A `green` is recorded ONLY from a genuine `green` verdict returned by the check.
 *   - check → 'green'  ⇒ record green   (the agent proved its own failover)
 *   - check → 'red'    ⇒ record red     (a real regression — the driver auto-reverts)
 *   - check THROWS      ⇒ record NOTHING (an infra/availability error is NOT a
 *                        failover verdict; recording a fabricated green would wrongly
 *                        promote, recording a fabricated red would wrongly demote —
 *                        so a throw yields NO verdict and the stage is untouched).
 * A green feeds a promotion, so the runner NEVER manufactures one from silence.
 *
 * ── Dark by default (real authority) ──
 * A recorded green can promote the agent's sessionPool stage — real authority, same
 * class as the driver and the reactive swap. So the runner is a strict no-op unless
 * `enabled()` is true. The decision core is pure (the two-node failover CHECK is
 * injected) so it tests with zero sessions and zero network; the heavy in-process
 * two-node check is supplied by the caller in production (a follow-up increment) and
 * a deterministic fake in tests.
 *
 * ── v1 scope ──
 * The runner ORCHESTRATES (gate → run check → record verdict honestly). It does not
 * itself implement the two-node failover; that check is injected. This mirrors how
 * `SessionPoolRolloutDriver` takes an injected `StageAdvancer` rather than embedding
 * the stage machine.
 */

import type { SessionPoolE2EResultStore, StageE2EOutcome } from './SessionPoolE2EResultStore.js';

/** The verdict of one in-agent failover check run. */
export interface FailoverCheckResult {
  /** 'green' = the agent failed a live conversation over to its standby and it resumed. */
  outcome: StageE2EOutcome;
  /** A durable, human-traceable pointer to the run (log path, run id, artifact ref). */
  evidenceRef: string;
}

export interface SessionPoolFailoverRunnerDeps {
  /** The signed E2E result store — the ONLY writer path the runner uses. */
  resultStore: SessionPoolE2EResultStore;
  /**
   * The in-agent failover check. Resolves to a verdict on a genuine run; REJECTS on
   * an infra/availability error (which the runner treats as "no verdict", not red).
   */
  runFailoverCheck: () => Promise<FailoverCheckResult>;
  /** The commit the running build is on — the recorded verdict is bound to it. */
  currentCommitSha: () => string;
  /**
   * The stage index this failover proves — the PRIOR stage whose green gates the
   * next advance (e.g. the shadow→live-transfer failover is recorded at the
   * `shadow` index, which `StageAdvancer.advanceTo('live-transfer')` reads).
   */
  provenStage: () => number;
  /** Dark-by-default master switch: the whole tick is a no-op unless this is true. */
  enabled: () => boolean;
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

export interface FailoverRunTickResult {
  /** false ⇒ the runner was disabled and did nothing. */
  ran: boolean;
  /** The verdict recorded, or 'error' when the check threw (nothing recorded), or null when disabled. */
  outcome: StageE2EOutcome | 'error' | null;
  /** true ⇒ a verdict row was written to the store this tick. */
  recorded: boolean;
}

export class SessionPoolFailoverRunner {
  constructor(private readonly d: SessionPoolFailoverRunnerDeps) {}

  /**
   * Run one failover check and record its verdict honestly. Dark-by-default; a
   * throwing check records NOTHING (no fabricated verdict).
   */
  async tick(): Promise<FailoverRunTickResult> {
    if (!this.d.enabled()) {
      return { ran: false, outcome: null, recorded: false };
    }
    const stage = this.d.provenStage();
    const sha = this.d.currentCommitSha();
    let result: FailoverCheckResult;
    try {
      result = await this.d.runFailoverCheck();
    } catch (err) {
      // An infra/availability error is NOT a failover verdict — record nothing so
      // the stage is neither wrongly promoted (fabricated green) nor wrongly
      // demoted (fabricated red). The next tick re-runs the check.
      this.d.audit?.('failover-check-errored', {
        provenStage: stage,
        commitSha: sha,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ran: true, outcome: 'error', recorded: false };
    }
    this.d.resultStore.recordResult(stage, result.outcome, sha, result.evidenceRef);
    this.d.audit?.('failover-result-recorded', {
      provenStage: stage,
      commitSha: sha,
      outcome: result.outcome,
      evidenceRef: result.evidenceRef,
    });
    return { ran: true, outcome: result.outcome, recorded: true };
  }
}
