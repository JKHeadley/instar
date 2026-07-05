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
Increment A these are DEFINED but always skipped (`skippedInIncrementA`,
`natureRoutingMap.ts:129`), so no paid door routes yet. When they go live, the agent
will spend dollars per token, and the operator has **no production surface** to see
the spend, cap it, or be alerted when it runs away.

Grounding confirms the gap is real and total:
- **Token observability exists, USD does not.** `FeatureMetricsLedger`
  (`src/monitoring/FeatureMetricsLedger.ts`) records every INTERNAL LLM call to a
  durable SQLite table `feature_metrics` (`ts`, `tokens_in`, `tokens_out`,
  `tokens_cached`, `model`, `framework`, `outcome`), per feature×model×framework via
  the single funnel tap `setFeatureMetricsRecorder(...)` (wired at
  `AgentServer.ts:1104`). It stores **tokens only — no USD column** and exposes **a
  single rolling `sinceHours` window — no hourly/daily/monthly buckets**. Critically,
  it is by explicit design a **best-effort, read-only observability side-channel**:
  `record()` wraps the insert in `catch {}` ("Swallow write errors"), a failed
  `ALTER` degrades a new column to silent NULLs, and its docstring says it "NEVER
  gates, blocks, or mutates any flow." **This makes it a legitimate REPORTING source
  but a forbidden MONEY-GATE ground truth** (see the accounting split below — this
  spec does NOT gate money on `feature_metrics`).
- **A production USD cost ledger already exists.** `src/core/DriftSpendLedger.ts` is a
  daily-rotated, `proper-lockfile`-coordinated, append-only reserve/reconcile USD
  ledger with a strict `spent + est > cap → reject` gate and a per-machine cap whose
  atomic cross-machine variant is an explicitly-deferred child
  (`drift-spend-cross-machine`, `DriftSpendLedger.ts:26-31`). This spec's money layer
  REUSES its earned write-discipline and CLOSES that deferred child (§Money layer).
- **USD/cap/alert *routing* patterns exist ONLY bench-side.** The metered-funnel
  research code (`metered-funnel.mjs` + `metered-caps.json` + `metered-prices.json`)
  has a mature pattern — `settleCost` (tokens×price/1e6), a lifetime+daily rollup,
  a `frozen` kill switch, per-key caps, and edge-triggered 50%/80% alerts to
  `POST /attention`. **Grounding-honesty note:** those files live on the research
  branch (`echo/serve-main`), NOT on canonical `JKHeadley/main`, so an implementer
  grounding on main will not find them. This spec therefore **vendors the exact
  earned logic** (settleCost / two-phase reserve-settle / no-charge-force-settle /
  frozen / edge-triggered thresholds) into `src/` as canonical production code rather
  than referencing an off-branch path (§Money layer, §Vendored bench logic).

This spec designs **Surfaces 1 (spend tracking + rollups + view) and 2 (caps display
+ PIN-gated adjust + alerts)** as production features, built on the token
observability that already exists (for REPORTING), a NEW authoritative booking-priced
spend ledger (for the money GATE), the DriftSpendLedger write-discipline, and every
money / blast-radius / multi-machine / maturation standard in the constitution.

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
   cap; the adjust control (and the paid-door go-live flip) is **PIN-gated** and
   **phone-complete** (a dashboard form, not a curl).
6. **Alerts — Telegram-FIRST, Slack-extensible** — a dedicated topic firing on cap
   hit (and approaching 50%/80%), a door going dark, and a fallback being used;
   routed through a channel abstraction so Slack adds later without rework.

## Design principles this spec is bound by

- **Money blast radius (Bounded Blast Radius).** The counter that GATES money is
  O(1), never-cached, fail-closed at cap, and reads its own AUTHORITATIVE
  booking-priced ledger — never the best-effort `feature_metrics` observability table.
- **Immutable ground truth + retroactive recompute (No Silent Degradation applied to
  accounting).** Token records are append-only; a price correction NEVER mutates a
  usage record — it recomputes derived cost in the REPORTING layer only. The money
  GATE books at time-of-use price and is NEVER retroactively rewritten.
- **Deny-by-default for money authority (The Operator Channel Is Sacred / Know Your
  Principal).** Changing a cap or arming a paid door requires the dashboard PIN; a
  Bearer token — including via `PATCH /config` — is structurally insufficient.
- **Signal vs Authority.** The money gate's blocking authority is NARROW: a
  cap-refusal is a per-door SKIP (advance the swap-tail to the next, often free, door)
  — it never wedges the whole LLM path.
- **Self-Heal Before Notify.** A door-dark alert sits DOWNSTREAM of the router's own
  swap-tail self-heal; the operator hears about it only when self-heal is exhausted.
- **Maturation Path.** The read-only view ships ENABLED on developer agents (dark on
  fleet); the money-authority controls are the documented action-bearing exclusion.
- **Everything dark/reversible.** Increment A (read view) → B (money authority) → C
  (alerts) are independently gated and reversible.

---

## Proposed design

The design has FIVE durable layers and three read/write surfaces, split across three
increments. The **layering is the safety architecture** and its load-bearing move is
the **accounting split**:

- **REPORTING** truth (analytical, recomputable): immutable tokens
  (`feature_metrics`, Layer 0) → price authority (versioned, as-of; Layer 1) →
  subsidy/credit (Layer 1b) → derived rollups (Layer 2). This side answers "what did
  we spend?" and RECOMPUTES when a price is corrected. It is best-effort and may
  under-count on a dropped observability write — which is why it never gates money.
- **MONEY** truth (authoritative, protective): a NEW booking-priced
  `MeteredSpendLedger` (Layer 3) that the O(1) gate reads and writes, fail-closed,
  non-swallowing, with reserve/settle + a reconciliation sweep. This side answers
  "may this call spend?" and NEVER recomputes — it protects real dollars committed at
  the moment of the call.

Corrections flow DOWN the REPORTING side; nothing flows up into token ground truth,
and NOTHING from the reporting side ever moves the money gate.

### Layer 0 — Token ground truth for REPORTING (REUSE `feature_metrics`, add a `door` dimension)

The append-only SQLite table `feature_metrics` is already the timestamped, immutable
token record required by Requirement 1 — **for reporting**. We make ONE additive,
non-destructive change:

- Add a nullable `door TEXT` column via the existing idempotent `ensureAddedColumns()`
  pattern (pragma-guarded `ALTER TABLE`, exactly like `framework`/`tokens_cached`).
  **Completeness (I-4):** the column add ALONE is insufficient — `FeatureMetricRecord`
  (the type), `record()` (the writer), and the prepared `INSERT` column list
  (`FeatureMetricsLedger.ts:281-285`) must ALL gain `door`, or the ALTER lands and the
  writer never populates it. This is a wiring-integrity test target.
- Records remain **append-only and never mutated**. No USD column is ever added to
  this table — cost is always a read-time join (Layer 2). This is the structural
  guarantee behind "re-calculate as needed later" for reporting.
- **`door` is DERIVED at the funnel, single-sourced with the gate (I-1/S-F6/A-M8).**
  See §"Door attribution — scope + single-source" below. In Increment A the metered
  doors do not route yet, so metered rows do not exist and `door` is NULL/`unknown` on
  all pre-attribution rows; the Layer-2 composer renders NULL-`door` token volume as
  **uncosted** (never a crash, never a fabricated $0 — A-Min15).
- **Retention is decoupled from spend history (see Layer 2 / scal-F3).** This table
  keeps its short default horizon (30d) for raw rows; the long spend history lives in
  the small maintained daily token rollup, NOT in 400 days of raw per-call rows.

### Layer 1 — Price authority (versioned, timestamped, git-tracked = `unified`)

Requirement 2 needs a price *history* joined as-of each usage record. The
authoritative price record is a **git-tracked canonical manifest**
`scripts/routing-prices.manifest.json` — the same convention as
`scripts/model-registry-freshness.manifest.json` — with **embedded effective-dated
history**:

```jsonc
{
  "schemaVersion": 1,
  "_doc": "USD per MILLION tokens, per door+model, effective-dated. Append-only: a change/correction ADDS a point; points are never edited in place. GENERIC PUBLISHED prices only — operator-specific deals live in the machine-local overlay, not here.",
  "points": [
    {
      "door": "openrouter-api",
      "modelId": "openai/gpt-5.5",              // MUST equal resolvePositionModelId() output, normalized (see key-canonicalization)
      "inPerMtok": 5.0,
      "outPerMtok": 30.0,
      "effectiveAt": "2026-07-01T00:00:00Z",    // price in effect FROM this instant
      "recordedAt": "2026-07-01T18:00:00Z",      // when we learned it
      "reviewed": true,                          // TRUE only for a git-committed / operator-confirmed point (gate-eligible)
      "source": "openrouter-models-api",         // provenance
      "corrects": null                           // a prior effectiveAt this row FIXES; only a PIN/human action may set it (A-M7)
    }
  ]
}
```

- **Key canonicalization (I-5 — the casing/model-string bug).** THREE model strings
  are in play: the chain LABEL (`flash-lite`, `gpt-5.5`), the resolved id via
  `ROUTING_LABEL_TO_MODEL_ID` (`gemini-3.1-flash-lite`, `openai/gpt-5.5`,
  `openai/gpt-oss-120b` — lowercase), and what `onModel` reports into
  `feature_metrics.model`. The join key is **`(door, canonical(modelId))`** where
  `canonical()` is a single normalizer (lowercase, provider-prefix rules) applied
  identically to the manifest point, the recorded `model`, and `resolvePositionModelId()`.
  It is a **wiring contract** that a metered provider reports
  `onModel.model === resolvePositionModelId(pos)`; a test asserts manifest points
  round-trip through `canonical()`. (The round-0 example's `openai/gpt-oss-120B` was a
  case mismatch against the resolver's lowercase id — normalization removes the class.)
- **As-of join (core of Requirement 2).** For a usage record at time `ts` for
  `(door, canonical(modelId))`, cost uses the price point with the greatest
  `effectiveAt ≤ ts` (and, among rows sharing an `effectiveAt`, the greatest
  `recordedAt` — so a `corrects` row supersedes the wrong one). Deterministic:
  `cost = tokensIn/1e6 * inPerMtok + tokensOut/1e6 * outPerMtok` (the vendored
  `settleCost`).
- **A join-MISS is loud, never $0 (I-5/A-Min15).** A recorded `(door, model)` with no
  matching price point renders a distinct `priceBasis: "no-matching-point"` row with
  `unpricedTokensIn/Out` in the Layer-2 view — never silently costed at $0 (which
  would under-report real spend on precisely the paid doors that matter). The money
  GATE treats an unknown/unpriced door as `unknown-price → fail closed`.
- **A correction never mutates ground truth or a prior price row.** A wrong past price
  is fixed by APPENDING a point with the same/covering `effectiveAt`, a later
  `recordedAt`, and `corrects` set. Reporting views recompute automatically. **Only a
  human/PIN action may write a `corrects` row or a backdated `effectiveAt`** — the
  cadenced refresh job is forward-only (FD-8/FD-14/A-M7).
- **Subscription/CLI doors are honestly $0-per-token.** `claude-code`, `codex-cli`,
  `pi-cli`, `gemini-cli` are subscription/OAuth doors — points are
  `inPerMtok: 0, outPerMtok: 0, source: "subscription-not-per-token"`. The view shows
  their TOKEN volume with a `$0 (subscription)` cost and a note that reads "not
  per-token billed" — never a fabricated dollar figure, and the note is worded so an
  operator cannot misread `$0` as "barely spending" (FD-7; the subscription IS their
  biggest real cost, just not per-token).
- **Only REVIEWED, gate-eligible points reach the money gate (S-F1).** The manifest
  carries `reviewed: true` only on git-committed / operator-confirmed points. The
  money gate (Layer 3) consumes ONLY reviewed points; an auto-appended refresh point
  (FD-8) feeds REPORTING until an operator confirms it. Git-tracking is an AUDIT
  trail, not an admission gate — an unattended probe can never move the gate.
- **Price validation, fail-closed (A-M5/S-F1 plausibility floor).** At load AND at the
  gate: `inPerMtok, outPerMtok ≥ 0`, effective price `≥ 0`, and (for the gate) at or
  above a per-provider sane MINIMUM. Any violation → `unknown-price` → fail closed
  (never "assume cheap," never "assume negative"). A manifest-lint CI check enforces
  the ranges at commit time.
- **Freshness SLA + stale-price behavior (X-C1/X-G1).** Each door declares a max price
  age. When the newest reviewed point for a door is older than its SLA, the REPORTING
  view flags `priceStale: true`, and the money GATE either fails closed or books at a
  configured conservative-MAX price for that door (operator choice; default =
  conservative-max so spend continues but never under-books). Staleness is surfaced,
  never silent.
- **Machine-local read index (NOT authoritative), refreshed on running machines
  (X-G3).** On load, each machine builds a read-only SQLite index of the manifest's
  points for fast as-of joins. This index is a **regenerable materialized view of the
  `unified` git source** — no authoritative state. It rebuilds on boot AND when the
  manifest mtime/hash changes, detected by a lightweight periodic poll of the manifest
  file (same cadence class as other file-watch reloads) — so a `git pull` that updates
  the manifest reaches a RUNNING machine without a restart.

#### Layer 1b — Subsidy / credit model (REPORTING-ONLY; never reaches the gate)

Requirement 3's subsidies/credits are a **reporting-layer** concept. **The money gate
applies NO downward adjustment — neither a per-token subsidy NOR a lump-sum credit
ever reaches Layer 3** (reconciles decision-completeness G3 with security S-F1). This
is the safe direction: a subsidy/credit can only make the *report* rosier, never
loosen the cap.

- **Per-token subsidy / discount** (REPORTING): a price point's optional `subsidy`
  field — `{ kind: "discount-frac", value }` with `value ∈ [0,1)` (multiply price by
  `1−value`), or `{ kind: "flat-per-mtok", inPerMtok≥0, outPerMtok≥0 }`. Validated at
  load; an out-of-range subsidy is rejected (A-M5). Applied ONLY in the read-time
  reporting join, never in the gate.
- **Lump-sum credit** (REPORTING): a separate append-only `credits` ledger
  `{ keyRef, amountUsd, grantedAt, expiresAt, note }`. Applied at ROLLUP time as a
  *net* line (gross / credit applied / net shown). `expiresAt` is REQUIRED
  (A-Min12) — an expired/exhausted credit stops offsetting; GROSS is always shown
  prominently next to net so a credit can never read as headroom against the cap.
- **Operator-specific deals live in a machine/agent-local overlay (G7).** The git
  manifest carries GENERIC published prices only. An operator-specific subsidy/credit
  ("this model is 20% off for us", "$50 free credits") lives in a machine/agent-local
  overlay `.instar/routing-prices.overlay.json` that layers over the manifest at
  as-of-join time — REPORTING only, so it never reaches the gate and never
  misapplies to another agent that pulls the repo. Both are append-only and reversible
  (a mistake is corrected by an offsetting/superseding row, never by editing history).

### Layer 2 — Derived REPORTING views & rollups (immutable token pre-aggregate + price on read)

Requirement 4 (hourly/daily/monthly/total) is served WITHOUT freezing the event loop
and WITHOUT hoarding raw rows (scal-F1/F2/F3):

- **Pre-aggregate the IMMUTABLE fact, join the MUTABLE dimension on read.** A
  maintained rollup table `spend_token_rollup(day, door, modelId, tokensIn, tokensOut,
  tokensCached)` holds ONLY token sums per UTC day — which are provably untouched by
  any price/subsidy/credit correction (the immutability centerpiece). Price and
  subsidy are applied on READ over these daily buckets; credits at rollup time. This
  fully preserves retroactive-recompute (a price fix instantly reflows) while
  collapsing a report from potentially tens of millions of raw rows to
  `days × doors × models` (hundreds–low-thousands). The round-0 "no stored rollup"
  reasoning was correct only for a stored COST rollup; a stored TOKEN rollup never
  goes stale.
- **Hourly grain (the finest requirement).** Hourly rollups are computed on read over
  the raw `feature_metrics` rows within the SHORT (30d) raw-retention window (bounded,
  indexed on `ts`) — hourly detail beyond 30d is not offered (surfaced honestly in the
  view). Daily/monthly/total are served from the daily token rollup and thus survive
  400 days.
- **Retention decoupled (scal-F3).** Raw `feature_metrics` rows stay at 30d;
  `spend_token_rollup` is retained `routingSpend.tokenRollupRetentionDays` (default
  **400**). "Total" is honestly "total within the 400-day rollup horizon"
  (`horizonNote` in the view). This keeps the raw table small on laptop-class machines
  (the disk/OOM-incident hardware) while lifetime/monthly spend survives.
- **Never freeze the event loop (scal-F1/F7).** The daily-bucket read is small and
  synchronous-safe. Any genuinely large detect (e.g. a full 400-day monthly report
  recomputed live) runs in a **worker thread serving a cached snapshot** — the exact
  cartographer #1069 pattern already in the tree — above a concrete row/window
  threshold. The rare price-boundary day (a price change mid-day) is the only day that
  needs raw-row splitting; it is computed streaming with `.iterate()`, never `.all()`.
- **The daily token rollup is maintained cheaply.** On each `feature_metrics` insert
  the day's bucket is upserted (`INSERT … ON CONFLICT(day,door,modelId) DO UPDATE`);
  the `door` for pre-attribution/CLI rows follows §Door attribution. A boot-time
  backfill (bounded, batched) reconstructs the rollup from raw rows if it is missing.
- **The retention prune is batched (scal-F4).** `feature_metrics.pruneOlderThan` today
  is a single unbounded `DELETE`; on a transition/backlog it is a multi-million-row
  synchronous DELETE holding the WAL lock. Change it to a bounded `DELETE … LIMIT N`
  loop with a per-tick ceiling and yields between batches.
- **Honesty when not-yet-live.** Before go-live, metered doors are skipped so their
  token volume is zero and their cost is `$0`; subscription doors show volume at
  `$0 (subscription)`. The view states plainly "no paid door is live yet — metered
  spend is $0" so the operator never mistakes an empty view for a broken one.
- **Two spend numbers, both labeled (A-M10/X-C2).** The REPORTING net (recomputed at
  CURRENT price/subsidy/credit) and the GATE's committed figure (booked at time-of-use
  price) are DESIGNED to differ after any correction/credit. The view labels them
  explicitly — "recomputed at current price, net of credits" vs "committed at time of
  use (what the cap enforces)" — plus a one-line note that the cap enforces the
  committed figure. An unexplained discrepancy on a money surface is a trust failure.

### Layer 3 — MONEY layer: authoritative booking-priced ledger + O(1) fail-closed gate (Increment B)

This is the ONLY layer that gates real money. It is deliberately SEPARATE from the
recomputable reporting views and does NOT read `feature_metrics`.

- **A NEW authoritative append-only booking ledger, `MeteredSpendLedger` (LF-F1 /
  A-B1 / I-2).** Per metered vault key, a durable append-only ledger records each
  booking row `{ ts, keyRef, door, modelId, kind: 'reserve'|'settle', costUsd (at
  BOOKING price), leaseEpoch }` PLUS a maintained O(1) running total
  `{ keyRef, committedLifetimeUsd, committedDayUsd, dayEpoch, updatedAt }`. This ledger
  — not `feature_metrics` — is the AUTHORITATIVE money truth and the ONLY rebuild
  source: `committed*` is a fold of the ledger rows. **Rebuild-from-Layer-0-joined-to-
  current-prices is explicitly FORBIDDEN at the gate** (it would apply corrected
  prices in the dangerous direction — a downward `corrects` row would lower the
  counter and re-open capped headroom). The ledger's writes are **fail-closed and
  non-swallowing** (unlike `feature_metrics.record()`): a write that cannot be durably
  persisted refuses the call. It adopts `DriftSpendLedger`'s earned discipline
  (append-only rows, `proper-lockfile`, crash-leaves-a-reservation, malformed-row-skip)
  with an O(1) MAINTAINED total instead of DriftSpendLedger's O(rows-in-day) full-file
  tally.
- **Build-vs-reuse decision vs DriftSpendLedger (I-2/LF-F5, FD-17).** We build a NEW
  ledger (distinct spend domain: metered routing vs drift-checks) that REUSES
  DriftSpendLedger's write-discipline, because Layer 3 needs an **O(1) never-cached**
  read at the gate while `DriftSpendLedger.tallySpent` is O(rows-in-day). The shared
  pool-lease (below) CLOSES DriftSpendLedger's deferred `drift-spend-cross-machine`
  child; a follow-up (Close the Loop, registered) migrates drift-checks onto the same
  substrate. The two ledgers never overlap in domain.
- **Two-phase reserve/settle with a reconciliation sweep (A-B2 / scal-F5).** Reserve
  the worst-case (`maxTokens × BASE price`) up front UNDER the per-key lock, make the
  provider call OUTSIDE the lock, settle the delta UNDER the lock after. **Lock scope
  is pinned:** held ONLY for the two short booking critical sections, RELEASED during
  the LLM round-trip (so metered throughput is not serialized). **Process scope is
  pinned:** metered calls funnel through the single server process, so an in-process
  async mutex is correct; if multi-process issuance ever becomes possible the ledger
  uses the same `proper-lockfile` advisory lock DriftSpendLedger uses. A
  **reconciliation sweep** at boot + on a cadence folds any `reserve` row with no
  matching `settle` after a TTL back to actual (via the paired settle if present, else
  expires the phantom) — so a crash between reserve and settle cannot permanently leak
  worst-case headroom.
- **ALL no-charge outcomes force-settle to $0 (A-B2).** Not just 402/429: a
  5xx / timeout / abort / connection error settles to $0 UNLESS tokens were
  demonstrably returned. Force-settle keys on the REAL fetch HTTP status / outcome
  only (a 200 always books actual-or-worst-case). This closes the flapping-door
  phantom-spend that would otherwise monotonically consume headroom on zero real spend.
- **O(1) never-cached, fail-closed, lease-fenced read at the gate (A-B4).** Before a
  metered call the gate reads the committed total FRESH (never cached), reads the
  door's REVIEWED, VALIDATED price, computes `estCost = tokens × BASE price` (NO
  subsidy/credit — Layer 1b never reaches here), and refuses when
  `committed + estCost > cap` (strict `>`, the DriftSpendLedger boundary). It **fails
  closed on EVERY uncertainty** — unreadable ledger, unknown/unpriced/implausible
  price, invalid cap, `frozen` key, OR a stale lease epoch. **Every call re-validates
  the slice's lease epoch** (`localSliceEpoch < currentLeaseEpoch → fail closed`; the
  epoch is cached and invalidated on lease-pull) so a partitioned/reclaimed
  metered-lease holder cannot keep spending against a stale local counter.
- **The counter is booked at time-of-use BASE price and is NOT retroactively
  rewritten** by a later price correction (FD-3). This is deliberate: cap enforcement
  protects real dollars committed at the moment of the call; a later re-interpretation
  of price is a REPORTING concern (Layer 2), never a reason to retroactively unblock a
  call that already happened.
- **A money-gate refusal is a SWAP-TAIL ADVANCE, not a chain kill (LF-A2 — Signal vs
  Authority).** When the gate refuses a metered door at cap, the router treats it
  identically to a DARK door: it advances the `swapTail` to the next position (often a
  free CLI/subscription door). The chain fails closed with `RouterFailClosedError`
  ONLY when every door — including the free tails — is unavailable. Hitting a dollar
  cap never takes down a job-kind that has a free fallback; the money gate's blocking
  authority is narrow by construction.
- **`frozen` kill switch per key** — an instant per-key stop that fails the gate closed
  with reason `frozen`. Freeze halts NEW admissions only; an in-flight reserved call
  settles its real cost (A-Min11). Cap/freeze writes are atomic (tmp+rename); a
  caps-read failure fails CLOSED (refuse), never crashes the gate.
- **STOP is Bearer; ARM is PIN (the green-PR asymmetry) — with scoped STOP (S-F5 /
  X-C5).** Following `POST /green-pr-automerge/rollback` (anyone STOPs) vs `/enable`
  (PIN RELEASE): FREEZING a key and disarming a paid door are Bearer-accessible (any
  hand halts spend instantly); UNFREEZING, RAISING a cap, and going live are PIN-gated.
  The Bearer freeze route is **set-true-only** (accepts no cap numbers, cannot toggle
  to false), and every STOP records the actor for audit. Halting money is always
  cheap; releasing money is always the operator's.

### Door attribution — scope + single-source (I-1 / LF-F3 / A-M8 / GF1)

The `door` join key is load-bearing, and grounding shows it does NOT yet reach a
recorded row — this spec is HONEST about the dependency rather than asserting it done:

- **Today's reality (verified against `JKHeadley/main` v1.3.780):** the metrics tap
  `CircuitBreakingIntelligenceProvider.recordMetric` writes `model`/`framework` from
  the inner framework provider's `onModel` — which has **no notion of a door**;
  `resolveRoute` runs observe-only/dryRun and falls through to the LEGACY category
  path (nature-routing ENFORCEMENT — dispatching to the resolved door — is the unbuilt
  "A2.2 remainder", `warnNatureEnforceNotWired()`); and the metered doors have **no
  provider implementation at all** (the router `continue`s past them at
  `IntelligenceRouter.ts:821`).
- **Therefore, honestly:** real per-door money attribution and the money GATE's
  wiring into the metered call path DEPEND on separate, in-flight S4 work — the
  nature-routing enforcement dispatch (A2.2) and the metered provider implementations —
  which are **OUT OF THIS SPEC'S SCOPE**. This spec designs the surfaces, the
  reporting/pricing/rollup layers, and the money-ledger + gate; it declares the
  integration SEAM they plug into. **Increment A ships with metered `door` NULL and
  honest `$0`** precisely because metered doors do not route yet (the safe, truthful
  display).
- **The seam (single-source contract, A-M8).** When metered dispatch lands, the door
  is resolved ONCE at the point of the metered call and stamped into
  `IntelligenceOptions.attribution.door`; the router passes it to `primary.evaluate`;
  `recordMetric` reads `options.attribution.door` into `extra.door`; and the money
  gate books against the SAME resolved `(keyRef → door → price)` tuple. Invariant +
  wiring test: `feature_metrics.door === gate.keyRef.door` for every metered call, and
  a metered `keyRef` can NEVER resolve to a `$0`/subscription price (S-F6). Interim:
  CLI-door rows may derive `door = framework` (they coincide 1:1); only metered doors
  (where door ≠ framework — the motivating case) require the stamped thread.

### Surface 1 — Spend view (read-only; Increment A)

- `GET /routing-spend/summary?grain=day&sinceHours=…&scope=pool` → per door/model and
  aggregate rollups (Layer 2), each row `{ door, modelId, doorClass, tokensIn,
  tokensOut, tokensCached, grossUsd, subsidyUsd, creditUsd, netUsd, committedUsd,
  priceBasis, priceStale, notLiveYet }`, plus `totals`, a `horizonNote`, and any
  `unpricedTokens`/`no-matching-point` rows surfaced loudly.
- `GET /routing-spend/caps` → each metered key's `{ keyRef, provider, lifetimeCapUsd,
  dailyCapUsd, frozen, committedLifetimeUsd, committedDayUsd, pctLifetime, pctDaily,
  goLiveState, coverageOk }` — spend-vs-cap from the AUTHORITATIVE ledger (LF-F2);
  before Increment B committed is $0 and `goLiveState: "not-live"`. `coverageOk`
  surfaces any reporting-vs-ledger divergence so an under-count is visible.
- Both are **Bearer-auth reads** (like `/metrics/features`), 503 when dark. Dashboard
  **"Spend" tab** mirrors the read-only "LLM Activity" / "Routing Map" tab convention.

### Surface 2 — Caps adjust + go-live (PIN-gated writes; phone-complete; Increment B)

- **State lives in a DEDICATED PIN-only store, never in config (S-F2).** Caps + go-live
  records live in `state/routing-spend-caps.json` (or a dedicated table), written ONLY
  by the PIN routes below. They are NEVER stored under any key in
  `PATCHABLE_CONFIG_KEYS`, so `PATCH /config` (Bearer, deep-merge) can never arm a
  door, unfreeze a key, or raise a cap. A regression test asserts a Bearer
  `PATCH /config` cannot arm/unfreeze/raise. Only inert knobs
  (`routingSpend.enabled` dark-toggle, retention days, `alerts.telegramTopicId`,
  `alerts.channels`) live in config.
- `POST /routing-spend/caps/adjust` `{ pin, keyRef, lifetimeCapUsd?, dailyCapUsd?,
  frozen? }` — **PIN-gated** via `checkMandatePin` (`routes.ts:9044`; sha256 +
  `timingSafeEqual` + per-IP rate-limit; the counter is backed durably so a restart
  does not reset brute-force protection, and XFF is not honored on `/routing-spend/*`
  PIN routes — S-F9). **Cap-LOWERING is fenced/acknowledged (A-M9):** it bumps the
  lease epoch and forces slice re-derivation; the local gate re-reads the cap on its
  next O(1) read and clamps immediately. Raising is monotonic-safe. Appends to an
  audited cap-change log.
- `POST /routing-spend/go-live` `{ pin, door, enabled }` — **PIN-gated** — arms/disarms
  a paid door for THIS agent and DESIGNATES the metered-lease machine (default: the
  current serving-lease holder — FD-13). Deny-by-default: with no go-live record every
  metered door stays skipped.
- **Server-authored proposal, not raw data entry (CG3 / B2 — Agent Proposes, Operator
  Approves).** The dashboard renders a server-authored plain-language plan ("Arm
  openrouter-api at daily $X / lifetime $Y — approve?") from a prefilled structured
  request; the PIN AUTHORIZES the plan. The operator approves; they do not author raw
  fields.
- **Phone-complete dashboard controls (CG2 / B1 — Mobile-Complete + surface quality).**
  The Spend tab gains a PIN-gated controls section (the Mandates-tab grant-form shape):
  leads with the primary action, exposes zero raw internals (no JSON bounds / no vault
  key values), de-emphasizes destructive actions, works at phone width. Freeze/disarm
  are Bearer-accessible buttons; adjust/unfreeze/go-live require the dashboard PIN.
- `GET /routing-spend/caps/log` → the audited cap/go-live change history (who, when,
  old→new), Bearer-read.
- **Credit/subsidy WRITE authority (S-F3).** Credits/subsidies are either
  (a) git-manifest / machine-local-overlay only (no runtime write route; FD-8 is
  FORBIDDEN from writing credit/subsidy rows), or (b) written via a PIN-gated
  append-only audited route mirroring `caps/adjust`. Either way they are REPORTING-only
  and never reach Layer 3.

### Surface 2 — Alerts (channel-abstracted; Increment C)

- **`AlertChannel` abstraction.** A thin interface `dispatch(alert: SpendAlert):
  Promise<DispatchResult>` with a `kind` discriminator. Increment C ships ONE
  implementation, `TelegramAttentionChannel`, routing through `POST /attention` (so it
  inherits the topic-flood guard, the bounded-notification budget, and dedup) into a
  dedicated **"Routing Spend"** topic (`routingSpend.alerts.telegramTopicId`). A future
  `SlackAlertChannel` is a new registry entry + `alerts.channels: ["telegram","slack"]`
  — no emitter rework, because emitters produce a channel-neutral `SpendAlert` and the
  dispatcher fans out. The flood guard (`AttentionTopicGuard.decide()`) is already
  channel-agnostic (source key + priority), so its dedup/coalescing carries to Slack.
- **Money-critical alerts are never dropped for a missing topic (G5 — Always
  Reachable).** If `telegramTopicId` is unset, cap-hit and chain-exhausted door-dark
  alerts FALL BACK to the lifeline/system topic (a money alert is never dropped for
  lack of a configured topic). The "Routing Spend" topic is created once via
  `createForumTopic` under the bounded-notification budget on first alert, or is
  operator-configured; the fallback covers the gap either way.
- **Cap-hit and cap-approaching use a DISTINCT attention `source` (S-F8)** from
  door-dark/fallback, so a flapping door's volume can never coalesce a money-critical
  cap alert into a digest and delay operator awareness.
- **Triggers, each mapped to its severity class (Self-Heal Before Notify):**
  - **Cap hit** (a reservation would cross a cap → the gate is now refusing): class
    `recoverable` but protective — blocking spend IS the safe direction. ONE
    edge-triggered alert, worded honestly ("a reservation would exceed key X's daily
    cap; metered calls on X are paused until reset/adjust", showing actual-vs-reserved
    — A-Min13). The adjust action is the operator's, PIN-gated.
  - **Approaching cap** (50% / 80%) fires on **BOTH the daily AND the lifetime cap
    (G4)**, edge-triggered independently per (cap-kind, threshold, window); dedupe-key
    `spend-approach:<keyRef>:<capKind>:<threshold>:<window>`. Coalesced into the digest.
  - **Door dark** (`RouterFailClosedError` — a critical gate has no available door):
    placed DOWNSTREAM of the router's own swap-tail self-heal. Escalates only when the
    WHOLE chain fails closed (`selfHealExhausted`). P19 brakes: `max-attempts` = chain
    length; `dedupe-key` = `spend-door-dark:<machineId>:<chain>:<episodeBucket>` (the
    coarse episode/time bucket lets a post-heal re-dark re-alert while intra-episode
    retries dedup — A-Min14); widening `backoff`; a flapping breaker (N exhaustions/
    window → reclassify critical, which bypasses coalescing); `max-notification-latency:
    120s`; scrubbed jsonl audit.
  - **Fallback used** (`onNatureRoutePlan` reports a `swapTail` position served): by
    definition already self-healed → **digest-only** ("N fallbacks used over the last
    hour"), never a per-event escalation.
- **Alert/audit scrub is metadata-ONLY (S-F7).** The record carries door, chain,
  threshold, machineId, reason-code, counts — NEVER a provider response/error body (the
  bench slices an 800-char `errorDetail` that can echo a `Bearer`/`sk-` fragment) and
  never any key-shaped substring. A redaction pass at the sink is tested against a
  poisoned provider error body. The alert-dispatch auth token is never serialized.
- **Grounding — the router signal needs a fan-out sink (this spec adds it), and it is
  a DEPENDENCY (I-9).** `IntelligenceRouter` exposes ONE optional callback
  `onNatureRoutePlan` (not an EventEmitter), whose only consumer is a dev-gated
  `console.log`. Increment C (a) routes it through a small fan-out so the spend-alert
  watcher consumes the same `NatureRoutePlan`/`RouterFailClosedError` without
  displacing the existing observer (preserving its throw-swallow isolation — one
  subscriber throwing must never break the LLM path or double-fire the other), and
  (b) adds a durable scrubbed `logs/routing-spend-alerts.jsonl` sink. **The plan is
  only emitted when `sessions.natureRouting.enabled` resolves truthy**, so Increment
  C's door-dark/fallback alerts are INERT until nature-routing observation is enabled —
  stated as an explicit cross-increment dependency.
- **Emitters produce channel-neutral `SpendAlert`s**; the dispatcher applies dedup +
  aggregation BEFORE any channel send, so adding Slack later cannot reintroduce flood
  risk. The new dispatcher's OWN dedup/coalescing gets a burst-invariant test (in
  addition to the `/attention` path's existing burst test — B5).

---

## Decision points touched

- **Adds** a NEW authoritative `MeteredSpendLedger` (booking-priced, fail-closed) as
  the money-gate ground truth — SEPARATE from `feature_metrics` (which stays
  reporting-only).
- **Adds** two PIN-gated money-authority write routes (`/routing-spend/caps/adjust`,
  `/routing-spend/go-live`) whose state lives in a dedicated store OUTSIDE
  `PATCHABLE_CONFIG_KEYS` — deny-by-default, Bearer (incl. `PATCH /config`)
  structurally insufficient.
- **Adds** an O(1) fail-closed, lease-fenced money gate on the metered call path
  (Increment B) that REFUSES a metered call at cap — and does so as a swap-tail ADVANCE
  (never a chain kill). Fails CLOSED on every uncertainty; composes with, never
  bypasses, the router fail-closed / spawn-cap gates.
- **Adds** an alert-emission path (Increment C) routed through the flood-guarded
  `/attention` surface, downstream of self-heal, with a lifeline fallback for
  money-critical alerts.
- **Adds** a nullable `door` column to `feature_metrics` (+ `FeatureMetricRecord` +
  `record()` + INSERT) and a maintained `spend_token_rollup` table.
- **Modifies** the token-prune to a batched delete; adds the daily-token-rollup
  retention (extends spend history without extending raw-row retention).
- **Depends on (out of scope):** nature-routing enforcement (A2.2) + metered provider
  implementations for real per-door attribution + live money-gating; nature-routing
  observation enablement for Increment C alerts.
- **Does NOT modify** the router's selection logic, the Routing Map (Surface 3), or
  the existing `/metrics/features` / `/tokens/*` routes.

## Frontloaded Decisions

Each is tagged with its reversibility; the closed non-cheap taxonomy (durable external
side-effects, money, identity, published interface) overrides any "cheap" tag.

- **FD-1 — REPORTING ground truth is `feature_metrics` + a nullable `door` column; no
  USD stored there.** *Not cheap* (durable schema + immutability), frontloaded.
- **FD-2 — Prices live in a git-tracked canonical manifest with effective-dated
  history, joined as-of; corrections/backdated points are PIN/human-only; the cadenced
  job is forward-only.** *Not cheap* (money accounting correctness), frontloaded.
- **FD-3 — Cap enforcement uses cost booked at time-of-use BASE price in the
  authoritative `MeteredSpendLedger`, is NOT retroactively rewritten, and is NEVER
  rebuilt by joining Layer 0 to current prices; reporting views DO recompute.** *Not
  cheap* (money-gate semantics), frontloaded. The deliberate split between real-time
  protection (immutable booking) and analytical truth (recomputable).
- **FD-4 — Caps are enforced as a pool-leased slice using CUMULATIVE-COMMITTED
  accounting (not outstanding-allocation), fenced per call; the conservative go-live
  default assigns the whole cap to one authoritative metered-lease machine.** *Not
  cheap* (money blast radius across machines), frontloaded. (See §Multi-machine.)
- **FD-5 — Reporting rollups pre-aggregate the IMMUTABLE token sums (a maintained
  daily rollup) and apply price/subsidy on read.** *Not cheap* (driven by the
  retroactive-recompute + event-loop-safety + disk requirements), frontloaded. (The
  round-0 cheap-to-change hedge is removed — it was self-cancelling.)
- **FD-6 — Alerts route through the flood-guarded `/attention` surface via a channel
  abstraction; Telegram in Increment C, Slack a later config-add; money-critical
  alerts fall back to the lifeline if no topic is configured.** *Not cheap*
  (published interface + notify source), frontloaded.
- **FD-7 — Amortized subscription-cost estimation is OUT OF SCOPE (the DEFERRAL is
  cheap-to-change-after — a pure additive later view); the `$0 (subscription)` DISPLAY
  ships now and is frontloaded (a published interface, never cheap), worded so `$0` is
  never misread as "barely spending".** The deferral tag survives contest; the display
  is separately frontloaded.
- **FD-8 — The price-refresh job ships OFF by default** (like `doorway-scan`),
  free-probe first, metered/web-verify probes manual-only + budget-capped, refuses to
  record an unknown/out-of-range price, is **FORWARD-ONLY** (`effectiveAt ≥ now`,
  `corrects: null`, never a credit/subsidy row — A-M7/S-F1), declares a `supervision`
  tier (Tier 1 — validate a price is sane before recording, B3) and P19 brakes (B4).
  Its points feed REPORTING only until an operator confirms them (`reviewed: true`).
  *Not cheap* (a recurring automated source feeding money accounting), frontloaded.
- **FD-9 — The MONEY gate reads a NEW authoritative booking-priced `MeteredSpendLedger`
  (fail-closed, non-swallowing), NOT the best-effort `feature_metrics` observability
  table.** *Not cheap* (the central money-safety split), frontloaded. Resolves the
  observability-side-channel-as-money-ground-truth foundation hole.
- **FD-10 — Cross-machine cap accounting is CUMULATIVE-COMMITTED-DOLLARS (remainder =
  globalCap − Σcommitted − Σoutstanding; a slice is remaining spendable dollars,
  decremented by real bookings, NEVER re-credited on release for a lifetime cap; only
  a daily cap resets, on a pool-agreed day boundary). The FencedLease MECHANISM is
  reused; the WS5.2 outstanding-allocation ACCOUNTING is NOT.** *Not cheap* (money
  blast radius), frontloaded. Corrects the round-0 "same sum-of-leases as WS5.2" claim.
- **FD-11 — Real per-door money attribution and live money-gating DEPEND on the
  out-of-scope nature-routing enforcement (A2.2) + metered provider implementations;
  Increment A ships with metered `door` NULL and honest `$0` until they land; the door
  is single-sourced with the gate when they do.** *Not cheap* (published interface +
  cross-spec dependency), frontloaded (as a declared dependency, not a build-time stop).
- **FD-12 — Subsidies and credits are REPORTING-ONLY and NEVER reach the money gate
  (the gate books BASE price); operator-specific deals live in a machine-local overlay,
  not the fleet-shared manifest.** *Not cheap* (money-gate semantics), frontloaded.
- **FD-13 — The go-live PIN action designates the metered-lease machine (default: the
  serving-lease holder); a metered call on a machine holding no cap slice fails closed
  `no-cap-slice`; on holder-death the safe default is FREEZE fleet-wide (never
  auto-grab).** *Not cheap* (money blast radius under partition), frontloaded.
- **FD-14 — The money gate consumes ONLY reviewed, validated, non-stale price points
  (git-committed / operator-confirmed); on a stale price it fails closed or books a
  conservative-MAX (operator choice; default conservative-max).** *Not cheap*
  (money-gate correctness), frontloaded.
- **FD-15 — The reporting NET figure (recomputed at current price) and the gate's
  COMMITTED figure (booked at time-of-use) are both surfaced with explicit labels; the
  cap enforces the committed figure.** *Not cheap* (money surface honesty),
  frontloaded.
- **FD-16 — Maturation: Increment A (read view) ships ENABLED on developer agents
  (omit `enabled` + `DEV_GATED_FEATURES`, dark on fleet); Increment B (money authority)
  is a documented `DARK_GATE_EXCLUSIONS` action-bearing case (arming spend is an
  operator PIN decision); Increment C (alerts) ships dryRun-first live-on-dev.** *Not
  cheap* (maturation posture), frontloaded.
- **FD-17 — Build a NEW `MeteredSpendLedger` (distinct domain) that REUSES
  DriftSpendLedger's write-discipline rather than a parallel counter or a literal
  reuse; the shared pool-lease closes DriftSpendLedger's deferred
  `drift-spend-cross-machine` child (a follow-up migrates drift onto the substrate).**
  *Not cheap* (avoids drifting dual ledgers), frontloaded.

## Multi-machine posture

This is a multi-machine agent. Default posture is `unified`. Every surface is declared:

- **Token ground truth (`feature_metrics` raw rows + `spend_token_rollup`):
  `proxied-on-read`.** Each machine records its OWN LLM calls locally (the calls
  physically happen there — the existing posture of `FeatureMetricsLedger` /
  `TokenLedger`). The operator-facing spend NUMBER is UNIFIED by a **pool-scope
  fan-out**: `GET /routing-spend/summary?scope=pool` merges each online machine's local
  rollup. **The fan-out model is `GET /guards?scope=pool` / `GET /subscription-pool
  ?scope=pool`** (NOT `/metrics/features`, which is LOCAL-ONLY — I-7); the merge for
  spend is net-new work reusing the shared pool-fan-out helper. It **rides the shared
  per-peer poll cache (WS4.4(f))** with a short TTL and load-shed-to-`stale`, so an
  auto-refreshing dashboard never re-fans (or re-runs the heavy rollup) per poll
  (scal-F6). A dark peer degrades to a tagged `pool.failed` row, never a 500.
- **Price authority (manifest): `unified`.** Git-tracked, identical on every machine,
  reviewed. The per-machine SQLite price index is a regenerable materialized view
  rebuilt on boot / manifest change. Operator-specific overlays are machine-local
  REPORTING-only (they never reach the gate, so they cannot diverge money enforcement).
- **Money authority (caps, go-live) + the committed-spend counter: `replicated` via a
  FENCED pool LEASE with CUMULATIVE-COMMITTED accounting (money-safety critical).** A
  vault key's dollars can be spent from ANY machine, so a naive per-machine cap would
  let N machines each spend the cap = N× overspend. Enforcement:
  - The pool tracks **dollars BURNED per machine** (each machine reports committed
    spend from its `MeteredSpendLedger`). The allocatable remainder is
    `globalCap − Σ(committed) − Σ(outstanding reservations)`. A slice is "remaining
    spendable dollars," decremented by real bookings and **never re-credited on
    release for a lifetime cap** (A-B3). Only the DAILY cap resets — on a single
    pool-agreed day boundary stamped by the metered-lease holder, so clock skew cannot
    give two machines two daily allotments (A-M6).
  - Issuance is FENCED single-writer (the `FencedLease` holder; epoch-stamped; a
    failover re-derives outstanding slices before issuing — the `AccountFollowMeGrants`
    / `AccountFollowMeSpendSlice` MECHANISM, reused for its fencing, NOT its
    outstanding-allocation accounting).
  - The local O(1) gate re-validates the slice's lease epoch on EVERY call (A-B4); a
    partitioned holder fails closed. Holder-death default = FREEZE fleet-wide (the
    re-derivation shows the ceiling fully allocated to the dead holder → a new holder
    fails closed to $0), never an auto-grab; a planned handoff transfers the committed
    counter with the lease (or reconstructs it from the pooled booking ledgers).
  - The conservative go-live default (FD-13) grants the whole cap to ONE authoritative
    metered-lease machine, making the global cap single-writer until multi-machine
    slicing is explicitly enabled — the safest default.
- **Replicated go-live/cap records are UNTRUSTED on receive (S-F4 — Know Your
  Principal).** A go-live/cap record armed with the PIN on machine A replicates to
  machine B as advisory data: it may grant B its lease SLICE, but it can NEVER by
  itself flip a door skipped→armed or raise a cap on B without operator authorization
  verifiable ON B (a re-required local PIN, or an Ed25519 operator-signed authorization
  B re-validates — the exact WS5.2 / topic-operator posture). Money authority is never
  laundered through replication.
- **`frozen` is FREEZE-WINS / monotone-latching under replication (S-F5).** Any
  `frozen:true` from any machine wins; a `frozen:false` state is authoritative only
  when written by a LOCAL PIN unfreeze on that machine — a stale/rogue peer can never
  un-freeze via replication.
- **Alert emission: `unified` single-voice.** A pool-wide condition (a key hitting its
  GLOBAL cap) alerts ONCE, emitted by the metered-lease holder with a stable pool-wide
  attention `id` (`spend-cap:<keyRef>:<capKind>:<threshold>:<dayEpoch>`, using the
  pool-agreed `dayEpoch` so a midnight skew cannot double-buzz — A-M6). Door-dark /
  fallback alerts key on `<machineId>:<chain>` because they ARE machine-specific.
- **Fresh single-machine agent = clean no-op.** Dark by default → routes 503; no pool
  peers → `scope=pool` degrades to self; no metered door armed → gate inert.

No surface is declared `machine-local`, so no `machine-local-justification` marker is
required. The candidates (raw token rows, price index) are a merged-read and a
regenerable-view-of-unified respectively — not machine-local state.

## Self-Heal Before Notify — watcher declaration

Only the **alert layer (Increment C)** introduces monitor/notice sources; each is
declared against Standard B:

| Degradation | Class | Self-heal (upstream) | Escalation gate | P19 brakes |
|---|---|---|---|---|
| Door dark (`RouterFailClosedError`) | recoverable | router swap-tail (incl. a money-cap-refused door, which advances like a dark door) falls to the next; escalate ONLY when the whole chain (incl. free tails) is exhausted | downstream of chain-exhaustion | `max-attempts` = chain length; `dedupe-key` = `spend-door-dark:<machine>:<chain>:<episodeBucket>`; widening `backoff`; flapping breaker (N/window → critical, bypasses coalescing); `max-notification-latency: 120s`; scrubbed jsonl |
| Fallback used (`onNatureRoutePlan` swapTail served) | recoverable | the fallback succeeding IS the heal | digest-only, never per-event | hourly "N fallbacks" summary; `dedupe-key` per chain |
| Cap hit (reservation would cross) | recoverable (protective) | none needed — blocking spend is the safe direction | one edge-triggered notice, worded "reservation would exceed", actual-vs-reserved | edge-trigger dedup; DISTINCT source from door-dark; `dedupe-key` = `spend-cap:<keyRef>:<capKind>:<dayEpoch>` |
| Approaching 50%/80% (daily AND lifetime) | recoverable | n/a informational | one edge-triggered notice per (capKind, threshold, window) | edge-trigger dedup; coalesced into digest |

Composes with No Silent Degradation: every detection + heal-attempt is audited to a
scrubbed metadata-only jsonl (`logs/routing-spend-alerts.jsonl`); the operator is the
last resort, never the silent-drop alternative. The first runtime application extracts
the door-dark watcher's gate into the reusable `SelfHealGate` declaration+assertion
layer (a downstream build task, registered under Close the Loop).

## Testing (Testing Integrity Standard — three tiers; I-6 / B5 / LF-F3)

- **Unit** — the as-of price join (incl. correction-supersede + freshness/stale +
  validation-fail-closed); subsidy/credit REPORTING math (and the invariant that
  neither reaches the gate); the `MeteredSpendLedger` reserve/settle incl.
  all-no-charge-outcomes→$0 and the reconciliation sweep; the O(1) gate boundary (allow
  at `≤ cap`, refuse at `> cap`); fail-closed on unreadable ledger / unknown /
  out-of-range / implausible / stale-epoch / frozen; the cumulative-committed pool math
  (slice never re-credited on release for lifetime; daily reset on dayEpoch); the
  money-gate-refusal → swap-tail-advance behavior; edge-triggered alert dedup incl. the
  episode bucket; the metadata-only scrub against a poisoned provider error body; the
  NULL-door → uncosted composer.
- **Integration** — each route 200 / 503 (dark) / 403 (Bearer-without-PIN on a PIN
  route); the Bearer `PATCH /config` CANNOT arm/unfreeze/raise (the S-F2 regression
  test); `scope=pool` merges + tags a `pool.failed` peer; the `door === keyRef.door`
  wiring test; a metered `keyRef` can never resolve to a `$0`/subscription price.
- **E2E (the single most important)** — the feature is ALIVE through the production
  init path: `GET /routing-spend/summary` returns 200 (not 503) when enabled; a
  PIN-gated write is refused without the PIN; the fresh-single-machine no-op.
- **Burst-invariant** — the new `SpendAlert` dispatcher's own dedup/coalescing under
  burst (in addition to the `/attention` path's existing burst test).

## Migration parity & Agent Awareness (Migration Parity + Agent Awareness Standards; I-3 / I-4)

- **Schema:** the `door` column rides the idempotent `ensureAddedColumns()` (runs at
  every DB open) — existing agents' DBs get it automatically. `FeatureMetricRecord`,
  `record()`, and the prepared INSERT all gain `door` (not just the ALTER).
- **Config:** either a `migrateConfigRoutingSpendDark` (mirroring the in-tree
  `migrateConfigNatureRoutingDark`, `PostUpdateMigrator.ts:440`) with existence checks,
  OR every `routingSpend.*` read uses `?? default` so absence = dark (verified for the
  alert topic/channels reads). The retention `max()` change is code at
  `AgentServer.ts:1113` (ships to all via the code update) — named as the edit point.
- **CLAUDE.md template (Agent Awareness):** `generateClaudeMd()`
  (`src/scaffold/templates.ts`) gains a Capabilities block (curl examples + proactive
  triggers + a Registry-First "what's my spend / caps?" row), and `migrateClaudeMd()`
  gets a content-sniff insertion so existing agents learn the `/routing-spend/*`
  surface on update.

## Vendored bench logic (grounding-honesty; F4 / GF3)

The earned bench patterns (`settleCost`, two-phase reserve-settle, no-charge
force-settle, `frozen`, edge-triggered 50%/80% thresholds) live on the research branch
`echo/serve-main`, NOT on canonical `JKHeadley/main`. This spec VENDORS the exact
logic into `src/` (the `MeteredSpendLedger` + the alert emitters) as canonical
production code with its own tests — the implementer grounds on `src/`, not an
off-branch path. The metered-caps shape (`{ keys: { <keyRef>: { provider,
lifetimeCapUsd, dailyCapUsd, frozen } } }`, key-NAMES-only) and the metered-prices
shape are re-expressed in the production manifest/store described above (the production
`(door, modelId)` price key is an IMPROVEMENT over the bench's model-id-only key, which
carried prefixed/unprefixed duplicates at different prices). Note: one `keyRef` spans
multiple `(door, model)` points (openrouter hosts both `gpt-5.5` and `opus-4.8` under
`metered_openrouter_bench`) — the per-key cap correctly aggregates across them.

## Alternatives considered (X-C6)

- **Stored cost projection / materialized rollup.** Rejected for the money number: a
  stored COST rollup goes stale on a price correction (violates retroactive-recompute).
  ADOPTED for the immutable TOKEN sums (Layer 2) — which never go stale — as the
  perf/disk answer.
- **Event-sourcing the whole spend domain.** The `MeteredSpendLedger` IS an append-only
  event log with a maintained fold (`committed*`) — event-sourcing where it earns its
  keep (the money gate), not across the analytical reporting layer (which is a
  recompute over immutable tokens).
- **Provider invoice reconciliation as source of truth.** Rejected as the GATE source
  (invoices lag hours–days; the cap must protect in real time). Retained as a FUTURE
  reconciliation input to detect drift between booked spend and billed spend (a
  registered follow-up, not this feature).

## Increment split (FD-style — what ships when, and behind what gate)

- **Increment A — Read-only spend VIEW (dev-agent ENABLED, dark on fleet; no money
  authority).** Layer 0 `door` column; Layer 1 price manifest + index + as-of join +
  validation + freshness; Layer 1b subsidy/credit REPORTING model + overlay; Layer 2
  daily token rollup + on-read pricing + `GET /routing-spend/summary` +
  `GET /routing-spend/caps` (read); the dashboard "Spend" tab; the price-refresh job
  (OFF). Ships via `resolveDevAgentGate` on `routingSpend.enabled` (dev-on / fleet-off);
  routes 503 when off. Shows `$0` / `not-live-yet` honestly. Reversible by revert; the
  only persistent state is additive/regenerable.
- **Increment B — Money authority (`DARK_GATE_EXCLUSIONS`, PIN-gated).** The
  `MeteredSpendLedger` + O(1) fail-closed lease-fenced gate wired into the metered call
  path (which itself depends on the out-of-scope metered dispatch — FD-11); the
  cumulative-committed pool-lease; `POST /routing-spend/caps/adjust` (PIN);
  `POST /routing-spend/go-live` (PIN); the phone-complete controls; the cap-change
  audit log; the dedicated PIN-only state store. Arming spend is an operator PIN
  decision (the documented action-bearing exclusion), inert until then.
- **Increment C — Alerts (dryRun-first live-on-dev).** The `AlertChannel` interface +
  `TelegramAttentionChannel`; the door-dark / fallback / cap / approaching emitters
  with their Self-Heal-Before-Notify gates + lifeline fallback; the fan-out + scrubbed
  sink. Inert until nature-routing observation is enabled (I-9). Slack is a later
  config-add, no emitter rework.

Each increment is independently reversible and independently gated. The read VIEW (A)
never depends on B or C; money authority (B) never depends on alerts (C).

## Open questions

*(none — all resolved into Frontloaded Decisions above.)*
