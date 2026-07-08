# Routing Control Room — Increment B: the money layer (ships dark)

**Spec:** `docs/specs/routing-control-room-spend-alerts.md` (converged r7 + approved)
**Side-effects:** `upgrades/side-effects/routing-spend-increment-b.md`
**Maturity:** ⚗️ Experimental — ships DARK for everyone (`routingSpend.money.enabled` is a
documented DARK_GATE_EXCLUSIONS action-bearing case; even dev agents need the explicit enable).

## What Changed

- **`MeteredSpendLedger`** (`src/core/MeteredSpendLedger.ts`): the authoritative, append-only,
  booking-priced money ledger — fsync'd row-append FIRST, atomic totals-cache rewrite second,
  boot-time refold (the fold is canon), high-water re-fold on external append, per-key async
  mutex, reserve/settle/expire idempotent terminal state machine, expiry-aware late settle,
  ATOMIC check-and-reserve (the cap comparison happens inside the booking critical section).
- **`MeteredSpendGate`** (`src/core/MeteredSpendGate.ts`): the O(1) fail-closed admission gate —
  refuses on not-live / frozen / no-cap-slice / lease-liveness-unconfirmed / unbounded-reservation /
  unknown-price / implausible-price / stale-price policy / invalid-cap / cap-exceeded (strict `>`),
  canonical-manifest-only pricing (an observed price is structurally not gate-eligible), code-defined
  per-provider plausibility floors, conservative-max stale booking, and the per-door billed-token
  mapping (`billedOutputTokens`) that errs HIGH (the Gemini thinking-token trap).
- **`RoutingSpendCapsStore`** (`src/core/RoutingSpendCapsStore.ts`): the PIN-only money-authority
  store (`state/routing-spend-caps.json`) — versioned (optimistic concurrency), schema-validated
  independently of the plan machinery, before+after audited, freeze set-TRUE-only (Bearer),
  cap-lowering bumps the lease epoch.
- **`RenderedPlanStore`** (`src/core/RenderedPlanStore.ts`): the canonical rendered-plan machinery —
  single-use nonce, TTL, version pins, commit-derives-solely-from-the-render (smuggled fields
  structurally cannot land).
- **`PinAttemptStore`** (`src/core/PinAttemptStore.ts`): durable per-IP PIN lockout shared by ALL
  PIN routes — a restart no longer resets brute-force lockout (S2-1).
- **`SpendAlertResolver`** (`src/core/SpendAlertResolver.ts`): the minimal alert-topic resolution
  ladder (configured id → persisted record → fenced serving-lease-holder-only create-once) with
  lifeline fallback + edge-latch-on-confirmed-delivery; stale-price alerts ride Increment B
  (staleness changes admission behavior).
- **Routes:** `POST /routing-spend/plan` (Bearer render), `POST /routing-spend/caps/adjust` /
  `go-live` / `unfreeze` (PIN plan commits), `POST /routing-spend/freeze` (Bearer, set-true-only),
  `GET /routing-spend/caps/log` (Bearer audit read). The caps VIEW now composes real committed
  totals + go-live state when the money layer is enabled.
- **Registry:** `routingSpend.money.enabled` documented in `DARK_GATE_EXCLUSIONS` (action-bearing).

## Evidence

- `tests/unit/metered-spend-ledger.test.ts` — 12 cases incl. both torn-write directions,
  two-concurrent-reserves, expiry-aware late settle, fail-closed unwritable-path refusal.
- `tests/unit/metered-spend-gate.test.ts` — the full fail-closed matrix (one case per refusal
  reason) + the concurrent cap race (caught a real check-outside-mutex race during the build;
  fixed by moving the comparison inside the booking critical section) + the billed-token mapping.
- `tests/unit/routing-spend-money-stores.test.ts` — S-F2 structural regression (money state is
  outside PATCH /config), C4-4 validator, S2-3 smuggle, nonce replay, version drift, durable
  lockout across restarts, alert-ladder + lifeline fallback + edge latch.
- `tests/integration/routing-spend-routes.test.ts` — the full HTTP PIN plan flow, dark-503s,
  freeze/unfreeze asymmetry, smuggle-refusal over HTTP, audit log.
- `tests/e2e/routing-spend-lifecycle.test.ts` — feature-alive on the REAL AgentServer boot path
  (200 with the explicit enable; 503 on a dev agent WITHOUT it — FD-16 pinned both ways).

## What to Tell Your User

Nothing yet — this ships dark and spends nothing. When your operator later enables the money
layer and PIN-arms a paid door, your Spend tab gains real committed-spend figures and PIN-gated
cap controls; every paid door stays off until that explicit arming. No paid door can route in
this release regardless (the metered dispatch seam is not wired — FD-11's release gate).

## Summary of New Capabilities

- (⚗️ Experimental, dark) The money authority for metered LLM doors: booking ledger + fail-closed
  cap gate + PIN-gated caps/arming with rendered-plan approval + instant Bearer freeze + durable
  PIN lockout + stale-price alert foundation. Increment C (full alert channel), the Layer-1c
  provider-report capture/reconciliation, and the operator's amortized-subscription display land
  in the follow-on PRs of this increment train (tracked: CMT-1929).
