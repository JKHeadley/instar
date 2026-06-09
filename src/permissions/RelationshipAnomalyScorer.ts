/**
 * RelationshipAnomalyScorer — the REAL relationship-aware second factor (Pillar 3,
 * §7.2). It implements the existing `AnomalyScorer` interface (same slot the gate
 * already consumes) and scores how far a request deviates from the principal's
 * DETERMINISTIC behavioral baseline (RelationshipBehaviorStore), with a confidence.
 *
 * This is the production scorer that goes beyond the placeholder HeuristicAnomalyScorer:
 * the Heuristic one reads a hand-injected baseline and only checks urgency + a single
 * "never made this action" flag. This one reads a baseline built from real recorded
 * history and composes FIVE deterministic, privacy-respecting SHAPE signals:
 *
 *   1. Out-of-character ACTION   — this principal has an established repertoire but has
 *                                  never (or rarely) made this kind of request.
 *   2. Tier ESCALATION           — the request's tier is far above the principal's
 *                                  normal ceiling (they suddenly reach for the floor).
 *   3. Off-CADENCE timing        — the request arrives at an hour this principal almost
 *                                  never operates in.
 *   4. Sudden URGENCY/pressure   — urgency language from someone who is normally calm.
 *   5. STYLE deviation           — message length far outside their normal envelope
 *                                  (a coarse, content-free style fingerprint).
 *
 * ── Deny-by-default / conservative direction (documented choice) ────────────────
 * Pillar 3 ships OBSERVE-ONLY (§7.6): a step-up is LOGGED, never live-challenged yet.
 * The safe direction while observing is to AVOID FABRICATING step-ups: a no-baseline
 * or thin-baseline principal scores LOW with LOW confidence, so we never invent a
 * step-up we can't justify from history. Rationale: in observe mode an over-fire just
 * pollutes the FP-rate measurement we're trying to take, and an under-fire is harmless
 * (nothing is blocked). Once the FP rate is measured good and enforcement is enabled,
 * the conservative-low-confidence stance is the right one too: a brand-new principal
 * has no "out of character" because there is no "character" yet — flagging them as
 * anomalous would be authority-by-suspicion, which the spec forbids (anomaly only
 * RAISES the bar on a would-be-allowed floor action; it never invents one). The floor
 * (RolePolicy) already protects the dangerous actions regardless of anomaly.
 *
 * ── Optional LLM style-check (fail-closed) ──────────────────────────────────────
 * An LLM voice/style comparison MAY be added behind the established no-silent-
 * degradation pattern (docs/specs/no-silent-degradation-to-brittle-fallback.md):
 * the call is marked gating:true so the IntelligenceRouter provider-swaps on failure,
 * and on ANY failure (no provider, throw, timeout, unparseable) we DO NOT widen — we
 * simply omit the LLM's contribution and keep the deterministic score. The LLM can
 * only ever ADD to the anomaly score (raise the bar), never lower it. It is OFF by
 * default; the deterministic signals stand alone.
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §7.1–7.4, §7.6.
 */

import type { Principal, RequestIntent, AnomalyAssessment } from './types.js';
import type { IntelligenceProvider } from '../core/types.js';
import {
  RelationshipBehaviorStore,
  baselineAgeMs,
  decayedView,
  decayedMeanLength,
  decayedStdLength,
  decayedHourFraction,
  DEFAULT_BUCKET_MS,
  type PrincipalBehaviorProfile,
  type DecayedProfileView,
} from './RelationshipBehaviorStore.js';

const URGENCY =
  /\b(urgent|urgently|asap|right now|immediately|before eod|by eod|end of day|emergency|hurry|quickly|can'?t wait)\b/i;

/** Tunable signal weights + thresholds. Defaults are conservative (lean toward NOT firing). */
export interface RelationshipAnomalyConfig {
  /** Weight of the out-of-character-action signal. Default 0.45. */
  atypicalActionWeight?: number;
  /** Weight of the tier-escalation signal. Default 0.4. */
  tierEscalationWeight?: number;
  /** Weight of the off-cadence (unusual hour) signal. Default 0.2. */
  offCadenceWeight?: number;
  /** Weight of the sudden-urgency signal. Default 0.25. */
  urgencyWeight?: number;
  /** Weight of the style-deviation (length z-score) signal. Default 0.2. */
  styleWeight?: number;
  /**
   * Minimum interaction count for a baseline to be "established" enough to make
   * an out-of-character claim. Below this, action/style signals are suppressed
   * (no character yet → no out-of-character). Default 5.
   */
  establishedMin?: number;
  /**
   * Minimum baseline calendar AGE (days) before a baseline counts as "established"
   * (poisoning-resistance #3a). "Established" now requires BOTH this age AND
   * `establishedMin` count — so a patient attacker can't rapidly manufacture a
   * trusted baseline in a single burst (a high COUNT accrued in minutes is still
   * YOUNG → not established → the action/tier/style signals stay suppressed, and the
   * scorer never gains false confidence from a rapid burst). Default 7 days.
   * Set to 0 to require count only (legacy behavior). Backward-compat: a profile
   * whose firstSeen predates the request by ≥ this age satisfies it automatically.
   */
  minBaselineAgeDays?: number;
  /**
   * Decay half-life in bucket-windows for the recency weighting (#2). A recent burst
   * of attacker observations decays relative to long-standing behavior. Default 30
   * (≈30 days at the store's 1-day bucket). Larger = slower decay (older behavior
   * keeps weight longer). Read-time only; the store records raw counts.
   */
  decayHalfLifeWindows?: number;
  /**
   * Bucket-window length (ms) the baseline was recorded with. Must match the store's
   * `bucketWindowMs`. Default reads from the store; falls back to 1 day. Exposed for
   * tests that inject a custom window.
   */
  bucketMs?: number;
  /**
   * Share floor for the out-of-character-action signal (poisoning resistance).
   * The signal fires when the requested action's SHARE of the principal's history is
   * BELOW this (not only when never-seen) — so a patient attacker can't disable the
   * highest-weight signal by seeding a single prior observation. Weight scales by how
   * far below the floor the share sits (full at never-seen, →0 at the floor) so a
   * genuinely-routine action never trips it. Default 0.10. (Phase-3 adversarial fix.)
   */
  rareActionShareFloor?: number;
  /** Length z-score above which a message reads as style-deviant. Default 2.5. */
  styleZThreshold?: number;
  /** Hour fraction at/below which an arrival hour is "off-cadence". Default 0.02. */
  offCadenceHourFraction?: number;
  /** Now() for deterministic tests (drives hour-of-day). */
  now?: () => Date;
  /**
   * Optional LLM style check (fail-closed). When provided, an out-of-style request
   * may add to the anomaly score; any failure simply omits it (never widens).
   */
  intelligence?: IntelligenceProvider;
  /** Enable the optional LLM style check. Default false (deterministic only). */
  useLlmStyleCheck?: boolean;
  /** LLM call timeout (ms). Default 6000. */
  llmTimeoutMs?: number;
}

/** A single signal's contribution (for transparency in the assessment reasons). */
interface SignalHit {
  weight: number;
  reason: string;
}

export class RelationshipAnomalyScorer {
  private readonly store: RelationshipBehaviorStore;
  private readonly cfg: Required<
    Omit<RelationshipAnomalyConfig, 'intelligence' | 'useLlmStyleCheck' | 'llmTimeoutMs'>
  > & Pick<RelationshipAnomalyConfig, 'intelligence' | 'useLlmStyleCheck' | 'llmTimeoutMs'>;

  constructor(store: RelationshipBehaviorStore, config: RelationshipAnomalyConfig = {}) {
    this.store = store;
    this.cfg = {
      atypicalActionWeight: config.atypicalActionWeight ?? 0.45,
      tierEscalationWeight: config.tierEscalationWeight ?? 0.4,
      offCadenceWeight: config.offCadenceWeight ?? 0.2,
      urgencyWeight: config.urgencyWeight ?? 0.25,
      styleWeight: config.styleWeight ?? 0.2,
      establishedMin: config.establishedMin ?? 5,
      // #3a: default 7 calendar days. Nullish-coalescing so a deliberate 0 means
      // "count only" (the legacy pre-hardening behavior).
      minBaselineAgeDays: config.minBaselineAgeDays ?? 7,
      decayHalfLifeWindows: config.decayHalfLifeWindows && config.decayHalfLifeWindows > 0 ? config.decayHalfLifeWindows : 30,
      bucketMs: config.bucketMs && config.bucketMs > 0 ? config.bucketMs : store.bucketWindowMs ?? DEFAULT_BUCKET_MS,
      rareActionShareFloor: config.rareActionShareFloor ?? 0.1,
      styleZThreshold: config.styleZThreshold ?? 2.5,
      offCadenceHourFraction: config.offCadenceHourFraction ?? 0.02,
      now: config.now ?? (() => new Date()),
      intelligence: config.intelligence,
      useLlmStyleCheck: config.useLlmStyleCheck,
      llmTimeoutMs: config.llmTimeoutMs,
    };
  }

  /**
   * Score how out-of-character (principal, intent, text) is. Deterministic except
   * for the OPTIONAL LLM style check (which only ever adds, and fails closed).
   *
   * Returns an `AnomalyAssessment` with a 0..1 score, reasons, and a `confidence`
   * piggybacked onto the reasons via the score being suppressed under thin baselines.
   * The gate consumes `score` against its `stepUpThreshold` and only ever RAISES a
   * would-be-allowed floor action to step-up — never lowers any bar.
   */
  async assess(principal: Principal, intent: RequestIntent, text: string): Promise<AnomalyAssessment> {
    const profile = this.store.profileFor(principal.slackUserId);
    const { score, reasons, confidence } = this.deterministicScore(profile, intent, text);

    // Optional LLM style check — fail-closed, ADD-ONLY. Skipped unless explicitly enabled
    // AND we have an established baseline to compare against (no character → no check).
    let finalScore = score;
    const finalReasons = [...reasons];
    if (
      this.cfg.useLlmStyleCheck &&
      this.cfg.intelligence &&
      profile &&
      profile.interactionCount >= this.cfg.establishedMin
    ) {
      const llm = await this.llmStyleHit(profile, text);
      if (llm) {
        finalScore = Math.min(1, finalScore + llm.weight);
        finalReasons.push(llm.reason);
      }
    }

    return {
      score: clamp01(finalScore),
      reasons: confidence === 'none'
        ? [] // no baseline → no defensible anomaly reason; stays low + silent
        : finalReasons,
    };
  }

  /**
   * Pure deterministic scoring. Exposed via `assess`; broken out for unit testing.
   * Returns the raw score, the contributing reasons, and a coarse confidence band
   * derived from baseline depth.
   */
  deterministicScore(
    profile: PrincipalBehaviorProfile | undefined,
    intent: RequestIntent,
    text: string,
  ): { score: number; reasons: string[]; confidence: 'none' | 'low' | 'medium' | 'high' } {
    const isUrgent = URGENCY.test(text || '');

    // ── No baseline / new principal → conservative: LOW anomaly, no step-up fabrication ──
    if (!profile || profile.interactionCount <= 0) {
      return { score: 0, reasons: [], confidence: 'none' };
    }

    const nowMs = this.cfg.now().getTime();

    // ── Recency/decay view (#2): a decay-weighted SHAPE so a recent attacker burst that
    // tries to NORMALIZE a rare action is caught — under decay the burst can't durably
    // dominate, and once it ages out the genuine baseline re-asserts. A pre-hardening
    // profile (no buckets) yields a decayed view IDENTICAL to its cumulative form. ──
    const view = decayedView(profile, {
      nowMs,
      bucketMs: this.cfg.bucketMs ?? DEFAULT_BUCKET_MS,
      halfLifeWindows: this.cfg.decayHalfLifeWindows,
    });

    // ── The CUMULATIVE view (as a DecayedProfileView with weight 1.0 everywhere) ──
    // Each established signal evaluates BOTH views and fires on the MORE anomalous one.
    // This is the load-bearing poisoning-resistance invariant: the hardening only ever
    // ADDS resistance — it must never DISARM a signal the pre-hardening cumulative baseline
    // would have fired. A recent rate-capped burst can raise a rare action's *decayed*
    // share above the floor, but it cannot erase its rarity across the WHOLE relationship
    // (the cap bounds how much it can inject); the cumulative view preserves that. The
    // decayed view, conversely, catches "this used to be normal but the recent pattern is
    // off". Taking the max of the two is strictly stronger than either alone. ──
    const cumulative: DecayedProfileView = {
      effectiveCount: profile.interactionCount,
      actionCounts: profile.actionCounts,
      tierCounts: profile.tierCounts,
      hourCounts: profile.hourCounts,
      lengthSum: profile.lengthSum,
      lengthSqSum: profile.lengthSqSum,
      urgentCount: profile.urgentCount,
    };

    // ── "Established" now requires BOTH count AND calendar age (#3a) ──
    // A high-COUNT but YOUNG baseline (a rapid burst) is NOT established → the
    // action/tier/style signals stay suppressed (no false confidence from a burst).
    const countEstablished = profile.interactionCount >= this.cfg.establishedMin;
    const ageDays = baselineAgeMs(profile, nowMs) / (24 * 60 * 60 * 1000);
    const ageEstablished = this.cfg.minBaselineAgeDays <= 0 || ageDays >= this.cfg.minBaselineAgeDays;
    const established = countEstablished && ageEstablished;

    // Confidence reflects depth, but a young baseline is capped at 'low' (we don't trust
    // a burst-built baseline even if its count is high).
    const confidence: 'low' | 'medium' | 'high' = !established
      ? 'low'
      : profile.interactionCount >= this.cfg.establishedMin * 4
        ? 'high'
        : 'medium';

    const hits: SignalHit[] = [];

    // ── 1. Out-of-character ACTION (only when the baseline is established) ──
    if (established) {
      const floor = this.cfg.rareActionShareFloor;
      const neverSeen = (profile.actionCounts[intent.action] ?? 0) === 0;
      // Rarity in each view; fire on the MORE anomalous (lower share = higher rarity).
      const shareCum = (cumulative.actionCounts[intent.action] ?? 0) / (cumulative.effectiveCount || 1);
      const shareDec = (view.actionCounts[intent.action] ?? 0) / (view.effectiveCount || 1);
      const minShare = Math.min(shareCum, shareDec);
      // Poisoning resistance (#1 share-floor + #2 dual-view max): the action is flagged if it
      // is rare in EITHER the whole-relationship history OR the recent-weighted window. A
      // patient attacker can seed a prior observation (defeats `seen===0`) or burst recently
      // (raises the decayed share), but cannot make the action non-rare in BOTH views without
      // a sustained campaign the rate cap (#3b) throttles. Weight scales by how far below the
      // floor the more-anomalous share sits, so a genuinely-routine action never trips it.
      if (minShare < floor) {
        const rarity = 1 - minShare / floor; // 1.0 when never seen; →0 as share→floor
        hits.push({
          weight: this.cfg.atypicalActionWeight * rarity,
          reason: neverSeen
            ? `out-of-character: established history (${profile.interactionCount} interactions) but never requested "${intent.action}"`
            : `out-of-character: "${intent.action}" is rare for this principal (≈ ${Math.round(minShare * 100)}% of history, below the ${Math.round(floor * 100)}% floor)`,
        });
      }
    }

    // ── 2. Tier ESCALATION — request tier far above the principal's normal ceiling ──
    if (established) {
      // Use the LOWER ceiling across both views: a recent burst of high-tier obs can't
      // silently raise the "normal ceiling" and disarm this signal (it stays armed as long
      // as EITHER the whole-relationship OR the recent-weighted ceiling is low).
      const normalMaxTier = Math.min(highestRoutineTier(view), highestRoutineTier(cumulative));
      if (intent.tier >= 4 && normalMaxTier <= 2) {
        hits.push({
          weight: this.cfg.tierEscalationWeight,
          reason: `tier escalation: reaching a floor action (T${intent.tier}) when this principal normally tops out at T${normalMaxTier}`,
        });
      }
    }

    // ── 3. Off-CADENCE timing — arrival hour this principal almost never uses ──
    if (established) {
      const hour = this.cfg.now().getHours();
      // Off-cadence if the hour is rare in EITHER view (a burst at an odd hour can't make
      // that hour look routine across the whole relationship).
      const minHourFrac = Math.min(decayedHourFraction(view, hour), decayedHourFraction(cumulative, hour));
      if (minHourFrac <= this.cfg.offCadenceHourFraction) {
        hits.push({
          weight: this.cfg.offCadenceWeight,
          reason: `off-cadence: request at ${pad2(hour)}:00, an hour this principal almost never operates in`,
        });
      }
    }

    // ── 4. Sudden URGENCY/pressure from someone normally calm ──
    if (isUrgent) {
      // Use the LOWER urgent rate across both views — a recent burst of urgent obs can't
      // raise the baseline urgent rate enough to mask sudden pressure from a normally-calm
      // principal (the whole-relationship rate stays low).
      const urgentRateDec = view.effectiveCount > 0 ? view.urgentCount / view.effectiveCount : 0;
      const urgentRateCum = cumulative.effectiveCount > 0 ? cumulative.urgentCount / cumulative.effectiveCount : 0;
      if (Math.min(urgentRateDec, urgentRateCum) <= 0.15) {
        hits.push({
          weight: this.cfg.urgencyWeight,
          reason: 'sudden urgency/pressure language from a normally-calm principal',
        });
      }
    }

    // ── 5. STYLE deviation — message length far outside the normal envelope ──
    // Fire if the message length is deviant in EITHER view (a recent burst of off-style
    // messages can't widen the envelope enough to hide a deviation from the whole history).
    if (established) {
      const zDec = lengthZ(text, decayedMeanLength(view), decayedStdLength(view));
      const zCum = lengthZ(text, decayedMeanLength(cumulative), decayedStdLength(cumulative));
      const z = Math.max(zDec ?? 0, zCum ?? 0);
      if (z >= this.cfg.styleZThreshold) {
        hits.push({
          weight: this.cfg.styleWeight,
          reason: `style deviation: message length is ${z.toFixed(1)}σ from this principal's norm`,
        });
      }
    }

    const score = clamp01(hits.reduce((s, h) => s + h.weight, 0));
    return { score, reasons: hits.map((h) => h.reason), confidence };
  }

  /**
   * Optional LLM style hit — fail-closed, add-only. Asks a fast model whether the
   * message's VOICE matches a coarse description of the principal's normal style.
   * On ANY failure or an unparseable / "matches" answer, returns null (no widening).
   */
  private async llmStyleHit(
    profile: PrincipalBehaviorProfile,
    text: string,
  ): Promise<SignalHit | null> {
    const intel = this.cfg.intelligence;
    if (!intel) return null; // no provider → fail closed (no contribution)
    try {
      // Coarse style summary for the LLM — cumulative mean is fine here (it's a prose hint,
      // not a scoring input; the deterministic signals already use the decayed view).
      const mean = profile.interactionCount > 0 ? profile.lengthSum / profile.interactionCount : undefined;
      const topActions = Object.entries(profile.actionCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([a]) => a)
        .join(', ');
      const prompt =
        'You compare whether a new message matches a person\'s established style. ' +
        'Reply with ONLY one word: MATCH or MISMATCH.\n\n' +
        `Established style summary: typical request types are [${topActions}]; ` +
        `typical message length ~${mean !== undefined ? Math.round(mean) : 'unknown'} chars; ` +
        `${profile.interactionCount} prior interactions.\n` +
        `New message: ${JSON.stringify((text || '').slice(0, 500))}\n\n` +
        'Does the new message clearly MISMATCH this person\'s established style?';
      const raw = await intel.evaluate(prompt, {
        model: 'fast',
        maxTokens: 8,
        temperature: 0,
        timeoutMs: this.cfg.llmTimeoutMs ?? 6000,
        attribution: { component: 'RelationshipAnomalyScorer', category: 'gate', gating: true },
      });
      const verdict = (raw || '').trim().toUpperCase();
      // Only a CLEAR mismatch adds. Anything else (MATCH, empty, unparseable) → no contribution.
      if (verdict.startsWith('MISMATCH')) {
        return { weight: this.cfg.styleWeight, reason: 'LLM style check: message voice does not match this principal' };
      }
      return null;
    } catch {
      // No-silent-degradation: a style-check failure NEVER widens. We simply omit it.
      return null;
    }
  }
}

/**
 * The highest tier this principal has used in more than a trivial share of interactions,
 * computed over the DECAYED view so a recent attacker burst of high-tier observations
 * doesn't silently raise the "normal ceiling" and disarm tier-escalation (#2).
 */
function highestRoutineTier(view: DecayedProfileView): number {
  let max = 0;
  const total = view.effectiveCount || 1;
  for (let t = 0; t <= 4; t++) {
    const c = view.tierCounts[t] ?? 0;
    if (c > 0 && c / total > 0.02) max = t;
  }
  return max;
}

/** |z| of a message length against a view's mean/std, or undefined when not computable. */
function lengthZ(text: string, mean: number | undefined, std: number | undefined): number | undefined {
  if (mean === undefined || std === undefined || std <= 0) return undefined;
  return Math.abs(((text || '').length - mean) / std);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
