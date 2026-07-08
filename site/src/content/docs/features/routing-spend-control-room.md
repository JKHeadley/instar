---
title: Routing Spend Control Room — spend view, caps, and the money layer
description: A read-only window on internal-LLM spend plus the dark-by-default money layer — an append-only booking ledger, a fail-closed cap gate, PIN-approved cap/arming plans, and an instant Bearer freeze.
---

Instar's internal AI work can route through **paid API doors** (metered keys for Google, OpenRouter,
Groq). The Routing Spend Control Room is the machinery that makes that safe: a read-only **spend
view** that turns the immutable token record into dollars, and — shipped dark for everyone — a
**money layer** that can actually stop real spending at your budget line before any paid door is
allowed to route.

## The spend view (read-only; Increment A)

- `GET /routing-spend/summary` — per door/model rollups (hour/day/month/total): tokens, gross,
  subsidy, net, committed, the price basis each row used, and loud `unpricedTokens` rows when a
  metered door can't be priced (never a fabricated $0). Served by the reporting composer
  (`routingSpendView`) joining the price authority (`routingPriceAuthority`) on read.
- `GET /routing-spend/caps` — every metered key with its caps, frozen state, committed totals, and
  per-door `goLiveState`. Honest before go-live: `$0` committed, `not-live` everywhere.
- The dashboard **Spend tab** renders both in plain language.

## The money layer (Increment B — dark for everyone until an explicit enable)

`routingSpend.money.enabled` is a documented action-bearing dark-gate exclusion: even development
agents don't get it automatically, and with it enabled every paid door STILL stays deny-by-default
until the operator PIN-arms it, one door at a time.

- **`MeteredSpendLedger`** — the authoritative money record: append-only fsync'd booking rows with
  a regenerable totals cache (the fold is canon; torn writes in either direction are repaired from
  row truth), an idempotent reserve → settle/expire terminal state machine, expiry-aware late
  settles, and an atomic in-mutex check-and-reserve so concurrent reservations always see each
  other.
- **`MeteredSpendGate`** — the O(1), never-cached, fail-closed admission gate. It refuses on every
  uncertainty: door not live, key frozen, wrong machine (`no-cap-slice`), stale lease confirmation
  (`lease-liveness-unconfirmed` — the self-fence that makes dual money authority structurally
  impossible), unbounded reservation, unknown or implausible price, stale-price policy, invalid
  cap, or cap exceeded (strict `>`). A cap refusal advances the routing chain to a free door —
  never a chain kill. Only canonical reviewed prices are gate-eligible; the observed price cache
  structurally cannot reach the gate.
- **`RoutingSpendCapsStore`** — the PIN-only caps/go-live store (`state/routing-spend-caps.json`),
  versioned for optimistic concurrency, schema-validated independently of the plan machinery,
  audited with full before+after state, and deliberately outside every `PATCH /config` surface.
- **`RenderedPlanStore`** — the approve-what-you-saw machinery: every money write commits solely
  from a server-rendered plan snapshot with a single-use nonce, a short TTL, and pinned store
  versions; a request field the operator never saw rendered cannot land.
- **`PinAttemptStore`** — durable per-IP PIN lockout shared by all PIN routes, so a restart no
  longer resets brute-force protection.
- **`SpendAlertResolver`** — the one-alerts-topic resolution ladder (configured id → persisted
  record → fenced create-once by the serving-lease holder) with a lifeline fallback and an
  edge latch that only sets on confirmed delivery. Stale-price alerts ship with the money layer
  because stale pricing changes admission behavior.

## Money routes (all 503 while dark)

- `POST /routing-spend/plan` — render the canonical plan for a money action (Bearer; rendering is
  not authority).
- `POST /routing-spend/caps/adjust` · `POST /routing-spend/go-live` · `POST /routing-spend/unfreeze`
  — PIN-gated commits of a rendered plan (arm/disarm designates the metered-lease machine).
- `POST /routing-spend/freeze` — Bearer, set-true-only, instant: halting money is always cheap;
  releasing it is always the operator's.
- `GET /routing-spend/caps/log` — the audited cap-change history.

## Safety posture

Reporting and money are strictly separated: provider reports, subsidies, credits, and observed
prices flow only through the reporting side and can never move the gate; the committed counter is
never lowered by a late report (no re-opened headroom). The whole layer is single-writer until the
multi-machine slicing increment — one PIN-designated machine holds the cap, and everyone else
fails closed.
