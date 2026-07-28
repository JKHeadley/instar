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
  /** POST the agent's OWN /feedback route. NEVER FeedbackManager.submit()
   *  directly. May resolve to either a plain boolean (legacy: true=accepted) or a
   *  structured {posted, rateLimited} so the driver can distinguish a 429
   *  (rate-limited — carry the record to the next run) from a guard rejection
   *  (the guard doing its job — do NOT retry). The route's feedbackLimiter is
   *  10/min/IP, so a converged batch must serialize + back off (spec §10 Slice-2
   *  NEW-2). */
  feedbackLoopbackPost: (payload: {
    type: string;
    title: string;
    description: string;
  }) => Promise<boolean | FeedbackPostResult>;
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
  /** Max records routed per route() call (spec §10 Slice-2 NEW-5). Overflow
   *  stays `open` and is re-evaluated next run. Default 5. */
  maxRoutesPerTick?: number;
  /** Delay (ms) inserted between successive loopback /feedback POSTs so a
   *  converged infra-gap batch serializes under the route's 10/min IP limit
   *  (spec §10 Slice-2 NEW-2). Default 0 (no delay) — set in production wiring. */
  feedbackPostDelayMs?: number;
  /** Injectable sleep (testability) — defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Structured audit sink — one line per route/verify decision. Never throws. */
  audit?: (event: { decision: string; dedupeKey?: string; detail?: string }) => void;
}

/** Structured loopback-POST result (spec §10 Slice-2 NEW-2). */
export interface FeedbackPostResult {
  /** True iff the route accepted (201). */
  posted: boolean;
  /** True iff the route returned 429 (rate-limited) — carry to the next run. */
  rateLimited?: boolean;
}

function normalizeFeedbackResult(r: boolean | FeedbackPostResult): FeedbackPostResult {
  return typeof r === 'boolean' ? { posted: r } : r;
}

export interface RouteResult {
  routed: CorrectionRecord[];
  toFeedback: number;
  toPreferences: number;
  toAttention: number;
  /** Gate-crossing records NOT routed this run (per-tick ceiling OR a 429 cut the
   *  infra-gap batch short). They stay `open` and re-route next run. */
  overflow: number;
  /** True iff a loopback /feedback POST was rate-limited (429) this run, so the
   *  remaining infra-gap records were carried to the next run. */
  rateLimited: boolean;
}

export interface VerifyResult { evaluated: CorrectionRecord[]; }

export class CorrectionLoopDriver {
  constructor(
    private readonly ledger: CorrectionLedger,
    private readonly analyzer: CorrectionAnalyzer,
    private readonly deps: CorrectionLoopDeps,
  ) {}

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /**
   * ROUTE step (spec §3.6): for each gate-crossing record, route it by kind:
   *   user-preference + policy-keyword-clean → recordPreference()
   *   user-preference + policy-keyword-match → Attention (human disposes)
   *   infra-gap (autoFeedback ON)            → feedbackLoopbackPost()
   *   infra-gap (autoFeedback OFF, default)  → tracked Action + draft Initiative (propose-only)
   * Then open a verify window + move the record to acted-on. Idempotent: an
   * insight already past `open` is skipped by the analyzer's status:'open' filter.
   *
   * Bounded per run (spec §10 Slice-2):
   *  - PER-TICK CEILING (NEW-5): at most `maxRoutesPerTick` records route per run.
   *    Overflow stays `open` (re-routed next run); the overflow count is audited.
   *  - BATCHED + 429-RETRY (NEW-2): autoFeedback infra-gap POSTs serialize with
   *    `feedbackPostDelayMs` between them (the route's feedbackLimiter is 10/min/IP);
   *    on the FIRST 429 the batch stops — remaining infra-gap records stay `open`
   *    and are carried to the next run (no silent drop).
   */
  async route(): Promise<RouteResult> {
    const result: RouteResult = { routed: [], toFeedback: 0, toPreferences: 0, toAttention: 0, overflow: 0, rateLimited: false };
    const { crossed } = this.analyzer.analyze();
    const maxRoutesPerTick = this.deps.maxRoutesPerTick && this.deps.maxRoutesPerTick > 0
      ? this.deps.maxRoutesPerTick
      : 5;

    let routedThisTick = 0;
    let feedbackPostsThisTick = 0;
    for (const verdict of crossed) {
      const rec = verdict.record;

      // PER-TICK CEILING: stop routing once the ceiling is hit; the rest stay
      // `open` and re-route next run.
      if (routedThisTick >= maxRoutesPerTick) {
        result.overflow++;
        continue;
      }
      // After a 429 cut the batch short, every remaining record is overflow too
      // (carried to the next run) — do not attempt further routing this tick.
      if (result.rateLimited) {
        result.overflow++;
        continue;
      }

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
          // Serialize the batch: delay before every POST after the first so a
          // converged batch can't trip the route's 10/min IP limit.
          if (feedbackPostsThisTick > 0) await this.sleep(this.deps.feedbackPostDelayMs ?? 0);
          // Loopback POST through the real route guards (anomaly/quality/length).
          // The description carries ONLY the scrubbed summary, never raw learning.
          const raw = await this.deps.feedbackLoopbackPost({
            type: 'improvement',
            title: `Recurring friction: ${rec.scrubbedSummary.slice(0, 120)}`,
            description: rec.scrubbedSummary,
          });
          feedbackPostsThisTick++;
          const fb = normalizeFeedbackResult(raw);
          if (fb.rateLimited) {
            // 429 — carry THIS record (and the rest) to the next run; do NOT
            // mark it acted-on (so the analyzer re-routes it). Stop the batch.
            result.rateLimited = true;
            result.overflow++;
            this.deps.audit?.({ decision: 'feedback-429-carry', dedupeKey: rec.dedupeKey });
            continue;
          }
          routedVia = 'feedback';
          if (fb.posted) result.toFeedback++;
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
      if (res.ok) {
        result.routed.push(res.record);
        routedThisTick++;
        this.deps.audit?.({ decision: `routed:${routedVia}`, dedupeKey: rec.dedupeKey });
      }
    }

    if (result.overflow > 0) {
      this.deps.audit?.({
        decision: 'overflow-carried',
        detail: `${result.overflow} gate-crossing records left open for next run (ceiling ${maxRoutesPerTick}${result.rateLimited ? ', batch cut by 429' : ''})`,
      });
    }

    return result;
  }

  /**
   * VERIFY step (spec §3.7): for each `acted-on` record whose window has elapsed,
   * decide the outcome keyed on the SAME dedupeKey. The infra-gap path mirrors the
   * preference path's recurrence-after watcher with the path-appropriate window
   * and verdict (spec §10 Slice-2 infra-gap closed-loop verify):
   *   - recurrence-after on the SAME dedupeKey → reopen (capped at maxReopens →
   *     inconclusive). Keying on dedupeKey (not the coarse kind) prevents a
   *     false-reopen from an unrelated learning in the same regex bucket. Applies
   *     to BOTH kinds; infra-gap uses verifyWindowDaysInfraGap (default 14).
   *   - PREFERENCE silence ≠ effective. `verified` only when (a) the dedupeKey did
   *     not recur in the window AND (b) the loop-written preference entry is still
   *     present (not human-deleted as wrong). Otherwise inconclusive.
   *   - INFRA-GAP silence → `inconclusive`, NOT `verified`. Unlike a preference
   *     (where silence + persisted application closes the loop locally), the
   *     infra-gap fix is cross-org — Dawn ships it through Rising Tide. The agent
   *     cannot prove its /feedback proposal caused the fix, so silence (no
   *     recurrence, proposal still open) is inconclusive by design — never a
   *     false "verified" the agent didn't earn.
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
      let auditReason: string;
      if (recurred) {
        if (rec.reopenCount >= maxReopens) {
          next = { status: 'inconclusive' };
          auditReason = `recurred after ${rec.reopenCount} reopens — terminal inconclusive`;
        } else {
          const windowDays = rec.kind === 'user-preference'
            ? (this.deps.verifyWindowDaysPreference ?? 7)
            : (this.deps.verifyWindowDaysInfraGap ?? 14);
          const end = new Date(this.now() + windowDays * 86400_000).toISOString();
          next = { status: 'reopened', reopenCount: rec.reopenCount + 1, verifyWindowEnd: end };
          auditReason = `recurred — reopened (${rec.reopenCount + 1}/${maxReopens}), watching ${windowDays}d more`;
        }
      } else if (rec.kind === 'user-preference') {
        // Silence ≠ effective. Verified ONLY if the application persisted.
        const persisted = this.deps.preferenceStillPresent
          ? this.deps.preferenceStillPresent(rec.dedupeKey)
          : false;
        next = persisted ? { status: 'verified' } : { status: 'inconclusive' };
        auditReason = persisted
          ? 'no recurrence + preference still on disk — verified'
          : 'no recurrence but preference removed/absent — inconclusive (silence ≠ effective)';
      } else {
        // infra-gap fix is cross-org (Dawn ships it). Silence (no recurrence,
        // proposal still open) is inconclusive — the agent never earns a
        // "verified" it can't prove it caused.
        next = { status: 'inconclusive' };
        auditReason = 'infra-gap: no recurrence, fix is cross-org (Dawn) — inconclusive, not verified';
      }

      const res = this.ledger.update(rec.id, next, rec.version);
      if (res.ok) {
        evaluated.push(res.record);
        this.deps.audit?.({ decision: `verify:${next.status}`, dedupeKey: rec.dedupeKey, detail: auditReason });
      }
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
