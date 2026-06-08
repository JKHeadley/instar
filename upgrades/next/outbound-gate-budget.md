# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The outbound messaging quality gate (`MessagingToneGate.review`, reached via
`checkOutboundMessage`) is now bounded by a route-budget timeout that fails OPEN.
Previously the gate ran inside a single un-raced `await`; under rate-limit pressure
`review()` waits up to `RATE_LIMIT_WAIT_MS` (120s) for a window plus the call, which
exceeds the 120s outbound route budget (`OUTBOUND_MESSAGING_TIMEOUT_MS`). The route
then returns 408 and the calling session falls back to posting the message into
whatever topic it is active in — which is how update notes ended up in working topics.

A new helper `reviewWithinBudget` (`src/server/outboundGateBudget.ts`) races the
review against `OUTBOUND_GATE_REVIEW_BUDGET_MS` (20s, defined in `middleware.ts`,
asserted to be strictly below the route timeout). On time → the real verdict (pass or
block, unchanged). On budget elapse → a `budgetExceeded` fail-open (delivered,
logged). This is a structural guarantee at the route seam, covering every outbound
path that shares the chokepoint (`/telegram/reply`, `/telegram/post-update`,
`/slack/reply`, `/attention`, …). An optional per-agent override
`outboundGateReviewBudgetMs` exists; the default lives in code, so existing agents get
the fix on update with no config change (no migration).

## What to Tell Your User

- **Messages no longer get stuck behind the quality check**: "If you ever saw my
  updates land in the wrong chat, or replies feel stuck for a minute or two when
  things are busy — that's fixed. The check that reviews my messages now has a short
  deadline, so a slow moment can't strand a message anymore."

## Summary of New Capabilities

A behind-the-scenes reliability fix to outbound messaging — no new user-facing
surface. The message-review gate can no longer outlast its delivery deadline, so
outbound messages (replies and update posts) can't hang or get misrouted under load.

## Evidence

- Root cause verified in this agent's live `[tone-gate]` decision log: reviews
  finishing at 121s / 135s / 157s / 170s / 185s, all `failedOpen`, alongside repeated
  `429` rate-limit events — all past the 120s route budget.
- `tests/unit/outbound-gate-budget.test.ts` — `reviewWithinBudget` semantics
  (pass-through, block-through, hang → `budgetExceeded` fail-open, latency, rejection
  propagation) + the budget-below-route-timeout invariant.
- `tests/unit/post-update-gate-budget-route.test.ts` — route-level: a hanging gate
  delivers (200, fast) instead of 408; a fast block still blocks (422, no delivery);
  a fast pass delivers.
- Full lint clean; 71 existing related tone-gate/outbound/route tests green.
- Spec + side-effects review: `docs/specs/outbound-gate-budget.md`,
  `upgrades/side-effects/outbound-gate-budget.md`.
