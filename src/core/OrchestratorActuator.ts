/**
 * OrchestratorActuator — the guarded actuation layer for the seamless orchestrator
 * (spec: llm-seamlessness-orchestrator.md, Phase 2 + Phase 3 dry-run gate).
 *
 * The engine (SeamlessOrchestratorEngine) PRODUCES proposals; this layer decides whether
 * each one may act, AUDITS the decision BEFORE acting (so a crash mid-action leaves a
 * trace), and — for the ONE ever-auto action, a side-effect-free `auto-prefetch` — executes
 * it via the working-set fetch. A `placement-signal` NEVER moves anything: it only writes
 * structured evidence into the deterministic planner's policy input (the planner alone
 * decides moves, F3).
 *
 * Actuation guards (Design §Actuation guards), applied to EVERY proposal:
 *  - Re-validate at execute (compare-and-act): a stale read is never ground truth — live
 *    ownership/pin/episode is re-checked here, not trusted from the engine's read time.
 *  - Yield to failure-movement: refuse any proposal for a topic in an active stale-owner-
 *    release / lease-handback / lease-flap / splitBrain episode (failure movement wins).
 *  - Respect pins + provenance: never actuate for a `pinned` or recently-user-moved topic.
 *  - Audit-BEFORE-actuate to `logs/orchestrator-actions.jsonl` (machine-local).
 *
 * `auto-prefetch` side-effect-free contract (Design §invariants): bounded by a per-window
 * disk-byte budget; inherits the coordinator's secretFlagged/tooLarge/oversized refusals;
 * only a local copy lands (no ownership/lease mutation). Enforced here via the budget check
 * + the injected fetch seam (which carries the coordinator's own refusals).
 *
 * dryRun (P3 soak): every admissible proposal is logged as `would-actuate` and actuates
 * NOTHING. The dry-run audit trail IS the soak evidence for the operator-only live flip.
 */
import type { OrchestratorAction, OrchestratorAuthority, OrchestratorProposal } from './SeamlessOrchestratorEngine.js';

/** Live placement facts for a topic, re-read at execute time (compare-and-act). */
export interface TopicPlacementView {
  pinned: boolean;
  /** the topic was moved by the user recently (provenance) — never override a human move. */
  recentlyUserMoved: boolean;
  /** the topic is in an active stale-owner-release / lease-handback / lease-flap / splitBrain episode. */
  inFailureEpisode: boolean;
}

/** The outcome of a real working-set fetch (mirrors the coordinator's FetchOutcome shape, loosely). */
export interface FetchOutcome {
  ok: boolean;
  skipReason?: string;
  bytes?: number;
}

/** One machine-local audit row (logs/orchestrator-actions.jsonl). */
export interface ActuationAuditEntry {
  ts: string;
  action: OrchestratorAction;
  targetTopic: number;
  detail: string;
  authorityLevel: OrchestratorAuthority;
  decision: ActuationDecision;
  refusalReason?: string;
  dryRun: boolean;
  bytes?: number;
}

export type ActuationDecision = 'would-actuate' | 'actuated' | 'refused' | 'signal-recorded' | 'would-signal';

export interface ActuatorDeps {
  /** re-validate at execute (compare-and-act) — live ownership/pin/episode for the topic. */
  revalidate(topic: number): TopicPlacementView;
  /** remaining per-window disk-byte budget for auto-prefetch. */
  budgetRemainingBytes(): number;
  /** estimated bytes a preload would land (from the working-set record size). */
  estimatedBytes(proposal: OrchestratorProposal): number;
  /** the real fetch — invoked ONLY in live mode for an admitted auto-prefetch. Carries the coordinator's refusals. */
  fetchWorkingSet(topic: number): Promise<FetchOutcome>;
  /** write structured evidence into the deterministic planner's policy input (placement-signal, live mode). */
  recordPlacementSignal(proposal: OrchestratorProposal): void;
  /** audit-BEFORE-actuate (machine-local JSONL append). */
  audit(entry: ActuationAuditEntry): void;
  now?: () => string;
  log?: (msg: string) => void;
  config: { dryRun: boolean };
}

export interface ActuationResult {
  decision: ActuationDecision;
  refusalReason?: string;
  bytes?: number;
}

export class OrchestratorActuator {
  private readonly d: ActuatorDeps;
  private readonly now: () => string;
  private readonly log: (msg: string) => void;

  constructor(deps: ActuatorDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.log = deps.log ?? (() => {});
  }

  /** Actuate a single proposal through the guards. Never throws — a guard failure is a refusal. */
  async actuate(proposal: OrchestratorProposal): Promise<ActuationResult> {
    const dryRun = this.d.config.dryRun;

    // ── Guard 1-3: re-validate at execute (compare-and-act) ──────────────────
    let live: TopicPlacementView;
    try {
      live = this.d.revalidate(proposal.targetTopic);
    } catch (err) {
      // A failed re-validation is a REFUSAL (fail-closed) — never actuate on an unknown state.
      return this.refuse(proposal, `revalidate-failed:${err instanceof Error ? err.message : String(err)}`, dryRun);
    }
    if (live.inFailureEpisode) {
      return this.refuse(proposal, 'yield-to-failure-movement', dryRun); // failure movement wins
    }
    if (live.pinned) {
      return this.refuse(proposal, 'topic-pinned', dryRun);
    }
    if (live.recentlyUserMoved) {
      return this.refuse(proposal, 'respect-user-provenance', dryRun);
    }

    // ── placement-signal: write structured evidence to the planner; never a move ──
    if (proposal.action === 'placement-signal') {
      const decision: ActuationDecision = dryRun ? 'would-signal' : 'signal-recorded';
      this.d.audit(this.entry(proposal, decision, dryRun));
      if (!dryRun) {
        try { this.d.recordPlacementSignal(proposal); } catch (err) {
          this.log(`orchestrator: recordPlacementSignal failed (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      return { decision };
    }

    // ── preload-artifact: the side-effect-free auto-prefetch. Budget-bound first. ──
    const need = Math.max(0, this.d.estimatedBytes(proposal));
    if (need > this.d.budgetRemainingBytes()) {
      return this.refuse(proposal, 'disk-byte-budget-exhausted', dryRun);
    }

    if (dryRun) {
      // P3 soak: log the would-actuate + audit; actuate NOTHING.
      this.d.audit(this.entry(proposal, 'would-actuate', true, need));
      return { decision: 'would-actuate', bytes: need };
    }

    // Live: AUDIT BEFORE the fetch (crash-mid-action leaves a trace), then fetch.
    this.d.audit(this.entry(proposal, 'actuated', false, need));
    try {
      const outcome = await this.d.fetchWorkingSet(proposal.targetTopic);
      if (!outcome.ok) {
        // The coordinator refused (secretFlagged/tooLarge/oversized/rate-limited) — a bounded no-op.
        return { decision: 'refused', refusalReason: `fetch-skip:${outcome.skipReason ?? 'unknown'}` };
      }
      return { decision: 'actuated', bytes: outcome.bytes ?? need };
    } catch (err) {
      this.log(`orchestrator: fetch failed for topic ${proposal.targetTopic} (${err instanceof Error ? err.message : String(err)})`);
      return { decision: 'refused', refusalReason: 'fetch-error' };
    }
  }

  private refuse(proposal: OrchestratorProposal, reason: string, dryRun: boolean): ActuationResult {
    this.d.audit(this.entry(proposal, 'refused', dryRun, undefined, reason));
    return { decision: 'refused', refusalReason: reason };
  }

  private entry(
    proposal: OrchestratorProposal,
    decision: ActuationDecision,
    dryRun: boolean,
    bytes?: number,
    refusalReason?: string,
  ): ActuationAuditEntry {
    return {
      ts: this.now(),
      action: proposal.action,
      targetTopic: proposal.targetTopic,
      detail: proposal.detail,
      authorityLevel: proposal.authorityLevel,
      decision,
      refusalReason,
      dryRun,
      bytes,
    };
  }
}
