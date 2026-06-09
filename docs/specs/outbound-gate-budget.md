# Outbound Gate Budget — the tone/relevance gate must never outlast its route

## The bug (2026-06-08)

Every outbound message — a Telegram reply, a Slack reply, an **update posted to
the Agent Updates topic** — passes through `checkOutboundMessage` in
`src/server/routes.ts`, which invokes the single messaging authority,
`MessagingToneGate.review`. That review makes an LLM call.

The gate is **fail-open by design**: if the LLM is unavailable or errors, it
returns `failedOpen: true` and the message is delivered un-reviewed. The problem
is *timing*, not *errors*:

- `MessagingToneGate.review` passes `rateLimitWaitMs: RATE_LIMIT_WAIT_MS`
  (`120_000`). Under rate-limit pressure the provider **waits up to 120s for a
  window to clear** rather than failing open — a deliberate choice for internal,
  non-time-critical gate calls.
- That whole wait sat inside a single un-raced `await` in
  `checkOutboundMessage`.
- The outbound routes carry a hard request budget,
  `OUTBOUND_MESSAGING_TIMEOUT_MS = 120_000`. After it, the `requestTimeout`
  middleware returns **408**.

So under sustained rate-limit pressure the gate routinely finished at
**121s–185s** (observed in `[tone-gate]` decision logs, all `failedOpen`),
**past** the 120s route budget. The route 408'd before the gate ever resolved.

A 408 here is the **worst** outcome:

1. The message bypasses the gate anyway (it was never reviewed).
2. Because the proactive send "failed", the calling session falls back to
   posting the update as a **normal reply in whatever topic it is active in** —
   which is how patch/upgrade notes ended up flooding a *working* topic
   (the user's Invoices topic) instead of the Updates topic.

The dedicated Updates topic and its routing were fine. The channel into it was
**hanging**, and the hang came from an unbounded quality gate, not from the
delivery layer.

## The fix

Bound the gate review **at the route seam** with a budget comfortably below the
route timeout, and **fail open past it** (same contract as the ArcCheck 200ms
race that already guards signal collection in the same function).

- `OUTBOUND_GATE_REVIEW_BUDGET_MS = 20_000` (`src/server/middleware.ts`), the
  single source of truth alongside `OUTBOUND_MESSAGING_TIMEOUT_MS`. A wiring test
  asserts the invariant `OUTBOUND_GATE_REVIEW_BUDGET_MS <
  OUTBOUND_MESSAGING_TIMEOUT_MS` so the two budgets can never drift into conflict.
- `reviewWithinBudget(reviewPromise, budgetMs, now?, schedule?)`
  (`src/server/outboundGateBudget.ts`) races the in-flight review against the
  budget. On time → the real verdict (pass **or** block — real blocks are never
  weakened). On budget elapse → a `budgetExceeded` fail-open result
  (`pass: true, failedOpen: true, budgetExceeded: true`), logged so the latency
  audit can see how often the gate is too slow to run in budget.
- This is a **structural** guarantee independent of provider internals: a future
  provider or rate-limit change can never re-introduce the hang, because the
  route enforces its own budget rather than trusting the gate to respect it.
- Optional per-agent override: `config.outboundGateReviewBudgetMs` (ms). Absent →
  the code default applies, so existing agents get the fix on update with **no
  config change** (no migration needed).

## Why fail-open-faster is strictly better here

The gate prefers to *wait* for a rate-limit window rather than fail open. That is
correct for internal callers with no hard deadline. It is **wrong** for a
user-facing outbound route that dies at 120s: by the time the window clears the
route is already dead, the message went un-reviewed regardless, AND it landed in
the wrong place. Delivering at 20s un-reviewed is the gate's *designed* degraded
behaviour and is strictly better than 408 → wrong-topic dump.

## What this fix does NOT cover

The **behavioural** fallback — a session, on a failed `/telegram/post-update`,
choosing to re-send the note as a plain reply into its active topic — is a
separate "structure > willpower" gap. This fix removes the *cause* of that
failure (the hang), so the fallback rarely triggers. Making the fallback
structurally impossible (e.g. the gate detecting update-class content addressed
to a non-Updates topic) is tracked as a follow-up.

## Tests

- `tests/unit/outbound-gate-budget.test.ts` — `reviewWithinBudget` semantics
  (pass-through, block-through, hang → budgetExceeded fail-open, latency,
  rejection propagation) + the budget < route-timeout invariant.
- `tests/unit/post-update-gate-budget-route.test.ts` — route-level wiring on
  `POST /telegram/post-update`: a hanging gate delivers (200, fast) instead of
  408; a fast block still blocks (422, no delivery); a fast pass delivers.
