---
title: "Routing Control Room — Spend Tracking, Caps & Alerts (Surfaces 1 & 2)"
slug: "routing-control-room-spend-alerts"
author: "echo"
status: "draft"
eli16-overview: "docs/specs/routing-control-room-spend-alerts.eli16.md"
---

# Routing Control Room — Spend Tracking, Caps & Alerts (Surfaces 1 & 2)

## Problem statement

Surface 3 of the operator's routing control room shipped as PR #1394: a read-only
**Routing Map** (`GET /intelligence/routing/chains` + a dashboard tab) that shows,
for every internal AI job-kind, which *door* + model it uses and its full ordered
fallback list. It is DISPLAY-ONLY — it changes nothing and, deliberately, tracks no
money.

Instar is about to put **real money** through some of those doors. The nature-axis
routing chains (`src/data/llmBenchCoverage.ts`, `NATURE_ROUTING_DEFAULT_CHAINS`)
already name three **metered API doors** — `gemini-api`, `openrouter-api`,
`groq-api` — each `moneyGated: true` and backed by a vault key
(`metered_gemini_bench`, `metered_openrouter_bench`, `metered_groq_bench`). In
Increment A these are DEFINED but always skipped (`skippedInIncrementA`), so no paid
door routes yet. When they go live, the agent will spend dollars per token, and the
operator has **no production surface** to see the spend, cap it, or be alerted when
it runs away.

Grounding confirms the gap is real and total:
- **Token ground truth exists, USD does not.** `FeatureMetricsLedger`
  (`src/monitoring/FeatureMetricsLedger.ts`) records every internal LLM call to a
  durable SQLite table `feature_metrics` (`ts`, `tokens_in`, `tokens_out`,
  `tokens_cached`, `model`, `framework`, `outcome`), per feature×model×framework via
  the single funnel tap `setFeatureMetricsRecorder(...)` (wired at
  `AgentServer.ts:1099`). It stores **tokens only — there is no USD column anywhere**,
  and it exposes **a single rolling `sinceHours` window — no hourly/daily/monthly
  buckets**.
- **USD/cap/alert logic exists ONLY bench-side.** `research/llm-pathway-bench/metered-funnel.mjs`
  has a mature pattern — `settleCost` (tokens×price/1e6), a lifetime+daily rollup
  (`metered-rollup.<key>.json`), a `frozen` kill switch, per-key caps
  (`metered-caps.json`), and edge-triggered 50%/80% alerts to `POST /attention`.
  **None of this is in production** — production has no wired USD budget gate at all
  (`dailySpendCapUsd` in `ConfigDefaults.ts` is decorative and being retired per
  `PostUpdateMigrator` migration `mentor-dailySpendCapUsd-retire-v1`).

This spec designs **Surfaces 1 (spend tracking + rollups + view) and 2 (caps display
+ PIN-gated adjust + alerts)** as production features, built on the token ground
truth that already exists, borrowing the bench funnel's earned patterns, and honoring
every money/blast-radius/multi-machine standard in the constitution.

The operator's explicit requirements (verbatim intent), all addressed below:
1. Spend tracking on **timestamped, immutable ground truth** so dollar cost can be
   **re-calculated as needed later**. Store ground-truth tokens + timestamp — never
   only a derived cost.
2. **Price-at-time-of-use**: cost = tokens × the door/model price *in effect at that
   timestamp* — a versioned/timestamped price table, joined as-of each usage record.
3. **Regularly confirm + track door/model dollar costs, staying up to date, including
   subsidies** — a cadenced refresh that records prices into the history and supports
   subsidy/credit adjustments.
4. **Rollups: hourly / daily / monthly / total** per door/model and aggregate.
5. **Caps display + ADJUST** — show lifetime/daily caps per key and live spend vs
   cap; the adjust control (and the paid-door go-live flip) is **PIN-gated**.
6. **Alerts — Telegram-FIRST, Slack-extensible** — a dedicated topic firing on cap
   hit (and approaching 50%/80%), a door going dark, and a fallback being used;
   routed through a channel abstraction so Slack adds later without rework.

## Design principles this spec is bound by

- **Money blast radius (Bounded Blast Radius).** The counter that GATES money is
  O(1), never-cached, fail-closed at cap — mirroring the metered funnel's rules.
- **Immutable ground truth + retroactive recompute (No Silent Degradation applied to
  accounting).** Token records are append-only; a price correction NEVER mutates a
  usage record — it recomputes derived cost.
- **Deny-by-default for money authority (The Operator Channel Is Sacred / Know Your
  Principal).** Changing a cap or arming a paid door requires the dashboard PIN; a
  Bearer token is structurally insufficient.
- **Self-Heal Before Notify.** A door-dark alert sits DOWNSTREAM of the router's own
  swap-tail self-heal; the operator hears about it only when self-heal is exhausted.
- **Everything dark/reversible.** The read-only view ships first, dark; writes and
  go-live are separately PIN-gated increments.

---

## Proposed design

The design has four durable layers and three read/write surfaces, split across three
increments. The **layering is the safety architecture**: ground truth (immutable
tokens) → price authority (versioned, as-of) → derived views (recomputable rollups) →
money gate (O(1) accelerator, fail-closed). Corrections flow DOWN the layers; nothing
flows up into ground truth.

### Layer 0 — Token ground truth (REUSE `feature_metrics`, add a `door` dimension)

The append-only SQLite table `feature_metrics` is already the timestamped, immutable
token record required by Requirement 1. Every internal LLM call lands there through
the single funnel tap. We make ONE additive, non-destructive change:

- Add a nullable `door TEXT` column via the existing idempotent `ensureAddedColumns()`
  pattern (pragma-guarded `ALTER TABLE`, exactly like `framework`/`tokens_cached`
  were added). The **door** (`gemini-api`, `openrouter-api`, `groq-api`,
  `codex-cli`, …) is what carries a price; `framework` alone is insufficient because
  a metered API door and its CLI sibling can share a framework label. The funnel
  records the resolved door alongside the model/framework it already records.
- Records remain **append-only and never mutated**. No USD column is ever added to
  this table — cost is always a read-time join (Layer 2). This is the structural
  guarantee behind "re-calculate as needed later": the ground truth is tokens+time,
  and any dollar figure is a *view* over it.
- Retention: this table's default 30-day prune (`monitoring.featureMetrics.retentionDays`)
  is too short for a "monthly/total" spend history. The spend feature reads its own
  retention floor `routingSpend.groundTruthRetentionDays` (default **400**); the
  prune uses `max(featureMetrics.retentionDays, routingSpend.groundTruthRetentionDays)`
  when the spend feature is enabled, so enabling spend never silently shortens the
  metrics horizon and never lets the metrics knob truncate spend history. "Total" is
  honestly "total within the retained horizon" (surfaced in the view; see Layer 2).

### Layer 1 — Price authority (versioned, timestamped, git-tracked = `unified`)

Requirement 2 needs a price *history* joined as-of each usage record. The
authoritative price record is a **git-tracked canonical manifest**
`scripts/routing-prices.manifest.json` — the same convention as the doorway
registry's `model-registry-freshness.manifest.json` and the bench `metered-prices.json`,
promoted to production and given **embedded history**:

```jsonc
{
  "schemaVersion": 1,
  "_doc": "USD per MILLION tokens, per door+model, with effective-dated history. Append-only: a price change or correction ADDS a point; points are never edited in place.",
  "points": [
    {
      "door": "openrouter-api",
      "modelId": "openai/gpt-5.5",
      "inPerMtok": 5.0,
      "outPerMtok": 30.0,
      "effectiveAt": "2026-07-01T00:00:00Z",   // price in effect FROM this instant
      "recordedAt": "2026-07-01T18:00:00Z",     // when we learned it
      "source": "openrouter-models-api",        // provenance
      "corrects": null                          // set to a prior effectiveAt when this row FIXES a wrong price
    },
    {
      "door": "groq-api",
      "modelId": "openai/gpt-oss-120B",
      "inPerMtok": 0.15,
      "outPerMtok": 0.6,
      "effectiveAt": "2026-07-01T00:00:00Z",
      "recordedAt": "2026-07-01T18:00:00Z",
      "source": "groq-published-rounded-up",
      "subsidy": { "kind": "discount-frac", "value": 0.0 }  // per-token subsidy, Layer 1b
    }
  ]
}
```

- **As-of join (the core of Requirement 2).** For a usage record at time `ts` for
  `(door, modelId)`, cost uses the price point with the greatest `effectiveAt ≤ ts`
  (and, among rows sharing an `effectiveAt`, the greatest `recordedAt` — so a
  *correction* row supersedes the wrong one it `corrects`). This is a deterministic
  as-of lookup: `cost = tokensIn/1e6 * inPerMtok + tokensOut/1e6 * outPerMtok`,
  reusing the bench `settleCost` formula verbatim.
- **A correction never mutates ground truth or a prior price row.** A price we
  discover was wrong for a past window is fixed by APPENDING a new point with the
  same (or covering) `effectiveAt`, a later `recordedAt`, and `corrects` set. Every
  cost view then recomputes automatically — exactly the "price correction retroactively
  recomputes" requirement — with a full audit trail of what the price was believed to
  be and when.
- **Subscription/CLI doors are honestly $0-per-token.** `claude-code`, `codex-cli`,
  `pi-cli`, `gemini-cli` are subscription/OAuth doors — not per-token billed. Their
  price points are `inPerMtok: 0, outPerMtok: 0, source: "subscription-not-per-token"`.
  The view shows subscription doors' TOKEN volume with a `$0 (subscription)` cost and
  a note, never a fabricated dollar figure. (An optional amortized-subscription cost
  is explicitly out of scope — see Frontloaded Decision FD-7.)
- **Machine-local read index (NOT authoritative).** On load, each machine builds a
  read-only SQLite index of the manifest's points for fast as-of joins. This index is
  a **regenerable materialized view of a `unified` source**, holding no authoritative
  state — a straight rebuild from the git-tracked manifest on every boot / manifest
  change. It is not machine-local *state* (Multi-machine posture, below).

#### Layer 1b — Subsidy / credit model (leaves ground truth untouched)

Requirement 3 asks for subsidies "if needed." Subsidies are a **price-layer** concept —
they never touch the token ground truth:

- **Per-token subsidy / discount** (e.g. "this model is 20% off for us", or a
  promotional per-mtok rate): a price point's optional `subsidy` field —
  `{ kind: "discount-frac", value: 0.2 }` (multiply the effective price by `0.8`) or
  `{ kind: "flat-per-mtok", inPerMtok, outPerMtok }` (an override rate). The as-of
  join applies it after the base rate. It is versioned and effective-dated like any
  price change, so "the subsidy started March 1, ended April 1" is expressible as two
  points.
- **Lump-sum credit** (e.g. "$50 of free credits on this key"): a separate
  append-only `credits` ledger `{ keyRef, amountUsd, grantedAt, expiresAt?, note }`.
  Credits are applied at ROLLUP time as a *net* line — the view shows gross cost, the
  credit applied, and net — and are NEVER folded into the price or the tokens.
  A credit that runs out or expires stops offsetting; the gross is always visible.
- **Both are append-only and reversible** (a mistaken credit/subsidy is corrected by
  appending an offsetting/superseding row, never by editing history). Ground truth
  (tokens) is provably untouched by any subsidy operation.

### Layer 2 — Derived spend views & rollups (computed on read, never stored)

Requirement 4 (hourly/daily/monthly/total) is served by **read-time SQL** over Layer 0
joined as-of to Layer 1 — there is **no stored rollup table** for reporting, by
design:

- A stored rollup would go STALE the moment a price is corrected or a subsidy is
  added — violating the retroactive-recompute requirement. Computing rollups on read
  guarantees every view reflects the current price/subsidy truth.
- Rollup query: `SELECT bucket(ts, :grain) AS bucket, door, modelId, SUM(tokensIn),
  SUM(tokensOut), <as-of-cost expression> FROM feature_metrics [JOIN price index]
  GROUP BY bucket, door, modelId` for `:grain ∈ {hour, day, month}`; `total` is the
  ungrouped sum over the retained horizon. Indexed on `ts` (existing
  `idx_feature_metrics_ts`) and a new composite `(door, ts)` index for the door
  breakdown.
- The as-of price join in SQL uses a correlated subquery against the price index
  (greatest `effectiveAt ≤ ts`); for performance the join is bounded to the query's
  time window and the price index is small (dozens of points). If the horizon is very
  large the composer computes rollups in a single pass in JS over the streamed rows
  (the price index fits in memory) rather than an O(rows × points) SQL join.
- **Honesty when not-yet-live.** Before go-live, metered doors are skipped so their
  token volume is zero and their cost is `$0`; subscription doors show token volume at
  `$0 (subscription)`. The view states plainly "no paid door is live yet — metered
  spend is $0" so the operator never mistakes an empty view for a broken one.

### Layer 3 — Money gate (O(1), never-cached, fail-closed — Increment B only)

This is the ONLY layer that gates real money, and it is deliberately SEPARATE from the
reporting views (which are analytical and recomputable). It mirrors the bench funnel's
earned rules:

- **Per-key durable counter.** For each metered vault key, a durable
  `metered-spend.<keyRef>` row/file `{ lifetimeUsd, dailyUsd, day, updatedAt }`
  (the bench `metered-rollup` shape). Updated under a per-key lock on every metered
  call using the **two-phase reserve/settle** booking from the funnel: reserve the
  worst-case (`maxTokens` × price) up front, settle the delta after the call. HTTP 402
  and 429 force-settle to $0 (the funnel's phantom-spend guards).
- **O(1) never-cached read at the gate.** Before a metered call, the gate reads the
  counter fresh (never a cached value), compares `spent + estCost` against the cap,
  and **fails closed on any uncertainty** — unreadable counter, unknown price, invalid
  cap, or a `frozen` key all → refuse. Unknown price is never "assume cheap."
- **The gate counter is booked at time-of-use price and is NOT retroactively
  rewritten** by a later price correction. This is deliberate: cap enforcement
  protects *real dollars committed at the moment of the call*; a later re-interpretation
  of price is a REPORTING concern (Layer 2), not a reason to retroactively unblock or
  re-block a call that already happened. The counter is a derived accelerator —
  rebuildable from Layer 0 + the price-as-known-at-booking — but its role is real-time
  protection, and it reflects what was actually spent. (This distinction is a
  Frontloaded Decision, FD-3.)
- **`frozen` kill switch per key** (the bench pattern) — an instant per-key stop that
  fails the gate closed with reason `frozen`.
- **STOP is not PIN-gated; ARM is (the green-PR asymmetry).** Following the deliberate
  money-safety asymmetry of `POST /green-pr-automerge/rollback` (anyone can STOP) vs
  `/enable` (only the operator, PIN-gated, can restart spending): FREEZING a key
  (`POST /routing-spend/caps/freeze` — pure stop) and disarming a paid door are
  Bearer-only (any hand can halt spend instantly), while UNFREEZING, RAISING a cap,
  and going live (arming spend) are PIN-gated (Surface 2). Halting money is always
  cheap; releasing money is always the operator's.

### Surface 1 — Spend view (read-only; Increment A)

- `GET /routing-spend/summary?grain=day&sinceHours=…&scope=pool` → per door/model and
  aggregate rollups (Layer 2), each row `{ door, modelId, doorClass, tokensIn,
  tokensOut, tokensCached, grossUsd, subsidyUsd, creditUsd, netUsd, priceBasis,
  notLiveYet }`, plus `totals` and a `horizonNote` ("total within N-day retention").
- `GET /routing-spend/caps` → each metered key's `{ keyRef, provider, lifetimeCapUsd,
  dailyCapUsd, frozen, lifetimeSpentUsd, dailySpentUsd, pctLifetime, pctDaily,
  goLiveState }` (spend-vs-cap; before Increment B the spend is $0 and `goLiveState:
  "not-live"`).
- Both are **Bearer-auth reads** (like `/metrics/features`), 503 when the feature is
  dark. Dashboard **"Spend" tab** mirrors the existing read-only "LLM Activity" /
  "Routing Map" tab convention: tables, a Refresh, no state-changing inputs.

### Surface 2 — Caps adjust + go-live (PIN-gated writes; Increment B)

- `POST /routing-spend/caps/adjust` `{ pin, keyRef, lifetimeCapUsd?, dailyCapUsd?,
  frozen? }` — **PIN-gated** via the exact `checkMandatePin(req, res)` pattern
  (sha256 + `timingSafeEqual` against `ctx.config.dashboardPin`, IP rate-limited)
  used by `POST /green-pr-automerge/enable` and the Mandate routes. A Bearer token
  without the PIN is refused 403. The write appends to an audited cap-change log and
  updates the durable cap record.
- `POST /routing-spend/go-live` `{ pin, door, enabled }` — **PIN-gated** — arms/disarms
  a paid door (moves it out of `skippedInIncrementA` for THIS agent). Deny-by-default:
  with no go-live record, every metered door stays skipped. Arming is the operator's
  explicit money decision; a Bearer token can never arm spend.
- `GET /routing-spend/caps/log` → the audited cap/go-live change history (who, when,
  old→new), Bearer-read.

### Surface 2 — Alerts (channel-abstracted; Increment C)

- **`AlertChannel` abstraction.** A thin interface `dispatch(alert: SpendAlert):
  Promise<DispatchResult>` with a `kind` discriminator. Increment C ships ONE
  implementation, `TelegramAttentionChannel`, which routes through the existing
  `POST /attention` surface (so it inherits the topic-flood guard, the bounded-
  notification budget, and dedup by attention `id`) into a dedicated **"Routing Spend"
  topic** (`routingSpend.alerts.telegramTopicId`). A future `SlackAlertChannel` is a
  new registry entry + config `routingSpend.alerts.channels: ["telegram","slack"]` —
  **no rework** of the emitters, because emitters produce a channel-neutral
  `SpendAlert` and the dispatcher fans out to configured channels. This reuses the
  established adapter pattern (`AdapterRegistry`, `MessageRouter`, `SlackAdapter`
  already exist).
- **Triggers, each mapped to its severity class (Self-Heal Before Notify):**
  - **Cap hit** (spend crossed a lifetime/daily cap → the gate is now refusing):
    class `recoverable` but **protective** — blocking spend IS the safe direction, so
    there is nothing to self-heal; it emits ONE edge-triggered alert ("key X hit its
    daily cap; metered calls on X are paused until reset/adjust"). The *action* the
    operator can take (adjust the cap) is theirs, PIN-gated.
  - **Approaching cap** (50% / 80% of lifetime, edge-triggered exactly like the bench
    funnel's `alertThresholds`): class `recoverable`, informational — a single
    edge-triggered notice per threshold per window, coalesced into the digest, never a
    repeating stream.
  - **Door dark** (`RouterFailClosedError` — a *critical gate* has no available door):
    class `recoverable` at the door level BUT this alert is placed **downstream of the
    router's own swap-tail self-heal**. A single door going dark is self-healed by the
    router falling through its `swapTail` to the next door — that is `selfHealAttempted`
    and, on success, no escalation. The operator is alerted only when the *whole chain*
    fails closed (`RouterFailClosedError` thrown = swap-tail exhausted =
    `selfHealExhausted`). The watcher declares P19 brakes: `max-attempts` (the finite
    chain length is the natural bound), `dedupe-key` = `spend-door-dark:<chain>`,
    `backoff` (widening re-alert interval per episode), a flapping breaker (N chain-
    exhaustions in a window → reclassify to critical), and `max-notification-latency:
    120s` (a chain fully dark is told promptly even mid-retry).
  - **Fallback used** (`onNatureRoutePlan` reports a `swapTail` position actually
    served the call — the primary door was skipped/failed): class `recoverable`,
    and by definition ALREADY self-healed (a fallback succeeding IS the heal). So a
    single fallback is **digest-only** (rolled into a periodic "fallbacks used: N over
    the last hour" summary), never a per-event escalation — this respects both
    Self-Heal-Before-Notify and the notification-flood guards.
- **Emitters produce channel-neutral `SpendAlert`s**; the dispatcher applies dedup +
  aggregation BEFORE any channel send, so adding Slack later cannot reintroduce flood
  risk.
- **Grounding note — the router signal needs a durable fan-out sink (this spec adds
  it).** `IntelligenceRouter` exposes exactly ONE optional callback `onNatureRoutePlan`
  (not an EventEmitter, no multi-subscriber registry), and its only current consumer
  is a dev-gated `console.log` in `server.ts` (no durable sink, no HTTP surface, the
  path is dev-gated + dryRun). So Increment C must (a) route the single callback
  through a small fan-out so the spend-alert watcher can consume the same
  `NatureRoutePlan` / `RouterFailClosedError` without displacing the existing observer,
  and (b) add a durable scrubbed `logs/routing-spend-alerts.jsonl` sink. The
  `RouterFailClosedError` carries `{ component, resolvedChain }` (no model — by
  definition no door); `NatureRoutePlan` carries the `RouteResolution`
  (`primary` + ordered `swapTail` of `{ door, modelId, clamped }`). These are the exact
  shapes the emitters key on.
- **The flood guard is already channel-agnostic** (`AttentionTopicGuard.decide()`
  operates purely on a source key + priority, with zero Telegram coupling), so the
  dedup/coalescing carries over unchanged to a future Slack channel. What is
  Telegram-bound today is `createAttentionItem` / `createForumTopic` (methods on
  `TelegramAdapter`, NOT on the `MessagingAdapter` interface). The `AlertChannel`
  abstraction sits ABOVE that: `TelegramAttentionChannel` calls the existing
  `POST /attention` (Telegram-bound), and a future `SlackAlertChannel` dispatches to a
  Slack channel/thread directly — the channel-neutral `SpendAlert` + the shared
  dispatcher-level dedup is what makes the Slack add rework-free, NOT a dependency on
  lifting `createAttentionItem` onto every adapter (that broader lift is a separate,
  optional follow-up, not a prerequisite for this feature).

---

## Decision points touched

- **Adds** two PIN-gated money-authority write routes (`/routing-spend/caps/adjust`,
  `/routing-spend/go-live`) — deny-by-default, Bearer structurally insufficient.
- **Adds** an O(1) fail-closed money gate on the metered call path (Increment B) that
  can REFUSE a metered LLM call at cap. This is a new block gate; it fails CLOSED
  (refuse) on every uncertainty, and it composes with — never bypasses — the existing
  router fail-closed / spawn-cap gates.
- **Adds** an alert-emission path (Increment C) that raises operator notices; it is
  routed through the existing `/attention` flood-guarded surface and is downstream of
  self-heal per Standard B.
- **Modifies** the token-ground-truth prune horizon (extends, never shortens) when the
  spend feature is enabled.
- **Does NOT modify** the router's selection logic, the Routing Map (Surface 3), or
  the existing `/metrics/features` / `/tokens/*` routes — those are read byte-for-byte
  unchanged; the `door` column is additive.

## Frontloaded Decisions

These are resolved here so no build-time stop-and-ask is needed. Each is tagged with
its reversibility; the closed non-cheap taxonomy (durable external side-effects,
money, identity, published interface) overrides any "cheap" tag.

- **FD-1 — Ground truth is the existing `feature_metrics` table, extended with a
  nullable `door` column; no USD is ever stored there.** *Not cheap* (durable schema +
  the immutability guarantee), frontloaded. Rationale: reuse the single funnel tap and
  its append-only immutability rather than a parallel ledger that could drift.
- **FD-2 — Prices live in a git-tracked canonical manifest with embedded effective-
  dated history (`unified`), joined as-of; corrections append, never edit.** *Not
  cheap* (money accounting correctness), frontloaded.
- **FD-3 — Cap enforcement uses cost booked at time-of-use price and is NOT
  retroactively rewritten by a later price correction; reporting views DO recompute.**
  *Not cheap* (money-gate semantics), frontloaded. This is the deliberate split
  between real-time protection (immutable booking) and analytical truth (recomputable).
- **FD-4 — Caps are enforced as a POOL-LEASED slice per machine (see Multi-machine
  posture); the conservative go-live default assigns the whole cap to a single
  authoritative "metered lease" machine, so the global cap is never exceeded even
  under partition.** *Not cheap* (money blast radius across machines), frontloaded.
- **FD-5 — Reporting rollups are computed on read (no stored rollup table).** Cheap-to-
  change-after *only in the read-only Increment A* (a pure read surface, reversible by
  revert with no persistent state) — and even so the choice is driven by the non-cheap
  retroactive-recompute requirement, so it is treated as frontloaded, not as a cheap
  tag to be contested.
- **FD-6 — Alerts route through the existing `/attention` flood-guarded surface via a
  channel abstraction; Telegram ships in Increment C, Slack is a later config-add.**
  *Not cheap* (published/user-visible interface + a notify source), frontloaded.
- **FD-7 — Amortized subscription-cost estimation (assigning a synthetic $/token to
  Claude/Codex subscription doors) is OUT OF SCOPE.** Subscription doors show token
  volume at `$0 (subscription)` with a note. Revisiting is a future increment, not a
  build-time decision. *Cheap-to-change-after* (a pure additive view enhancement,
  no ground-truth or money-gate impact) — this tag is offered for contest.
- **FD-8 — The price-refresh cadence job ships OFF by default** (like `doorway-scan`),
  free-probe first (published price pages / model-list APIs), metered/web-verify
  probes manual-only + budget-capped, and refuses to record on an unknown price. It
  only APPENDS price points; it never edits ground truth and never adjusts a cap.
  *Not cheap* (a recurring automated source), frontloaded.

## Multi-machine posture

This is a multi-machine agent. Default posture is `unified`. Every surface's posture
is declared and defended:

- **Token ground truth (`feature_metrics` raw rows): `proxied-on-read`.** Each machine
  records its OWN LLM calls locally (the calls physically happen there — this is the
  exact existing posture of `FeatureMetricsLedger` and `TokenLedger`, both already
  per-machine). The operator-facing spend NUMBER is UNIFIED by a **pool-scope
  fan-out**: `GET /routing-spend/summary?scope=pool` merges each online machine's
  local rollup, mirroring `GET /metrics/features` and `GET /guards?scope=pool`
  exactly — a dark peer degrades to a tagged `pool.failed` row, never a silent
  omission, never a 500. The unified answer is assembled on read; no raw token row
  needs to leave its machine. (This is a merged-read, not an undefended machine-local
  store — no justification key needed.)
- **Price authority (manifest): `unified`.** Git-tracked, identical on every machine,
  reviewed. The per-machine SQLite price index is a regenerable materialized view of
  this unified source, holding no authoritative state — rebuilt from the manifest on
  boot / change. Not machine-local state.
- **Cap authority + money-gate counter: `replicated` via a pool LEASE (money-safety
  critical).** A vault key's dollars can be spent from ANY machine, so a naive
  per-machine cap would let N machines each spend up to the cap = N× overspend — a
  real money blast-radius bug. The cap is enforced as a **pool-leased slice**
  (the same "sum-of-leases bound" mechanism as WS5.2 account-follow-me): the pool
  allocates each machine a slice of the daily/lifetime cap; each machine enforces its
  LOCAL slice O(1) fail-closed; the **sum of all slices ≤ the global cap**, an
  invariant that holds even under partition (a partitioned machine keeps only its
  already-granted slice and can never exceed the global cap). The conservative
  go-live default (FD-4) grants the whole cap to ONE authoritative "metered lease"
  machine, making the global cap single-writer until multi-machine slicing is
  explicitly enabled — the safest possible default. The lease record replicates; the
  local slice + counter is the machine's enforcement copy.
- **Alert emission: `unified` single-voice.** A pool-wide condition (a key hitting its
  GLOBAL cap) must alert ONCE, not once per machine. Alerts are emitted by the
  **metered-lease holder** (the authoritative money machine) with a stable pool-wide
  attention `id` (`spend-cap:<keyRef>:<threshold>:<day>`), so a redelivery or a
  mid-handoff overlap dedups on the `/attention` side rather than double-buzzing the
  operator. Door-dark / fallback alerts key on `<machineId>:<chain>` because they ARE
  machine-specific (a door dark on one machine may be live on another) — the alert
  body names the machine.

No surface is declared `machine-local`, so no `machine-local-justification` marker is
required. The two potentially-machine-local candidates (raw token rows, price index)
are both defended as a merged-read and a regenerable-view-of-unified respectively — not
machine-local state.

## Self-Heal Before Notify — watcher declaration

Only the **alert layer (Increment C)** introduces monitor/notice sources; each is
declared against Standard B:

| Degradation | Class | Self-heal (upstream) | Escalation gate | P19 brakes |
|---|---|---|---|---|
| Door dark (`RouterFailClosedError`) | recoverable | router swap-tail falls to next door (`selfHealAttempted`); escalate ONLY when the whole chain is exhausted (`selfHealExhausted`) | downstream of chain-exhaustion | `max-attempts` = chain length; `dedupe-key` = `spend-door-dark:<machine>:<chain>`; `backoff` widening per episode; flapping breaker (N exhaustions/window → critical); `max-notification-latency: 120s`; `audit-location`: scrubbed jsonl |
| Fallback used (`onNatureRoutePlan` swapTail served) | recoverable | the fallback succeeding IS the heal (already `selfHealExhausted:false`, healed) | digest-only, never per-event | coalesced into an hourly "N fallbacks" summary; `dedupe-key` per chain; no immediate escalation |
| Cap hit | recoverable (protective) | none needed — blocking spend is the safe direction | one edge-triggered notice on the crossing | edge-trigger dedup (`prev < line && now ≥ line`); `dedupe-key` = `spend-cap:<keyRef>:<threshold>:<day>` |
| Approaching 50%/80% | recoverable | n/a informational | one edge-triggered notice per threshold/window | edge-trigger dedup exactly like the bench `alertThresholds`; coalesced into digest |

Composes with No Silent Degradation: every detection + heal-attempt is audited to a
scrubbed metadata-only jsonl (`logs/routing-spend-alerts.jsonl`); the audit trail IS
the report; the operator is the last resort, never the silent-drop alternative. The
first runtime application extracts the door-dark watcher's gate into the reusable
`SelfHealGate` declaration+assertion layer over the existing in-process P19 breakers
(a downstream build task, registered under Close the Loop — not built by this review
lens).

## Increment split (FD-style — what ships when, and behind what gate)

- **Increment A — Read-only spend VIEW (dark, reversible; no money authority).**
  Layer 0 `door` column; Layer 1 price manifest + index + as-of join; Layer 1b subsidy/
  credit model; Layer 2 rollups + `GET /routing-spend/summary` + `GET /routing-spend/caps`
  (read); the dashboard "Spend" tab; the price-refresh job (OFF by default). Ships
  behind `routingSpend.enabled` (dark; routes 503 when off). Shows `$0` / `not-live-yet`
  honestly. **This can ship before any paid door is live.** Reversible by revert; the
  only persistent state is additive/regenerable.
- **Increment B — Money authority (PIN-gated).** Layer 3 O(1) fail-closed money gate
  wired into the metered call path; the pool-lease cap slicing; `POST /routing-spend/
  caps/adjust` (PIN); `POST /routing-spend/go-live` (PIN); the cap-change audit log.
  Deny-by-default: with no go-live record every metered door stays skipped, so B is
  inert until the operator explicitly arms a door with the PIN.
- **Increment C — Alerts (channel-abstracted).** The `AlertChannel` interface +
  `TelegramAttentionChannel`; the door-dark / fallback / cap / approaching emitters
  with their Self-Heal-Before-Notify gates; the dedicated "Routing Spend" topic. Slack
  is a later config-add (a new channel registry entry), no emitter rework.

Each increment is independently reversible and independently gated. The read VIEW
(A) never depends on B or C; money authority (B) never depends on alerts (C).

## Open questions

*(none — all resolved into Frontloaded Decisions above.)*
