import type { ToneReviewResult } from '../core/MessagingToneGate.js';

/**
 * Race a tone/relevance-gate review against the outbound route's budget.
 *
 * Background — the production failure this exists to prevent (2026-06-08):
 * `MessagingToneGate.review` is FAIL-OPEN by design, but it will wait up to
 * RATE_LIMIT_WAIT_MS (120s) for a rate-limit window PLUS the call itself, all
 * inside a single `await`. Under sustained rate-limit pressure the gate
 * routinely finished at 121s–185s (observed in the tone-gate decision log, all
 * failedOpen) — past the 120s outbound route budget. The route then 408s, which
 * is the WORST outcome: the message both bypasses the gate AND, because the send
 * "failed", the calling session falls back to dumping the note into whatever
 * topic it is active in (the "patch notes landing in a working topic" bug).
 *
 * This helper makes the fail-open a STRUCTURAL guarantee at the route seam: it
 * resolves to the real verdict if the gate answers within `budgetMs`, otherwise
 * to a `budgetExceeded` fail-open result (pass=true) so the route delivers the
 * message rather than holding it past the route budget. The behaviour is
 * independent of provider internals, so a future provider/rate-limit change can
 * never re-introduce the hang. Same contract as the ArcCheck 200ms race that
 * already guards the signal-collection phase.
 *
 * Pure + injectable (`budgetMs`, `now`, `schedule`) so the budget semantics are
 * unit-tested deterministically without a real 20s wait.
 *
 * @param reviewPromise the in-flight `MessagingToneGate.review(...)` promise
 * @param budgetMs       hard budget; pass OUTBOUND_GATE_REVIEW_BUDGET_MS
 * @param now            clock injection (defaults to Date.now)
 * @param schedule       timer injection (defaults to setTimeout) — lets tests
 *                       fire the budget deterministically
 */
export async function reviewWithinBudget(
  reviewPromise: Promise<ToneReviewResult>,
  budgetMs: number,
  now: () => number = Date.now,
  schedule: (cb: () => void, ms: number) => void = (cb, ms) => {
    // unref so a pending budget timer never keeps the process alive
    const t = setTimeout(cb, ms);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  },
  // §Design 6: when true (the route opts in, gated by the failClosedOnExhaustion
  // kill-switch), the budget elapsing with NO verdict HOLDS the message
  // (fail-CLOSED) instead of delivering it ungated. The route-budget timeout is
  // the easiest gating bypass (attacker-induced latency); a held message is the
  // safe direction (No Silent Degradation). Default false preserves the legacy
  // fail-open contract for any other caller / the kill-switch-off path.
  failClosedOnBudget = false,
  // operator-channel-sacred (outbound, spec: outbound-gate-tiered-fail-direction):
  // when true, a budget-timeout fail-OPEN (the route already decided to deliver via
  // failClosedOnBudget=false because this is the verified operator's own channel) is
  // tagged `failedOpenOperatorChannel` instead of the legacy benign `failedOpen`, so
  // the deliver-on-timeout is AUDITED (never silent). No effect when holding.
  operatorChannelDeliver = false,
): Promise<ToneReviewResult> {
  const start = now();
  const BUDGET_EXCEEDED = Symbol('outbound-gate-budget-exceeded');
  const outcome = await Promise.race<ToneReviewResult | typeof BUDGET_EXCEEDED>([
    reviewPromise,
    new Promise<typeof BUDGET_EXCEEDED>((resolve) =>
      schedule(() => resolve(BUDGET_EXCEEDED), budgetMs),
    ),
  ]);
  if (outcome === BUDGET_EXCEEDED) {
    if (failClosedOnBudget) {
      return {
        pass: false,
        rule: 'GATE_TIMEOUT',
        issue: 'Outbound tone review did not produce a verdict within the budget.',
        suggestion: 'Held (fail-closed) on timeout; the message is queued for retry, not dropped.',
        latencyMs: now() - start,
        failedClosed: true,
        budgetExceeded: true,
      };
    }
    return {
      pass: true,
      rule: '',
      issue: '',
      suggestion: '',
      latencyMs: now() - start,
      // operator-channel deliver-on-timeout is tagged for audit/metrics; every other
      // budget fail-open keeps the legacy benign failedOpen tag.
      ...(operatorChannelDeliver ? { failedOpenOperatorChannel: true } : { failedOpen: true }),
      budgetExceeded: true,
    };
  }
  return outcome;
}
