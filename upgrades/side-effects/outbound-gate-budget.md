# Side-Effects Review — Outbound tone-gate budget (fail-open within the route budget)

**Version / slug:** `outbound-gate-budget`
**Date:** `2026-06-08`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier-1, additive + localized)`

## Summary of the change

Every outbound message (telegram/slack reply, attention item, `/telegram/post-update`)
passes through `checkOutboundMessage` in `src/server/routes.ts`, which calls
`MessagingToneGate.review` — an LLM call. The gate is fail-open by design, but under
rate-limit pressure `review()` waits up to `RATE_LIMIT_WAIT_MS` (120s) for a window
plus the call, all inside one un-raced `await`, exceeding the 120s outbound route
budget (`OUTBOUND_MESSAGING_TIMEOUT_MS`). The route then 408s and the calling session
dumps the note into its active topic. This change wraps the review call in
`reviewWithinBudget` (new file `src/server/outboundGateBudget.ts`), racing it against
`OUTBOUND_GATE_REVIEW_BUDGET_MS` (20s, new const in `middleware.ts`) and failing OPEN
past it. Touches: `routes.ts` (one call wrapped + one log field), `MessagingToneGate.ts`
(+1 optional result field), `types.ts` (+1 optional config field), `middleware.ts`
(+1 const), new helper + 2 tests + spec.

## Decision-point inventory

- `checkOutboundMessage → tone-gate verdict` — **modify** — the gate verdict is now
  bounded by a route-budget timeout that fails OPEN; the pass/block decision itself is
  unchanged when the gate answers in time.
- `OUTBOUND_GATE_REVIEW_BUDGET_MS vs OUTBOUND_MESSAGING_TIMEOUT_MS` — **add** — a budget
  invariant (gate budget < route timeout) asserted in tests.

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None — the change can only move the gate from "block/hold" toward "deliver". A real
block returned within budget is passed through unchanged (covered by the route test:
a fast B3 block still returns 422). The only new outcome is a budget-exceeded
fail-open, which DELIVERS (pass=true). So over-block strictly decreases; it never
increases.

## 2. Under-block

**What failure modes does this still miss?**

Under sustained rate-limit pressure a message can now be delivered un-reviewed after
the 20s budget (an intentional, designed fail-open). This is the same outcome the gate
already produced via its internal `failedOpen` path — just reached deterministically in
budget instead of after 2–3 minutes. The change does NOT make the gate review more
content (no new bypass). It does not address the separate behavioral fallback (a
session re-sending a failed update into a working topic) — tracked as a follow-up.

## 3. Level-of-abstraction fit

The budget is enforced at the route seam (`checkOutboundMessage`), the same layer that
already bounds the ArcCheck signal with a 200ms race — the correct altitude, because the
budget is a property of the OUTBOUND ROUTE (its 120s limit), not of the gate. The gate
stays a general authority usable by callers with different budgets.

## 4. Signal vs authority compliance

The tone gate remains the single authority; this does not add a competing gate. The
budget wrapper is a timeout, not a second opinion — when the authority answers in time
its verdict is used verbatim (pass AND block). On timeout the documented fail-open
contract applies (deliver). No signal is promoted to authority and no authority is
demoted to signal.

## 5. Interactions

- Shares the chokepoint with `/telegram/reply`, `/slack/reply`, `/whatsapp/send`,
  `/imessage/reply`, `/attention` — all inherit the bound (verified: their existing
  route tests still pass).
- The abandoned review promise keeps running after a budget timeout (Node has no
  cancel); it resolves/ignored, and `MessagingToneGate.review` never rejects (internal
  catch), so no unhandled rejection. `Promise.race` keeps a reaction attached to the
  review promise, so even a hypothetical late rejection is considered handled.
- `logToneGateDecision` gains a `budgetExceeded` boolean — additive, back-compatible
  with existing log consumers.

## 6. External surfaces

No new routes, no new external calls, no auth/permission change, no Telegram/Slack API
shape change. Adds one optional config field `outboundGateReviewBudgetMs` (absent →
code default; no migration). No state files written or read.

## 7. Rollback cost

Trivial and low-risk. Revert the commit; the gate returns to its prior un-raced await.
Or set `config.outboundGateReviewBudgetMs` very high to effectively disable the cap
without code change. No data migration, no schema, no persisted state to unwind.

## Conclusion

Net safety improvement: the change strictly reduces the worst-case behavior (a 408 that
both bypasses the gate AND misroutes the message) and never introduces a new block. The
only new behavior — faster fail-open delivery under sustained rate-limit pressure — is
the gate's already-documented degraded mode, reached in budget. Safe to ship.

## Second-pass review (if required)

Not required — Tier-1, additive and localized to one already-fail-open seam, full lint
green, 9 new + 71 existing related tests green.

## Evidence pointers

- Live `[tone-gate]` decision log latencies: 121s / 135s / 157s / 170s / 185s, all
  `failedOpen`, alongside repeated `429` events (this agent, 2026-06-07/08).
- Tests: `tests/unit/outbound-gate-budget.test.ts`,
  `tests/unit/post-update-gate-budget-route.test.ts`.
- Spec: `docs/specs/outbound-gate-budget.md`.
