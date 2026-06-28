/**
 * Deterministic self-stop floor — the no-LLM backstop for the behavioral
 * self-stop guard (B15/B18) on the DEGRADED tone-gate path.
 *
 * Spec: docs/specs/ux-is-the-product-hardening.md §2.1
 *
 * Why this exists (the 2026-06-27 incident): the behavioral self-stop rules
 * (B15_CONTEXT_DEATH_STOP, B18_AUTONOMY_STOP) require the LLM judge. When the
 * LLM backend is unavailable (provider throw → fail-open, or slow-budget-timeout
 * → degrade to the leak-only floor) the self-stop guard SILENTLY VANISHES — which
 * is exactly the flaky-backend condition under which an agent is most likely to
 * be drifting. The leak floor (detectDeterministicLeak) keeps secrets/paths/
 * commands from escaping during an outage, but it does NOT catch a clean-prose
 * self-stop. This module fills that one gap: a deterministic recognizer for the
 * self-stop SHAPE so the degraded path can HOLD (fail-CLOSED on suspicion) rather
 * than wave a drift message through.
 *
 * Threat model: drift-correction, NOT a security boundary (same as the LLM gate).
 * It is intentionally NARROW and high-precision (a stop/defer ACTION conjoined
 * with a self-protective REASON), because it runs only on the degraded path where
 * its verdict HOLDS a message. A genuine question to the operator or an external
 * blocker report carries no self-protective reason and so is NOT held.
 *
 * Bias (degraded path only): favor false-POSITIVES — holding a borderline agent
 * self-stop costs the agent a re-think; a false-NEGATIVE is the exact failure we
 * are fixing. This is the inverse of B16/B17's bias because the cost asymmetry is
 * inverted when the judge is offline.
 */

export interface SelfStopFloorResult {
  /** True when the text expresses the self-stop shape (stop/defer + self-protective reason). */
  detected: boolean;
  /** The action phrase that matched (for the audit issue), when detected. */
  actionMatch?: string;
  /** The self-protective reason phrase that matched (for the audit issue), when detected. */
  reasonMatch?: string;
}

/**
 * (A) Stop / defer / hand-off ACTION markers — the agent proposing to halt or
 * postpone in-flight work. ILLUSTRATIVE of the shape, matched case-insensitively
 * as substrings. The list is deliberately broad on the ACTION axis because the
 * REASON axis (B) is what makes a match high-precision.
 */
const ACTION_MARKERS: readonly string[] = [
  'pause here',
  'pausing here',
  'pausing rather than',
  "i'm pausing",
  'im pausing',
  'going to pause',
  'will pause here',
  'let me pause',
  'stop here',
  'stopping here',
  "i'll stop here",
  'let me stop here',
  'hold off on',
  'holding off on',
  'pick this up later',
  'pick it up later',
  'pick this back up later',
  'resume this later',
  'resume it later',
  'continue this later',
  'continue in a fresh',
  'continue in a new session',
  'leave it here for now',
  'leave this here for now',
  'wrap up here',
  'wrapping up here',
  'good stopping point',
  'natural stopping point',
  'natural off-ramp',
  'park this for',
  'parking this for',
  'hand this off',
  'handing this off',
  'handing it back',
  'hand it back',
];

/**
 * (B) Self-protective REASON markers — the agent's OWN operational state /
 * convenience used to justify the stop, rather than a legitimate stop reason.
 * Three families: context/fatigue, restart-avoidance, and environment-as-stop.
 */
const REASON_MARKERS: readonly string[] = [
  // context / fatigue / volume / freshness — kept specific so an incidental
  // mention of a data structure ("the tail of the array") or a UI ("compact
  // layout") does NOT match (over-block fix, second-pass review 2026-06-28).
  'context window',
  'running low on context',
  'low on context',
  'out of context',
  'remaining context',
  'compact the conversation',
  'compact to continue',
  'fresh focus',
  'with a clear head',
  'clearer head',
  "i'm sharper",
  'sharper earlier',
  'better fresh',
  'a clean, focused pass',
  'a clean focused pass',
  'clean focused pass',
  'half-finished',
  'half finished',
  'barreling ahead',
  'barrelling ahead',
  'huge work session',
  'already-huge',
  'already huge work',
  'tail of this run',
  'tail of this session',
  'tail of an already',
  'tail of a huge',
  "i've done a lot already",
  'done a lot already',
  "it's late",
  'it is late',
  "i'm getting tired",
  'muddy output',
  // restart / redeploy avoidance (the operator: a restart is a MINIMAL disruption)
  'restarts the agent',
  'restart the agent',
  'disruptive restart',
  'half-finished restart',
  'avoid a restart',
  'rather not restart',
  'risk a restart',
  // environment-issue-as-stop — kept to the stop-specific phrasing only (the
  // operator's directive: FIX the local environment; it's not a stop reason).
  // The broad LLM-judge clause in B15 covers softer environment framings.
  'environment-only failures',
  'environment-only failure',
];

/**
 * Strong LEGITIMATE-stop overrides — when present, the stop's reason is NOT
 * self-protective, so the floor does NOT hold. Kept narrow and high-confidence:
 * an external dependency clearing on its own schedule, or an explicit
 * operator-only/credential reason. (A bare "?" is intentionally NOT a legit
 * override here — a self-stop dressed as a rhetorical question must still hold on
 * the degraded path; the agent can re-send a genuine decision question without
 * the self-stop framing.)
 */
const LEGIT_OVERRIDES: readonly string[] = [
  'rate limit',
  'rate-limit',
  'rate-limited',
  'rate limited',
  'once ci is green',
  'when ci is green',
  'until ci',
  'waiting on the deploy',
  'until the deploy',
  'api error',
  'returned 500',
  'returned a 500',
  ' 503',
  'service is down',
  'service is unavailable',
  'waiting on you to',
  'need your password',
  'need a credential',
  'awaiting your approval',
  'pending your approval',
];

function firstMatch(haystack: string, needles: readonly string[]): string | undefined {
  for (const n of needles) {
    if (haystack.includes(n)) return n;
  }
  return undefined;
}

/**
 * Detect the self-stop shape in an AGENT-OUTBOUND message. Detection requires
 * BOTH a stop/defer ACTION marker AND a self-protective REASON marker, and NO
 * strong legitimate-stop override. Pure and synchronous (no LLM, no subprocess).
 */
export function detectSelfStopShape(text: string): SelfStopFloorResult {
  if (!text) return { detected: false };
  const hay = text.toLowerCase();

  // A legitimate external/credential reason de-fangs the whole message.
  if (firstMatch(hay, LEGIT_OVERRIDES)) return { detected: false };

  const actionMatch = firstMatch(hay, ACTION_MARKERS);
  if (!actionMatch) return { detected: false };
  const reasonMatch = firstMatch(hay, REASON_MARKERS);
  if (!reasonMatch) return { detected: false };

  return { detected: true, actionMatch, reasonMatch };
}
