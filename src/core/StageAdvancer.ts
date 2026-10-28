/**
 * StageAdvancer — the SOLE writer of `multiMachine.sessionPool.stage` and the
 * mechanical rollout gate (Multi-Machine Session Pool §Rollout). A stage activates
 * ONLY when the prior stage's Tier-3 E2E recorded `green` for the CURRENT commit;
 * otherwise the advance is refused and audited. If a live stage later records `red`,
 * the advancer mechanically REVERTS to the prior (safe) stage. Per "Structure >
 * Willpower" the gate is code, not prose: no other path may flip the stage (enforced
 * by a Config.ts write-guard that only honors writes carrying this module's token).
 */

import type { SessionPoolE2EResultStore } from './SessionPoolE2EResultStore.js';

export const STAGES = ['dark', 'shadow', 'live-transfer', 'rebalance'] as const;
export type SessionPoolStage = (typeof STAGES)[number];

/** Verified reds at a target stage, per build, after which advanceTo stops re-promoting to it. */
export const MAX_TARGET_REDS_PER_COMMIT = 2;

export function stageIndex(stage: SessionPoolStage): number {
  return STAGES.indexOf(stage);
}

export type AdvanceResult =
  | { ok: true; stage: SessionPoolStage }
  | { ok: false; reason: 'e2e-gate-not-passed' | 'already-at-or-past' | 'invalid-stage'; detail?: string };

export interface StageAdvancerDeps {
  resultStore: SessionPoolE2EResultStore;
  /** The commit the running build is on — the E2E result must match it. */
  currentCommitSha: () => string;
  /** Read the current configured stage. */
  readStage: () => SessionPoolStage;
  /** The ONLY stage-config write path. Config.ts must reject writes that don't come through here. */
  writeStageConfig: (stage: SessionPoolStage) => void;
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

export class StageAdvancer {
  constructor(private readonly d: StageAdvancerDeps) {}

  /**
   * Advance to `targetStage`, gated on a matching `green` E2E for the PRIOR stage at
   * the current commit. A missing/`red`/stale-commit/tampered prior result → refused.
   */
  advanceTo(targetStage: SessionPoolStage): AdvanceResult {
    const targetIdx = stageIndex(targetStage);
    if (targetIdx < 0) return { ok: false, reason: 'invalid-stage', detail: String(targetStage) };
    const current = this.d.readStage();
    if (stageIndex(current) >= targetIdx) {
      return { ok: false, reason: 'already-at-or-past', detail: `current=${current}` };
    }
    // 'dark' (index 0) is the floor — there is no prior stage to gate on; you never
    // "advance to dark", you revert to it. So any real advance targets index ≥ 1.
    const priorStageIdx = targetIdx - 1;
    const prior = this.d.resultStore.getLatestForStage(priorStageIdx);
    const sha = this.d.currentCommitSha();
    const gateOk =
      !!prior && prior.result === 'green' && prior.commitSha === sha && this.d.resultStore.verify(prior);
    if (!gateOk) {
      const detail = !prior ? 'no-result' : prior.result !== 'green' ? `result=${prior.result}` : prior.commitSha !== sha ? 'stale-commit' : 'bad-signature';
      this.d.audit?.('stage-advance-refused', { targetStage, priorStage: STAGES[priorStageIdx], reason: 'e2e-gate-not-passed', detail, commitSha: sha });
      return { ok: false, reason: 'e2e-gate-not-passed', detail };
    }
    // Bounded re-promotion (CMT-1117): reconcile() lets a newer prior-stage
    // green supersede an older red at the current stage, so a regression that
    // only shows AT the target stage would otherwise be re-promoted on every
    // lower-stage green. Cap it per build: after MAX_TARGET_REDS_PER_COMMIT
    // verified reds at the target stage for this commit, stop re-promoting until
    // a new build ships.
    // Symmetric to reconcile()'s supersede rule: the promoting green must be
    // NEWER than the target stage's latest same-commit red. Otherwise the tick
    // that demotes on a fresh red would re-promote at once on the older green.
    const targetLatest = this.d.resultStore.getLatestForStage(targetIdx);
    if (
      targetLatest && targetLatest.result === 'red' && targetLatest.commitSha === sha &&
      this.d.resultStore.verify(targetLatest) && !(Date.parse(prior.ranAt) > Date.parse(targetLatest.ranAt))
    ) {
      const detail = 'target-red-newer-than-green';
      this.d.audit?.('stage-advance-refused', { targetStage, priorStage: STAGES[priorStageIdx], reason: 'e2e-gate-not-passed', detail, commitSha: sha });
      return { ok: false, reason: 'e2e-gate-not-passed', detail };
    }
    const targetReds = this.d.resultStore
      .all()
      .filter((r) => r.stage === targetIdx && r.result === 'red' && r.commitSha === sha && this.d.resultStore.verify(r)).length;
    if (targetReds >= MAX_TARGET_REDS_PER_COMMIT) {
      const detail = `target-stage-red-limit:${targetReds}`;
      this.d.audit?.('stage-advance-refused', { targetStage, priorStage: STAGES[priorStageIdx], reason: 'e2e-gate-not-passed', detail, commitSha: sha });
      return { ok: false, reason: 'e2e-gate-not-passed', detail };
    }
    this.d.writeStageConfig(targetStage);
    this.d.audit?.('stage-advanced', { from: current, to: targetStage, commitSha: sha, evidenceRef: prior.evidenceRef });
    return { ok: true, stage: targetStage };
  }

  /**
   * Reconcile on each cycle: if the CURRENT stage's latest E2E is `red` (regression),
   * mechanically revert to the prior stage until a fresh `green` is recorded. Returns
   * the stage after reconciliation.
   */
  /** The stage the config holds right now (a read-back, never a write). */
  currentStage(): SessionPoolStage {
    return this.d.readStage();
  }

  reconcile(): SessionPoolStage {
    const current = this.d.readStage();
    const idx = stageIndex(current);
    if (idx <= 0) return current; // 'dark' is the floor — nothing to revert to
    const latest = this.d.resultStore.getLatestForStage(idx);
    // Only revert on a red for the CURRENT commit — a stale red from a prior commit
    // is not a regression of the running build and must not trigger a revert.
    // (2026-05-29 pre-merge review.)
    const regressed = !!latest && latest.result === 'red' && latest.commitSha === this.d.currentCommitSha() && this.d.resultStore.verify(latest);
    if (regressed) {
      // A red is SUPERSEDED by a newer green at the prior stage for the same
      // commit (CMT-1117). That green is exactly the evidence advanceTo() just
      // promoted on, and the runner records each run against the stage running
      // at the time — so after a revert the current stage's latest row stays
      // the old red until the stage runs again. Without this, every advance on a
      // fresh green was reverted on the next reconcile by that stale red, and the
      // stage flapped dark↔shadow once a minute (69 times on 2026-10-28). A red
      // recorded AFTER the promoting green still reverts, as before.
      const priorGreen = this.d.resultStore.getLatestForStage(idx - 1);
      const superseded =
        !!priorGreen &&
        priorGreen.result === 'green' &&
        priorGreen.commitSha === latest.commitSha &&
        this.d.resultStore.verify(priorGreen) &&
        Date.parse(priorGreen.ranAt) > Date.parse(latest.ranAt);
      if (superseded) {
        this.d.audit?.('stage-revert-superseded', { stage: current, redRanAt: latest.ranAt, greenRanAt: priorGreen.ranAt, evidenceRef: priorGreen.evidenceRef });
        return current;
      }
      const reverted = STAGES[idx - 1];
      this.d.writeStageConfig(reverted);
      this.d.audit?.('stage-reverted', { from: current, to: reverted, reason: 'e2e-red', evidenceRef: latest.evidenceRef });
      return reverted;
    }
    return current;
  }
}
