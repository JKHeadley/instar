/**
 * CorrectionLoopDriver — the closed self-improvement loop for corrections (spec §3.6/§3.7/§3.8).
 *
 *   detect (Layer 0) → capture+distill → CorrectionLedger →
 *   gate (CorrectionAnalyzer) → ROUTE (this) → VERIFY (this).
 *
 * The headline safety property — "the loop can never change the agent's policy
 * or mint a proposal on its own" — is enforced BY CONSTRUCTION (spec §3.8). The
 * driver's injected capabilities are EXACTLY:
 *   - addAction            (open an Evolution Action — a tracked to-do)
 *   - createInitiative     (open a draft Initiative in needs-user)
 *   - feedbackLoopbackPost (POST the agent's OWN /feedback route — traverses
 *                           anomaly/quality/length guards; never FeedbackManager.submit)
 *   - recordPreference     (write .instar/preferences.json — explicit-preference
 *                           + gate-passed + policy-keyword-clean records ONLY)
 *   - attentionRoute       (route a candidate to the Attention queue for human
 *                           disposition — inferred prefs + policy-keyword matches)
 *
 * It is given NO ability to mint an EvolutionProposal (the ONLY thing the
 * autonomous auto-implement evaluator acts on) and NO direct write to MEMORY.md
 * / CLAUDE.md / feedback_*.md. So an auto-implemented policy change is
 * unreachable for anything this loop produces, regardless of
 * evolutionApprovalMode. A by-construction test pins ZERO proposals + ZERO
 * memory writes under autonomy ON.
 *
 * `kind` is signal, never authority — it routes a proposal / preferences write /
 * Attention item, never blocks or mutates on its own.
 */
import type { CorrectionLedger, CorrectionRecord } from './CorrectionLedger.js';
import type { CorrectionAnalyzer, GateVerdict } from './CorrectionAnalyzer.js';

/**
 * Deterministic policy-keyword filter (spec §3.6, NEW-A / P2). A learning that
 * tries to relax a safety/policy guard does NOT get silently vetoed (a regex
 * never wields blocking authority on its own); it is DOWNGRADED to the Attention
 * queue for one-tap human disposition. Returns true when the learning matches a
 * policy-relaxation pattern.
 */
const POLICY_VERB = /\b(ignore|skip|bypass|disable|always allow|pre-?authorize|pre-?approved|no need to confirm|never (ask|prompt|gate|confirm|block))\b/i;
const POLICY_NOUN = /\b(guard|gate|confirm(ation)?|safety|coherence|block|approval|permission|authoriz)\b/i;

export function matchesPolicyRelaxation(learning: string): boolean {
  const s = String(learning);
  return POLICY_VERB.test(s) && POLICY_NOUN.test(s);
}

/** The ONLY mutation capabilities the loop is given. Deliberately excludes any
 *  proposal-creation path AND any direct memory-file write (the by-construction
 *  authority guard, spec §3.8). */
export interface CorrectionLoopDeps {
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
  /** POST the agent's OWN /feedback route. Resolves to true when the route
   *  accepted (201); false otherwise — including a guard rejection (which is the
   *  guard doing its job). NEVER FeedbackManager.submit() directly. */
  feedbackLoopbackPost: (payload: {
    type: string;
    title: string;
    description: string;
  }) => Promise<boolean>;
  /** Write an explicit, gate-passed, policy-keyword-clean preference. */
  recordPreference: (payload: {
    learning: string;
    dedupeKey: string;
    confidence?: number;
  }) => void;
  /** Route a candidate to the Attention queue for human disposition. Resolves to
   *  true on delivery. */
  attentionRoute: (item: {
    id: string;
    title: string;
    summary: string;
    priority?: string;
  }) => Promise<boolean>;
  now?: () => number;
  /** Verify-window (preference path), default 7 days. */
  verifyWindowDaysPreference?: number;
  /** Verify-window (infra-gap path), default 14 days. */
  verifyWindowDaysInfraGap?: number;
  /** Max reopens before terminal `inconclusive` (default 2). */
  maxReopens?: number;
  /** Whether to actually POST infra-gap learnings to /feedback (default false —
   *  propose-only: queue a tracked Action + the human posts it). */
  autoFeedback?: boolean;
  /** Probe whether the loop-written preference entry still exists on disk
   *  (silence ≠ effective; verified requires the application persisted). */
  preferenceStillPresent?: (dedupeKey: string) => boolean;
}

export interface RouteResult {
  routed: CorrectionRecord[];
  toFeedback: number;
  toPreferences: number;
  toAttention: number;
}

export interface VerifyResult { evaluated: CorrectionRecord[]; }

export class CorrectionLoopDriver {
  constructor(
    private readonly ledger: CorrectionLedger,
    private readonly analyzer: CorrectionAnalyzer,
    private readonly deps: CorrectionLoopDeps,
  ) {}

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /**
   * ROUTE step (spec §3.6): for each gate-crossing record, route it by kind:
   *   user-preference + policy-keyword-clean → recordPreference()
   *   user-preference + policy-keyword-match → Attention (human disposes)
   *   infra-gap (autoFeedback ON)            → feedbackLoopbackPost()
   *   infra-gap (autoFeedback OFF, default)  → tracked Action + draft Initiative (propose-only)
   * Then open a verify window + move the record to acted-on. Idempotent: an
   * insight already past `open` is skipped by the analyzer's status:'open' filter.
   */
  async route(): Promise<RouteResult> {
    const result: RouteResult = { routed: [], toFeedback: 0, toPreferences: 0, toAttention: 0 };
    const { crossed } = this.analyzer.analyze();

    for (const verdict of crossed) {
      const rec = verdict.record;
      let routedVia: string | null = null;

      if (rec.kind === 'user-preference') {
        if (matchesPolicyRelaxation(rec.learning)) {
          // P2: a policy-relaxation learning NEVER auto-records — route to a human.
          const ok = await this.deps.attentionRoute({
            id: `correction-policy:${rec.dedupeKey.slice(0, 40)}`,
            title: 'Learned preference needs your approval (policy-relaxation)',
            summary: rec.scrubbedSummary,
            priority: 'medium',
          });
          routedVia = 'attention';
          if (ok) result.toAttention++;
        } else {
          this.deps.recordPreference({
            learning: rec.learning,
            dedupeKey: rec.dedupeKey,
            confidence: rec.llmConfidence,
          });
          routedVia = 'recordPreference';
          result.toPreferences++;
          // Parallel /learn proposal is queued as a tracked Action (documentation,
          // not the closing link). Bounded — no proposal minted.
          this.deps.addAction({
            title: `Durable-memory candidate: ${rec.scrubbedSummary}`,
            description: `The correction loop recorded this as a preference (${rec.dedupeKey}). Consider converting to a durable feedback_* memory entry. This is documentation only — the preferences write already closed the loop.`,
            priority: 'low',
            source: 'correction-preference-loop',
            tags: ['correction-learning', 'preference'],
          });
        }
      } else if (rec.kind === 'infra-gap') {
        if (this.deps.autoFeedback) {
          // Loopback POST through the real route guards (anomaly/quality/length).
          // The description carries ONLY the scrubbed summary, never raw learning.
          const ok = await this.deps.feedbackLoopbackPost({
            type: 'improvement',
            title: `Recurring friction: ${rec.scrubbedSummary.slice(0, 120)}`,
            description: rec.scrubbedSummary,
          });
          routedVia = 'feedback';
          if (ok) result.toFeedback++;
        } else {
          // Propose-only default: a tracked Action + a draft Initiative; the
          // human posts the feedback. No proposal minted.
          const slug = rec.dedupeKey.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50);
          this.deps.addAction({
            title: `Infra-gap proposal: ${rec.scrubbedSummary}`,
            description: `Recurring friction (${verdict.qualifyingOccurrences} support / ${verdict.distinctDays} days). Consider filing /feedback so Dawn can close the gap fleet-wide. Record ${rec.id}.`,
            priority: 'medium',
            source: 'correction-preference-loop',
            tags: ['correction-learning', 'infra-gap'],
          });
          await this.deps.createInitiative({
            id: `correction-infra-gap-${slug}`,
            title: `Infra-gap: ${rec.scrubbedSummary.slice(0, 80)}`,
            description: `The Correction & Preference Learning Sentinel detected a recurring infra-gap (record ${rec.id}). Approve to file /feedback (Rising Tide) so it helps every agent.`,
            phases: [{ name: 'Approve + file /feedback', status: 'pending' }],
            needsUser: true,
            needsUserReason: 'Recurring infra-gap correction; human approval required before fleet-wide feedback.',
          });
          routedVia = 'feedback';
        }
      }

      if (!routedVia) continue;

      // Open the verify window + move to acted-on.
      const windowDays = rec.kind === 'user-preference'
        ? (this.deps.verifyWindowDaysPreference ?? 7)
        : (this.deps.verifyWindowDaysInfraGap ?? 14);
      const start = new Date(this.now()).toISOString();
      const end = new Date(this.now() + windowDays * 86400_000).toISOString();
      const res = this.ledger.update(
        rec.id,
        { status: 'acted-on', routedVia, verifyWindowStart: start, verifyWindowEnd: end },
        rec.version,
      );
      if (res.ok) result.routed.push(res.record);
    }

    return result;
  }

  /**
   * VERIFY step (spec §3.7): for each `acted-on` record whose window has elapsed,
   * decide the outcome keyed on the SAME dedupeKey:
   *   - recurrence-after on the SAME dedupeKey → reopen (capped at maxReopens →
   *     inconclusive). Keying on dedupeKey (not the coarse kind) prevents a
   *     false-reopen from an unrelated learning in the same regex bucket.
   *   - SILENCE alone ≠ effective. A preference is `verified` only when (a) the
   *     dedupeKey did not recur in the window AND (b) the loop-written preference
   *     entry is still present (not human-deleted as wrong). Otherwise inconclusive.
   */
  runVerification(): VerifyResult {
    const evaluated: CorrectionRecord[] = [];
    const maxReopens = this.deps.maxReopens ?? 2;
    for (const rec of this.ledger.list({ status: 'acted-on', limit: 1000 })) {
      if (!rec.verifyWindowEnd || this.now() < Date.parse(rec.verifyWindowEnd)) continue;
      if (!rec.verifyWindowStart) continue;

      // Did the dedupeKey recur within the verify window? A recurrence shows up
      // as occurrences logged after the window opened.
      const windowStartMs = Date.parse(rec.verifyWindowStart);
      const recurred = this.recurredSince(rec.dedupeKey, windowStartMs);

      let next: Parameters<CorrectionLedger['update']>[1];
      if (recurred) {
        if (rec.reopenCount >= maxReopens) {
          next = { status: 'inconclusive' };
        } else {
          const windowDays = rec.kind === 'user-preference'
            ? (this.deps.verifyWindowDaysPreference ?? 7)
            : (this.deps.verifyWindowDaysInfraGap ?? 14);
          const end = new Date(this.now() + windowDays * 86400_000).toISOString();
          next = { status: 'reopened', reopenCount: rec.reopenCount + 1, verifyWindowEnd: end };
        }
      } else if (rec.kind === 'user-preference') {
        // Silence ≠ effective. Verified ONLY if the application persisted.
        const persisted = this.deps.preferenceStillPresent
          ? this.deps.preferenceStillPresent(rec.dedupeKey)
          : false;
        next = persisted ? { status: 'verified' } : { status: 'inconclusive' };
      } else {
        // infra-gap fix is cross-org (Dawn ships it). Slice 1 marks silence-only
        // as inconclusive — the verified correlation lands in Slice 2.
        next = { status: 'inconclusive' };
      }

      const res = this.ledger.update(rec.id, next, rec.version);
      if (res.ok) evaluated.push(res.record);
    }
    return { evaluated };
  }

  /** Whether the dedupeKey logged any occurrence at/after a timestamp (recurrence). */
  private recurredSince(dedupeKey: string, sinceMs: number): boolean {
    // The ledger only exposes day-bucketed distinct counts + the record's own
    // detectedAt. A recurrence advances the record's detected_at (the upsert sets
    // detected_at = excluded.detected_at), so a recurrence-after-window-open is
    // detectable as the record's current detectedAt being >= window start.
    const rec = this.ledger.getByDedupeKey(dedupeKey);
    if (!rec) return false;
    return Date.parse(rec.detectedAt) >= sinceMs && rec.occurrenceCount > 1;
  }
}
