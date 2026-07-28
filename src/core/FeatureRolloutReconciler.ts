/**
 * FeatureRolloutReconciler — makes the InitiativeTracker self-populating
 * (GRADUATED-FEATURE-ROLLOUT-SPEC §4.1). Runs IN-PROCESS against the tracker
 * (the HTTP create surface drops kind/pipelineStage/parentProjectId), upserting
 * a kind:'task' initiative per spec from artifacts that already exist — approved
 * spec frontmatter, instar-dev trace (specPath/prNumber), and git merge state —
 * and attaching a rollout track for ships-staged features whose stage is DERIVED
 * from observing the config flag.
 *
 * The fs/git scanning is injected (`SpecArtifact[]`) so this reconciliation logic
 * is fully unit-testable without a repo. Every tracker write passes `ifMatch`
 * (OCC). Idempotent: re-running upserts, never duplicates. Bounded backfill:
 * historical merged specs register terminal (provenance); only recently-merged
 * or ships-staged specs become `active` tracks (anti-flood).
 */

import type { InitiativeTracker, PipelineStage, Initiative, MaturationEvaluationContract, RolloutAccountingDisposition, MaturationLadderRung } from './InitiativeTracker.js';
import {
  deriveRolloutStage,
  rolloutPhaseStatuses,
  shouldArchiveAtStage,
  isRegression,
  ROLLOUT_PHASE_IDS,
  type RolloutFlagObservation,
} from './featureRollout.js';

/** One spec's artifact state, as discovered by the (injected) scanner. */
export interface SpecArtifact {
  /** Normalized, ≤63-char, kebab id derived from the spec filename. */
  id: string;
  /** Repo-relative spec path (identity for rename detection). */
  specPath: string;
  title: string;
  /** Frontmatter signals. */
  approved: boolean;
  reviewConverged: boolean;
  shipsStaged: boolean;
  /** flagPath + criteria from the spec's `rollout:` frontmatter (ships-staged). */
  flagPath?: string;
  evidenceSource?: { type: 'log-filter' | 'endpoint'; ref: string; filter?: string };
  promotionCriteria?: string;
  maturationEvaluation?: MaturationEvaluationContract;
  maturationContractError?: 'invalid-json' | 'oversized' | 'invalid-shape' | 'unknown-source-ref';
  rolloutDisposition?: RolloutAccountingDisposition;
  sourcePrNumber?: number;
  ownerFeatureId?: string;
  exclusionReason?: string;
  /** An instar-dev trace exists referencing this spec (⇒ at least building). */
  traceExists: boolean;
  prNumber?: number;
  /** Merge commit reachable from main for this spec's change. */
  merged: boolean;
  /** Merge within the recent window (⇒ active track; else terminal provenance). */
  mergedRecently: boolean;
  /** Spec file no longer on disk (abandoned) — §4.7. */
  abandoned?: boolean;
}

export interface ReconcilerDeps {
  tracker: Pick<InitiativeTracker, 'list' | 'get' | 'create' | 'update' | 'setPhaseStatus'>;
  /** Discover spec artifacts (fs + git). Injected for testability. */
  listSpecArtifacts: () => SpecArtifact[];
  /** Observe a feature's flag (live config + shipped default). Read-only. */
  observeFlag: (flagPath: string) => RolloutFlagObservation;
  now?: () => number;
}

/** Map artifact state → the dev pipelineStage (no rollout). */
export function derivePipelineStage(a: SpecArtifact): PipelineStage {
  if (a.abandoned) return 'skipped';
  if (a.merged) return 'merged';
  if (a.traceExists || a.prNumber != null) return 'building';
  if (a.approved) return 'approved';
  if (a.reviewConverged) return 'spec-converged';
  return 'spec-drafted';
}

export interface ReconcileSummary {
  created: string[];
  advanced: string[];
  archived: string[];
  regressed: string[];
  skipped: string[];
  unchanged: string[];
}

export function accountingRung(stage: ReturnType<typeof deriveRolloutStage>): MaturationLadderRung {
  if (stage === 'live') return 'dev-agent-live';
  if (stage === 'default-on') return 'fleet';
  return 'test-agent-live';
}

export class FeatureRolloutReconciler {
  private readonly deps: ReconcilerDeps;
  private readonly now: () => number;

  constructor(deps: ReconcilerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** One reconciliation pass over all discovered specs. Idempotent. */
  async reconcile(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { created: [], advanced: [], archived: [], regressed: [], skipped: [], unchanged: [] };
    // Index existing tasks by specPath for rename detection.
    const bySpecPath = new Map<string, Initiative>();
    for (const init of this.deps.tracker.list()) {
      if (init.kind === 'project') continue;
      if (init.specPath) bySpecPath.set(init.specPath, init);
    }

    for (const art of this.deps.listSpecArtifacts()) {
      try {
        await this.reconcileOne(art, bySpecPath, summary);
      } catch {
        // A single bad spec must not abort the whole pass.
        summary.skipped.push(art.id);
      }
    }
    return summary;
  }

  private async reconcileOne(art: SpecArtifact, bySpecPath: Map<string, Initiative>, summary: ReconcileSummary): Promise<void> {
    const stage = derivePipelineStage(art);
    // Rename detection: an existing record with this specPath wins over id match.
    const existing = bySpecPath.get(art.specPath) ?? this.deps.tracker.get(art.id);

    // Rollout observation (ships-staged + merged only).
    const rolloutEligible = Boolean(art.shipsStaged && art.merged && art.flagPath);
    const observedStage = rolloutEligible ? deriveRolloutStage(this.deps.observeFlag(art.flagPath!)) : undefined;
    const disposition = art.rolloutDisposition ?? (rolloutEligible ? 'active' : undefined);
    const rolloutAccounting = disposition && art.sourcePrNumber
      ? { disposition, sourcePrNumber: art.sourcePrNumber,
        rung: disposition === 'active' && observedStage ? accountingRung(observedStage) : null,
        ownerFeatureId: art.ownerFeatureId ?? (disposition === 'active' ? art.id : undefined), exclusionReason: art.exclusionReason,
        evidenceSource: art.evidenceSource, graduationCriterion: art.promotionCriteria,
        maturationEvaluation: art.maturationEvaluation, maturationContractError: art.maturationContractError }
      : undefined;

    if (!existing) {
      // ── CREATE ──
      // Bounded backfill: a historical (not-recent) merged spec without a live
      // rollout registers TERMINAL (archived, provenance) — not an active card.
      const isActive = !art.merged || art.mergedRecently || rolloutEligible;
      const phaseStatuses = observedStage ? rolloutPhaseStatuses(observedStage) : undefined;
      const phases = rolloutEligible && phaseStatuses
        ? ROLLOUT_PHASE_IDS.map(id => ({ id, name: id, status: phaseStatuses[id] }))
        : [{ id: 'lifecycle', name: stage }];
      await this.deps.tracker.create({
        id: art.id, title: art.title, description: `Auto-registered from ${art.specPath}`,
        phases, kind: 'task', pipelineStage: stage, specPath: art.specPath,
        prNumber: art.prNumber,
        rollout: rolloutEligible
          ? { flagPath: art.flagPath!, stage: observedStage!, evidenceSource: art.evidenceSource, promotionCriteria: art.promotionCriteria, maturationEvaluation: art.maturationEvaluation }
          : undefined,
        rolloutAccounting,
      });
      // default-on parks the track as 'paused' (NON-terminal → reopenable on a
      // later regression; 'archived' maps to TaskFlow's terminal `cancelled`
      // which would seal it). Historical non-rollout backfill uses 'archived'
      // (genuinely terminal provenance, never reopened).
      if (observedStage && shouldArchiveAtStage(observedStage)) {
        await this.deps.tracker.update(art.id, { status: 'paused', ifMatch: this.deps.tracker.get(art.id)?.version });
      } else if (disposition === 'excluded') {
        await this.deps.tracker.update(art.id, { status: 'paused', ifMatch: this.deps.tracker.get(art.id)?.version });
      } else if (!isActive && !rolloutAccounting) {
        await this.deps.tracker.update(art.id, { status: 'archived', ifMatch: this.deps.tracker.get(art.id)?.version });
      }
      summary.created.push(art.id);
      return;
    }

    // ── UPDATE (idempotent + OCC) ──
    const id = existing.id;
    let touched = false;

    // Advance dev pipelineStage when artifacts moved it forward.
    if (existing.pipelineStage !== stage) {
      await this.deps.tracker.update(id, { pipelineStage: stage, prNumber: art.prNumber, ifMatch: this.deps.tracker.get(id)?.version });
      touched = true;
    }

    if (rolloutEligible && observedStage) {
      const prevStage = existing.rollout?.stage;
      if (prevStage && isRegression(prevStage, observedStage)) {
        await this.deps.tracker.update(id, { pipelineStage: 'regressed', status: 'active', ifMatch: this.deps.tracker.get(id)?.version });
        await this.applyRolloutStage(id, observedStage);
        const latest = this.deps.tracker.get(id);
        if (latest?.rolloutAccounting) await this.deps.tracker.update(id, {
          rolloutAccounting: { ...latest.rolloutAccounting, rung: accountingRung(observedStage) }, ifMatch: latest.version,
        });
        summary.regressed.push(id);
        return;
      }
      if (prevStage !== observedStage) {
        await this.applyRolloutStage(id, observedStage);
        const latest = this.deps.tracker.get(id);
        if (latest?.rolloutAccounting) await this.deps.tracker.update(id, {
          rolloutAccounting: { ...latest.rolloutAccounting, rung: accountingRung(observedStage) }, ifMatch: latest.version,
        });
        if (shouldArchiveAtStage(observedStage)) summary.archived.push(id);
        else summary.advanced.push(id);
        return;
      }
      if (JSON.stringify(existing.rollout?.maturationEvaluation) !== JSON.stringify(art.maturationEvaluation)) {
        await this.deps.tracker.update(id, {
          rollout: { ...existing.rollout!, maturationEvaluation: art.maturationEvaluation },
          ifMatch: this.deps.tracker.get(id)?.version,
        });
        summary.advanced.push(id);
        return;
      }
    }

    if (rolloutAccounting && JSON.stringify(existing.rolloutAccounting) !== JSON.stringify(rolloutAccounting)) {
      await this.deps.tracker.update(id, { rolloutAccounting, ifMatch: this.deps.tracker.get(id)?.version });
      summary.advanced.push(id);
      return;
    }

    if (touched) summary.advanced.push(id);
    else summary.unchanged.push(id);
  }

  /** Apply a rollout stage: sync phase statuses + the rollout block; archive
   *  (reopenable) at default-on rather than completing. */
  private async applyRolloutStage(id: string, stage: string): Promise<void> {
    const cur = this.deps.tracker.get(id);
    if (!cur) return;
    const statuses = rolloutPhaseStatuses(stage as never);
    for (const pid of ROLLOUT_PHASE_IDS) {
      const phase = cur.phases.find(p => p.id === pid);
      if (phase && phase.status !== statuses[pid]) {
        await this.deps.tracker.setPhaseStatus(id, pid, statuses[pid]);
      }
    }
    const fresh = this.deps.tracker.get(id);
    await this.deps.tracker.update(id, {
      rollout: { flagPath: fresh?.rollout?.flagPath ?? '', stage: stage as never, evidenceSource: fresh?.rollout?.evidenceSource, promotionCriteria: fresh?.rollout?.promotionCriteria, maturationEvaluation: fresh?.rollout?.maturationEvaluation, lastDigestNotifiedAt: fresh?.rollout?.lastDigestNotifiedAt },
      // 'paused' (non-terminal, reopenable) at default-on — NOT 'archived'
      // (which maps to TaskFlow's terminal `cancelled` and would seal the
      // record against a later regression). 'active' for live/dry-run.
      status: shouldArchiveAtStage(stage as never) ? 'paused' : 'active',
      ifMatch: fresh?.version,
    });
  }
}
