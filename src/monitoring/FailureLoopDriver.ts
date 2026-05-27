/**
 * FailureLoopDriver — the closed self-improvement loop (spec §4.6.1).
 *
 *   discover (FailureAnalyzer) → IMPLEMENT (this: open a tracked item) →
 *   deploy (normal spec→build→rollout, human-driven) → VERIFY (this).
 *
 * The headline safety property — "the loop can never change the process on its
 * own" — is enforced BY CONSTRUCTION (spec §4.6.1 step 3, round-2 BL-2):
 *
 *   The driver's injected capabilities are ONLY `addAction` (an Evolution
 *   Action) and `createInitiative` (a draft Initiative in `needs-user`). It is
 *   given NO ability to create an EvolutionProposal — and a proposal is the
 *   ONLY thing the autonomous auto-implement evaluator acts on. So an
 *   auto-implemented process change is unreachable for anything this loop
 *   produces, regardless of `evolutionApprovalMode`. There is no field to forge
 *   and no layer to misplace: the capability simply isn't wired in.
 *
 * Verify (step 5): on an `acted-on` insight past its verification window, the
 * driver computes the post-change rate of the targeted failure category and
 * sets the outcome — labeled CORRELATIONAL, never causal. It requires a minimum
 * post-window exposure before concluding (else `insufficient-exposure` → extend
 * once → `inconclusive`), and caps reopens so a non-droppable class can never
 * churn forever (spec §4.6.1 M3).
 *
 * NOTE (v1 simplification, tracked): "exposure normalization" here is the raw
 * post-window category count vs. baseline. The full features-of-category-shipped
 * denominator is a later refinement — it can only make the outcome MORE
 * conservative, never auto-implement anything (the authority guard is unaffected).
 */
import type { FailureLedger, InsightRecord, FailureCategory } from './FailureLedger.js';

/** The ONLY mutation capabilities the loop is given. Deliberately excludes any
 *  proposal-creation path (that's the by-construction authority guard). */
export interface LoopDeps {
  /** Open an Evolution Action (tracked self-improvement to-do). */
  addAction: (opts: {
    title: string;
    description: string;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    source?: string;
    tags?: string[];
  }) => { id: string };
  /** Open a draft Initiative in needs-user (a human approves turning it real). */
  createInitiative: (input: {
    id: string;
    title: string;
    description: string;
    phases: { name: string; status: string }[];
    needsUser: boolean;
    needsUserReason?: string;
  }) => Promise<{ id: string }>;
  now?: () => number;
  /** Days to watch the targeted failure class after the fix ships (default 42 = 6 weeks). */
  verifyWindowDays?: number;
  /** Max reopens before terminal `inconclusive` (default 2). */
  maxReopens?: number;
  /** Minimum post-window category activity required to conclude (default 1). */
  minPostExposure?: number;
}

export interface ActResult { actedOn: InsightRecord[]; }
export interface VerifyResult { evaluated: InsightRecord[]; }

export class FailureLoopDriver {
  constructor(private readonly ledger: FailureLedger, private readonly deps: LoopDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /**
   * IMPLEMENT step: for each newly-`discovered` insight, open a tracked Action +
   * a draft Initiative (needs-user) and move it to `acted-on` with a verification
   * window. Never mints a proposal (see class docs). Idempotent: an insight
   * already past `discovered` is skipped.
   */
  async actOnNewInsights(): Promise<ActResult> {
    const actedOn: InsightRecord[] = [];
    for (const insight of this.ledger.listInsights({ status: 'discovered' })) {
      const slug = insight.identityKey.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50);
      const initiativeId = `failure-insight-${slug}`;
      // 1) tracked Evolution Action (a to-do that can't be forgotten)
      this.deps.addAction({
        title: `Process improvement: ${insight.summary}`,
        description: `${insight.recommendation}\n\nEvidence: ${insight.supportingFailureIds.length} failures (${insight.distinctSessions} sessions / ${insight.distinctCauseCommits} cause-commits). Insight ${insight.id}.`,
        priority: 'medium',
        source: 'failure-learning-loop',
        tags: ['failure-learning', insight.targetCategory ?? 'unknown'],
      });
      // 2) draft Initiative in needs-user (a human approves making it real)
      await this.deps.createInitiative({
        id: initiativeId,
        title: `Process improvement: ${insight.targetCategory} failures`,
        description: `${insight.recommendation}\n\nDiscovered by the Failure-Learning Loop (insight ${insight.id}). Approve to turn into a tracked spec → build.`,
        phases: [{ name: 'Approve + spec the process change', status: 'pending' }],
        needsUser: true,
        needsUserReason: `Failure-Learning Loop recommends a process change (${insight.targetCategory}); human approval required before any change ships.`,
      });
      // 3) move to acted-on with a verification window
      const windowDays = this.deps.verifyWindowDays ?? 42;
      const start = new Date(this.now()).toISOString();
      const end = new Date(this.now() + windowDays * 86400_000).toISOString();
      const res = this.ledger.updateInsight(
        insight.id,
        { status: 'acted-on', actedOnVia: initiativeId, verifyWindowStart: start, verifyWindowEnd: end },
        insight.version,
      );
      if (res.ok) actedOn.push(res.record);
    }
    return { actedOn };
  }

  /**
   * VERIFY step: for each `acted-on` insight whose window has elapsed, decide
   * the (correlational) outcome. Drop below baseline → verified-effective;
   * no drop → verified-ineffective + reopen (capped → inconclusive); too little
   * post-window activity → insufficient-exposure (extend once → inconclusive).
   */
  runVerification(): VerifyResult {
    const evaluated: InsightRecord[] = [];
    const maxReopens = this.deps.maxReopens ?? 2;
    const minExposure = this.deps.minPostExposure ?? 1;
    for (const insight of this.ledger.listInsights({ status: 'acted-on' })) {
      if (!insight.verifyWindowEnd || this.now() < Date.parse(insight.verifyWindowEnd)) continue;
      const category = insight.targetCategory as FailureCategory | undefined;
      if (!category || !insight.verifyWindowStart) continue;

      // Count only NEW failures of this category after the fix shipped — exclude
      // the pre-fix baseline failures that motivated the insight (they sit at
      // ≈window-start, so including them would mask any genuine drop).
      const baselineIds = new Set(insight.supportingFailureIds);
      const postWindow = this.ledger
        .list({ category, sinceMs: Date.parse(insight.verifyWindowStart), limit: 1000 })
        .filter((r) => (r.attribution === 'automatic' || r.attribution === 'one-tap') && !baselineIds.has(r.id));
      const postCount = postWindow.length;
      const baseline = insight.baselineRate ?? insight.supportingFailureIds.length;

      let next: Parameters<FailureLedger['updateInsight']>[1];
      if (postCount < minExposure) {
        // Not enough post-change activity to conclude — extend once, then give up.
        if (insight.reopenCount >= 1) {
          next = { status: 'inconclusive', verifiedOutcome: 'insufficient-exposure' };
        } else {
          const end = new Date(this.now() + (this.deps.verifyWindowDays ?? 42) * 86400_000).toISOString();
          next = { reopenCount: insight.reopenCount + 1, verifyWindowEnd: end };
        }
      } else if (postCount < baseline) {
        next = { status: 'verified-effective', verifiedOutcome: 'effective' };
      } else if (insight.reopenCount >= maxReopens) {
        next = { status: 'inconclusive', verifiedOutcome: 'ineffective' };
      } else {
        // Didn't drop — reopen for another window (capped).
        const end = new Date(this.now() + (this.deps.verifyWindowDays ?? 42) * 86400_000).toISOString();
        next = { status: 'acted-on', verifiedOutcome: 'ineffective', reopenCount: insight.reopenCount + 1, verifyWindowEnd: end };
      }
      const res = this.ledger.updateInsight(insight.id, next, insight.version);
      if (res.ok) evaluated.push(res.record);
    }
    return { evaluated };
  }
}
