---
title: "Routing Control Room — Spend Tracking, Caps & Alerts (Surfaces 1 & 2)"
slug: "routing-control-room-spend-alerts"
author: "echo"
status: "converged"
review-convergence: "2026-07-05T23:00:03.564Z"
review-iterations: 7
review-completed-at: "2026-07-05T23:00:03.564Z"
review-report: "docs/specs/reports/routing-control-room-spend-alerts-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 21
cheap-to-change-tags: 1
contested-then-cleared: 1
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
  REUSES its earned write-discipline, and the follow-up registered under FD-17
  closes that deferred child (§Money layer).
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
   only a derived cost. **Ground cost/usage on ACTUAL provider reporting wherever and
   as much as possible (operator directive):** where a provider itself reports the
   call's cost and/or authoritative usage, that PROVIDER-REPORTED figure is the
   PREFERRED reporting anchor — captured as its own immutable, timestamped,
   append-only record (Layer 1c) and shown as the cost basis in the view. Internal
   token×price stays as the immediate estimate, the money-GATE's basis (the gate can
   never wait on a provider API), and the cross-check.
2. **Price-at-time-of-use**: cost = tokens × the door/model price *in effect at that
   timestamp* — a versioned/timestamped price table, joined as-of each usage record.
3. **Regularly confirm + track door/model dollar costs, staying up to date, including
   subsidies** — a cadenced refresh that records prices into the history and supports
   subsidy/credit adjustments.
4. **Rollups: hourly / daily / monthly / total** per door/model and aggregate.
5. **Caps display + ADJUST** — show lifetime/daily caps per key and live spend vs
   cap; the adjust control (and the paid-door go-live flip) is **PIN-gated** and
   **phone-complete** (a dashboard form, not a curl).
6. **Alerts — Telegram-FIRST, Slack-extensible — to EXACTLY ONE dedicated topic
   (operator directive: "any alerts go to one single topic not multiple").** ALL
   control-room alerts (cap hit / approaching 50%/80%, a door going dark, fallback
   usage, price-drift, provider-reconciliation drift) deliver to ONE dedicated,
   clearly-named Telegram topic — **"💰 Routing & Spend Alerts"** — located via a
   DURABLE persisted topic-id record and CREATED once only if genuinely absent, with a
   concurrency-safe guard so a duplicate topic can never be race-created. (Honest
   statement of the invariant: steady-state, one topic receives everything; the
   lifeline/system topic is the single NAMED emergency exception, used only when the
   dedicated topic is unresolvable or a money-critical delivery failed — a money alert
   is never dropped waiting on topic plumbing.) Fallback usage
   is spike-gated per Near-Silent Notifications (every fallback is durably logged, but
   routine self-healed churn never pings — only a rate-spike or chain exhaustion does),
   and all alerts respect the existing dedup/coalescing (one coalesced message per
   episode, never a flood). The delivery sits behind a channel abstraction so Slack
   adds later without rework — the Telegram implementation now targets this one durable
   topic.

## Design principles this spec is bound by

- **Money blast radius (Bounded Blast Radius).** The counter that GATES money is
  O(1), never-cached, fail-closed at cap, and reads its own AUTHORITATIVE
  booking-priced ledger — never the best-effort `feature_metrics` observability table.
- **Immutable ground truth + retroactive recompute (No Silent Degradation applied to
  accounting).** Token records are append-only; a price correction NEVER mutates a
  usage record — it recomputes derived cost in the REPORTING layer only. The money
  GATE books at time-of-use price and is NEVER retroactively rewritten.
- **Provider reporting is the preferred REPORTING anchor, never a gate input
  (operator directive: "ground our cost usage on actual reporting from the provider").**
  Where a provider reports the call's cost/usage, that figure — captured as its own
  immutable append-only record — is what the view PREFERS to display and the basis the
  provider-reconciliation sweep cross-checks the internal-derived figure against. It flows DOWN
  the REPORTING side exactly like a price correction: it can refine a REPORTED figure
  retroactively but NEVER re-opens gate headroom and NEVER moves the money gate (the
  same one-way safety as the re-pricing rule). The fail-closed gate cannot block on a
  provider API, so its basis stays internal token×price booked at time-of-use.
- **Deny-by-default for money authority (The Operator Channel Is Sacred / Know Your
  Principal).** Changing a cap, arming a paid door, or influencing ANY gate-consumed
  price value requires the dashboard PIN (or a reviewed git commit); a Bearer token —
  including via `PATCH /config` — is structurally insufficient.
- **Signal vs Authority.** The money gate's blocking authority is NARROW: a
  cap-refusal is a per-door SKIP (advance the swap-tail to the next, often free, door)
  — it never wedges the whole LLM path.
- **Self-Heal Before Notify.** A door-dark alert sits DOWNSTREAM of the router's own
  swap-tail self-heal; the operator hears about it only when self-heal is exhausted.
- **Maturation Path.** The read-only view ships ENABLED on developer agents (dark on
  fleet); the money-authority controls are the documented action-bearing exclusion.
- **Everything dark/reversible + smallest live money system first.** Increments:
  A (read view) → B (money authority, SINGLE-WRITER) → C (alerts) → D (multi-machine
  cap slicing) — independently gated and reversible; the first live money release is
  deliberately a one-machine system.

### Vocabulary (implementer's glossary — wire the RIGHT lease into the RIGHT job)

- **Serving-lease holder** — the fenced, epoch-stamped "one awake machine" of the
  multi-machine foundation; ALWAYS exists (single-machine = itself). Owns: alert-topic
  CREATION (Amendment 2). Never owns money.
- **Metered-lease holder** — the ONE machine the go-live PIN designates as money
  authority (Increment B+); exists ONLY after a go-live. Owns: the
  `MeteredSpendLedger`, the gate, cap reads, unified cap alerts. Never the topic
  creator.
- **`meteredCallId`** — the per-call id minted at reserve time (=== `reserveId`);
  joins `feature_metrics.callId` ↔ booking rows ↔ `provider_cost_report`.
- **Reserve-expiry sweep** (Layer 3) — money-side; takes the per-key lock; expires
  stale reserves. **Provider-reconciliation sweep** (Layer 1c) — reporting-side;
  never takes the money lock; computes booked-vs-reported drift.
- **Dedicated topic** — the ONE "💰 Routing & Spend Alerts" Telegram topic.
  **Lifeline** — the always-existing system topic; the single named emergency
  fallback. **Durable relay** — `PendingRelayStore` + `DeliveryFailureSentinel`,
  the retry-until-delivered Telegram path money-critical alerts ride.

---

## Proposed design

The design has FIVE durable layers and three read/write surfaces, split across four
increments. The **layering is the safety architecture** and its load-bearing move is
the **accounting split**:

- **REPORTING** truth (analytical, recomputable): immutable tokens
  (`feature_metrics`, Layer 0) → price authority (versioned, as-of; Layer 1) →
  subsidy/credit (Layer 1b) → **provider-reported cost/usage records (the PREFERRED
  anchor where available; Layer 1c)** → derived rollups (Layer 2). This side answers
  "what did we spend?", PREFERS the provider's own reported figure where a provider
  supplies one, and RECOMPUTES when a price is corrected. It is best-effort and may
  under-count on a dropped observability write — which is why it never gates money.
- **MONEY** truth (authoritative, protective): a NEW booking-priced
  `MeteredSpendLedger` (Layer 3) that the O(1) gate reads and writes, fail-closed,
  non-swallowing, with reserve/settle + a reserve-expiry sweep. This side answers
  "may this call spend?" and NEVER recomputes — it protects real dollars committed at
  the moment of the call.

Corrections AND provider-reported figures flow DOWN the REPORTING side; nothing flows
up into token ground truth, and NOTHING from the reporting side — including a provider's
own reported cost — ever moves the money gate.

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
  this table — cost is always a read-time join (Layer 2).
- **`door` is DERIVED at the funnel, single-sourced with the gate (I-1/S-F6/A-M8).**
  See §"Door attribution — scope + single-source" below. In Increment A the metered
  doors do not route yet, so metered rows do not exist and `door` is NULL/`unknown` on
  all pre-attribution rows; the Layer-2 composer renders NULL-`door` token volume as
  **uncosted** (never a crash, never a fabricated $0 — A-Min15).
- **Retention is decoupled from spend history (see Layer 2 / scal-F3).** This table
  keeps its short default horizon (30d) for raw rows; the long spend history lives in
  the small maintained daily token rollup, NOT in 400 days of raw per-call rows.

### Layer 1 — Price authority (versioned, timestamped; canonical reviewed manifest + local observed cache)

Requirement 2 needs a price *history* joined as-of each usage record. Price authority
is split into TWO stores with an explicit promotion flow (X-C1/X-G1/C2-2/S2-2):

**(a) The CANONICAL reviewed manifest** — git-tracked
`scripts/routing-prices.manifest.json` (the `scripts/model-registry-freshness.manifest.json`
convention) with embedded effective-dated history. It is written ONLY by a human path:
a reviewed git commit, or the PIN-gated promotion action below. Every point in it is
gate-eligible by construction.

**(b) The LOCAL observed price cache** — machine-local
`.instar/routing-prices.observed.json`, the ONLY file the cadenced refresh job (FD-8)
ever writes. Observed points feed REPORTING (labeled `priceBasis: "observed"`) and the
dashboard's "price drift" hints; they are **structurally incapable of reaching the
money gate** because the gate reads only the canonical manifest. **Promotion flow:**
the dashboard Spend tab surfaces observed-vs-canonical drift ("openrouter gpt-5.5
observed $4.50 in / canonical $5.00 — promote?"); promotion is a PIN action (or a
reviewed git commit) that appends the point to the canonical manifest. A lint + unit
test assert the refresh job's writer NEVER writes the canonical manifest file at all
(the structural form of "no job-authored point is ever gate-eligible" — S2-2).

**The promotion PIN action rides the rendered-plan rule (N-1 — it writes
gate-consumed booking prices, so it is the single most price-sensitive write).** The
observed cache is an agent-writable `.instar/` file, so a drift hint is UNTRUSTED
input; the plan render and the plausibility floor are the two real barriers. Therefore
promotion commits SOLELY from a canonical server-rendered plan that enumerates the
FULL point being appended (`door, modelId, inPerMtok, outPerMtok, cachedInPerMtok,
effectiveAt, corrects`) plus any `doors{}` meta delta (`staleMode`,
`conservativeMax`, `freshnessSlaDays`) — with the same absent-field-rejected
semantics as `caps/adjust` (§Surface 2) and the S2-3 smuggle test extended to the
promotion route. A payload value the operator never saw rendered cannot land in the
manifest.

```jsonc
// scripts/routing-prices.manifest.json (canonical, human-written)
{
  "schemaVersion": 1,
  "_doc": "USD per MILLION tokens, per door+model, effective-dated. Append-only: a change/correction ADDS a point; points are never edited in place. GENERIC PUBLISHED prices only — operator-specific deals live in the machine-local overlay. effectiveAt MUST be UTC-day-aligned (T00:00:00Z).",
  "doors": {
    "openrouter-api": {                          // per-door meta (ALL gate-consumed → lives HERE, never config)
      "freshnessSlaDays": 45,
      "staleMode": "book-conservative-max",      // or "fail-closed"
      "conservativeMax": { "inPerMtok": 10.0, "outPerMtok": 60.0 }
    }
  },
  "points": [
    {
      "door": "openrouter-api",
      "modelId": "openai/gpt-5.5",              // MUST equal canonical(resolvePositionModelId()) — see key-canonicalization
      "inPerMtok": 5.0,
      "outPerMtok": 30.0,
      "cachedInPerMtok": 0.5,                    // OPTIONAL cache-read rate; absent ⇒ cached bills as full input (C2-4)
      "effectiveAt": "2026-07-01T00:00:00Z",    // UTC-day-aligned, ALWAYS (FD-18)
      "recordedAt": "2026-07-01T18:00:00Z",
      "source": "openrouter-models-api",
      "corrects": null                           // only a PIN/human commit may set (A-M7)
    }
  ]
}
```

- **`effectiveAt` is UTC-day-aligned for EVERY point — including corrections and
  backdated fixes (FD-18 / SD2-1 / C2-1).** Enforced by the manifest-lint. A price
  change "takes effect" at a UTC day boundary by policy. Consequence: **every daily
  token bucket maps to exactly ONE price regime**, so the daily rollup (Layer 2) is
  exact **under Instar's day-aligned reporting policy** for the FULL 400-day horizon —
  no raw-row splitting is ever needed, and the round-1 "mid-day price-boundary day"
  complexity is DELETED. (C3-1 honesty: "exact" means exact to OUR accounting policy,
  never a claim of exactness to provider invoices — a provider that changes a price
  mid-day, or prices by region/account/tier, is represented from the next UTC day at
  the generic published rate; a view row whose day is affected by a correction carries
  a `providerPriceBoundaryApproximation` note. The ≤24h approximation is disclosed,
  bounded, and REPORTING-only — the gate books whatever reviewed point is effective at
  call time.)
- **Key canonicalization (I-5).** THREE model strings are in play: the chain LABEL
  (`flash-lite`), the resolved id via `ROUTING_LABEL_TO_MODEL_ID` (lowercase, e.g.
  `openai/gpt-oss-120b`), and what `onModel` reports into `feature_metrics.model`.
  The join key is **`(door, canonical(modelId))`** where `canonical()` is a single
  normalizer (lowercase + provider-prefix rules) applied identically to manifest
  points, recorded `model`, and `resolvePositionModelId()`. Wiring contract: a metered
  provider reports `onModel.model === resolvePositionModelId(pos)`; a test asserts
  manifest points round-trip through `canonical()`.
- **As-of join.** For a usage record at `ts` for `(door, canonical(modelId))`, cost
  uses the point with the greatest `effectiveAt ≤ ts` (ties on `effectiveAt` → the
  greatest `recordedAt`, so a `corrects` row supersedes). Cost formula (C2-4):
  `cost = (tokensIn − tokensCached)/1e6 × inPerMtok + tokensCached/1e6 ×
  (cachedInPerMtok ?? inPerMtok) + tokensOut/1e6 × outPerMtok` — cached reads bill at
  the door's cache rate when a REVIEWED rate exists, else honestly as full input
  (matching the vendored bench behavior, which over-books — the safe direction).
- **A join-MISS is loud, never $0 — for metered doors (I-5/A-Min15).** A recorded
  metered `(door, model)` with no matching point renders a distinct
  `priceBasis: "no-matching-point"` row with `unpricedTokensIn/Out` — never silently
  $0. The money GATE treats it as `unknown-price → fail closed`. **Subscription doors
  get a door-level `$0` default** (doorClass-based) so benign CLI/subscription volume
  never floods the view with "unpriced" rows; metered doors NEVER have a wildcard.
- **A correction never mutates ground truth or a prior price row.** A wrong past price
  is fixed by APPENDING a point with the same/covering (day-aligned) `effectiveAt`, a
  later `recordedAt`, and `corrects` set. Reporting recomputes automatically. **Only a
  human/PIN action may write a `corrects` row or a backdated `effectiveAt`** — the
  refresh job is forward-only AND writes only the observed cache (FD-8/A-M7/S2-2).
- **Subscription/CLI doors are honestly $0-per-token.** `claude-code`, `codex-cli`,
  `pi-cli`, `gemini-cli` points are `inPerMtok: 0, outPerMtok: 0,
  source: "subscription-not-per-token"`. The view shows their TOKEN volume as
  `$0 (subscription — not per-token billed)`, worded so `$0` is never misread as
  "barely spending" (FD-7).
- **Price validation, fail-closed (A-M5/S-F1).** At load AND at the gate:
  `inPerMtok, outPerMtok, cachedInPerMtok ≥ 0`, effective price `≥ 0`,
  `cachedInPerMtok ≤ inPerMtok` (so a typo can never make a settle exceed its
  reserve), and (for the gate) at or above a per-provider sane MINIMUM (the
  plausibility floor — a CODE-DEFINED per-provider constant, deliberately not a
  config value; the extended S-F2 test binds it out of any Bearer-writable surface).
  Any violation → `unknown-price` → fail closed. The manifest-lint enforces ranges,
  the cached≤input rule, AND day-alignment at commit time.
- **Freshness SLA + stale-price behavior — authority home pinned (X-C1/A2-3).** Each
  door's `freshnessSlaDays`, its `staleMode` (`fail-closed` | `book-conservative-max`),
  and its `conservativeMax` prices live **in the canonical reviewed manifest's per-door
  meta** (or, equivalently, the PIN-only caps store) — **NEVER in `.instar/config.json`**,
  because they are gate-consumed money values and config is Bearer-`PATCH`able. A door
  with no declared SLA gets the safe global default (45 days). When the newest
  canonical point for a door is older than its SLA: REPORTING flags
  `priceStale: true`; the GATE applies the door's `staleMode` (default
  `book-conservative-max` — spend continues but never under-books). The S-F2
  regression test extends to: **a Bearer `PATCH /config` cannot influence ANY
  gate-consumed price value** (base, cached, conservative-max, staleMode, floor).
  **`conservativeMax` is itself maintained, not assumed (C3-3):** the manifest-lint
  requires each door's `conservativeMax` to be deliberately high for its provider
  class (≥ a code-defined multiple of the door's newest canonical base price), and
  the drift surface raises an alert when an OBSERVED price exceeds the canonical
  base or approaches the `conservativeMax` assumption — so the stale-mode backstop
  cannot itself rot below reality. **Sequencing (C5-5): the stale-price and
  observed-drift alerts ship WITH Increment B, not C** — stale pricing changes money
  ADMISSION behavior, so its alarm belongs to the money increment; silent staleness
  until costs diverge is exactly the failure this closes. (These two alert kinds ride
  the dedicated-topic + lifeline-fallback rails — Increment B therefore ships the
  MINIMAL topic-resolver foundation (§Surface 2 Alerts: the resolution ladder +
  durable delivery + lifeline fallback), and the full channel abstraction/emitters
  still arrive in C. `/attention` is never used for spend alerts — Amendment 2.)
- **Machine-local read index (NOT authoritative), refreshed on running machines
  (X-G3).** Each machine builds a read-only SQLite index of the canonical points for
  fast as-of joins — a regenerable materialized view, rebuilt on boot AND when the
  manifest file's mtime/hash changes (lightweight periodic poll), so a `git pull`
  reaches a RUNNING machine without a restart.

#### Layer 1b — Subsidy / credit model (REPORTING-ONLY; never reaches the gate)

Requirement 3's subsidies/credits are a **reporting-layer** concept. **The money gate
applies NO downward adjustment — neither a per-token subsidy NOR a lump-sum credit
ever reaches Layer 3** (G3 + S-F1 reconciled). A subsidy/credit can only make the
*report* rosier, never loosen the cap.

- **Per-token subsidy / discount** (REPORTING): a price point's optional `subsidy`
  field — `{ kind: "discount-frac", value }` with `value ∈ [0,1)`, or
  `{ kind: "flat-per-mtok", inPerMtok≥0, outPerMtok≥0 }`. Validated at load (A-M5);
  applied ONLY in the reporting join.
- **Lump-sum credit** (REPORTING): an append-only `credits` ledger
  `{ keyRef, amountUsd, grantedAt, expiresAt (REQUIRED), note }`. Applied at rollup
  time as a *net* line; GROSS is always shown prominently next to net (A-Min12).
- **Operator-specific deals live in a machine-local overlay (G7).** The canonical
  manifest carries GENERIC published prices only. Operator-specific
  subsidies/credits live in `.instar/routing-prices.overlay.json` + the credits
  ledger, layered over the manifest at reporting-join time.
- **Machine-local BY DESIGN — declared (IL2-2).** The overlay and the credits ledger
  are machine-local operator-authored REPORTING state.
  `machine-local-justification`: they never reach the gate (money enforcement cannot
  diverge across machines because of them); they are operator-authored adjustments
  whose blast radius is display-only; and replicating them would put third-party deal
  terms on every pooled disk for zero enforcement benefit. **Pool-merge composition:**
  adjustments are keyRef/door-scoped (not machine-scoped), so under `scope=pool` they
  are applied **exactly once, at the merge point, by the serving machine from ITS
  overlay/credits** over the merged gross; the response labels
  `adjustmentsSource: "<serving machineId>"`. A single-machine read is the same code
  path (a merge of one). This keeps pool-wide `netUsd` consistent and explained; if
  the serving machine lacks a deal another machine knows, the view shows the serving
  machine's adjustments — labeled, never silently mixed.
- **Write authority (S-F3) — phone-complete primary path (Mobile-Complete).** The
  OPERATOR path for recording a credit/subsidy is a PIN-gated append-only audited
  route mirroring `caps/adjust`, surfaced as a dashboard Spend-tab form (works at
  phone width; rendered-plan rule does not apply since these are reporting-only
  values, but the write is still PIN + audited). Hand-editing the overlay file
  remains possible as a power-user/file escape hatch — it is never the documented
  operator path. The refresh job is FORBIDDEN from writing credit/subsidy rows
  anywhere.

#### Layer 1c — Provider-reported cost & usage (PREFERRED reporting anchor + reconciliation; REPORTING-ONLY, never the gate)

Requirement 1's operator directive — *"ground our cost usage on actual reporting from
the provider whenever and as much as possible"* — is honored HERE, and honestly: the
three metered providers report VERY different things, so the design PREFERS the
provider figure exactly where the provider actually supplies one and falls back to
internal token×price where it does not — labeling which basis every row used.

**What each metered provider actually reports programmatically (verified against the
bench funnel `metered-funnel.mjs`, the OpenRouter/Gemini live docs, and the OpenAI-
compatible response shape each door uses):**

| Door (key) | Per-call USD cost? | Authoritative usage (tokens)? | Granularity / latency | Basis this spec uses |
|---|---|---|---|---|
| **`openrouter-api`** (`metered_openrouter_bench`) | **YES** — every chat-completion response now carries `usage.cost` (total USD) + `usage.cost_details` (incl. `upstream_inference_cost`) and `prompt_tokens_details.cached_tokens`/`cache_write_tokens`; the `GET /api/v1/generation?id=<id>` endpoint returns the authoritative `total_cost` + native token counts + `cache_discount` a few seconds after the call; `GET /api/v1/credits` gives the account balance. **The metered request MUST set `usage: {include: true}`** (the same MUST-set posture as the required `max_tokens`): the field has historically been opt-in, and relying on "now returned automatically" would let every OpenRouter row silently degrade to internal-derived if the default regresses — mandated explicitly, harmless if redundant. | YES (native tokenizer) | **Per-call, in-response (immediate) for `usage.cost`; ~seconds for `/generation`; account-level for `/credits`** | **provider-reported** cost is the preferred anchor |
| **`groq-api`** (`metered_groq_bench`) | **NO** per-call USD cost field. OpenAI-compatible `usage` block only: `prompt_tokens`/`completion_tokens`/`total_tokens` (+ Groq timing `prompt_time`/`completion_time`/`queue_time`/`total_time`). No cheap per-call cost API; cost is only in the dashboard/usage export. | YES (in-response `usage`) | Per-call token usage in-response; **cost export is dashboard-grade, not programmatic per-call** | **internal-derived** cost (token×price); provider tokens replace our estimated token counts |
| **`gemini-api`** (`metered_gemini_bench`) | **NO** per-call USD cost field. `usageMetadata` (native path) / OpenAI-compat `usage` (the funnel's path) reports `promptTokenCount`/`candidatesTokenCount`/`totalTokenCount` (+ `cachedContentTokenCount`, `thoughtsTokenCount`). USD only via **Google Cloud Billing / BigQuery export** (label-attributable, but heavyweight and lagging hours→a day). (Known caveat: `candidatesTokenCount` can under-report vs billed output on some models when thinking tokens are excluded — itself a real drift signal, below.) | YES (in-response usage metadata) | Per-call token usage in-response; **USD export is heavyweight + lagged** | **internal-derived** cost; provider tokens replace our estimated token counts; billing export is a FUTURE reconciliation input (registered follow-up, alongside FD-11's invoice-drift REPORTING) |

**Honest architectural consequence:** only OpenRouter gives us a provider-reported
COST today; Groq and Gemini give us authoritative provider-reported USAGE (tokens) but
no cheap per-call cost. So "ground on the provider" means, precisely: **prefer the
provider's cost when it reports one (OpenRouter), and ALWAYS prefer the provider's
reported TOKEN counts over our chars/token estimate when it reports them (all three) —
recomputing our internal cost from the truer token counts.** This is a genuine
improvement even where no cost figure exists. **Token-source disambiguation (the
gate-exclusion invariant made wiring-precise):** this preference statement is about
the REPORTING side. The money gate's settle also uses provider-returned usage — but
ONLY from the **in-hand live response object** of the call it is settling (the
vendored `settleCost` formula, fed by the per-door billed-token mapping — §Layer 3),
NEVER by reading the `provider_cost_report` store; the settle module has NO
dependency on the store (wiring test). The store is written FROM the same response,
downstream — data flows response → {settle, capture} independently (capture strictly
after the settle books — §the seam), never store → settle. **Hedging honesty
(provider APIs drift):** the per-provider capabilities above were verified against
the providers' live docs + the bench funnel as of 2026-07; they are treated as
DEGRADABLE facts, not axioms — a provider field that is absent, renamed, or reshaped
simply degrades that row to `internal-derived` (a first-class, NORMAL `costBasis`,
never an error path), and the reconciliation/drift surface is what makes such a
regression visible.

- **The provider-report store — a NEW immutable, append-only, timestamped record set
  (same discipline as Layer 0), joined on a per-call id.** Every metered call mints
  ONE durable **`meteredCallId`** (=== the money ledger's `reserveId` — one id, minted
  at reserve time, stamped through `IntelligenceOptions.attribution`), which is the
  STABLE JOIN KEY across the three records of the same call: the `feature_metrics` row
  (a new nullable `callId` column riding the same `ensureAddedColumns()` +
  type/writer/INSERT discipline as `door`), the `MeteredSpendLedger` booking rows, and
  every `provider_cost_report` row. Per metered call the seam (below) appends a
  `provider_cost_report` row `{ ts, meteredCallId, keyRef, door, modelId,
  generationId?, source ('openrouter-usage'|'openrouter-generation'|'groq-usage'|
  'gemini-usage-metadata'|'gemini-billing-export'), providerCostUsd? (null when the
  provider reports none), providerTokensIn?, providerTokensOut?,
  providerTokensCached?, capturedAt }`. Rows are **APPENDED, never mutated** — a
  later, more-authoritative report (e.g. the `/generation` cost arriving after the
  in-response `usage.cost`) is a NEW row that supersedes by
  **`(meteredCallId, greatest capturedAt)`** (provider `generationId` is stored for
  audit, never trusted as the join key), exactly like a price `corrects` row
  supersedes — so per-call matching can never double-count or misattribute.
  **Receive-time validation (the replicated-store receive-clamp discipline):** every
  captured field is clamped before append — numerics must be finite and ≥ 0 (a
  NaN/Infinity/negative cost or token count is dropped with the row marked
  `invalid-provider-report`, never stored raw), `generationId`/`source` are
  length/charset-clamped, and any provider-authored string is HTML-escaped at render
  time. The poisoned-provider-body test extends to this capture + render path (not
  just the alert scrub). It lives on the REPORTING side (a small SQLite table beside
  the rollup) — NEVER the money ledger. **Retention (declared, NOT regenerable):** a
  pruned provider report is NOT re-derivable (unlike the token rollup), so the store
  keeps `routingSpend.providerReportRetentionDays` (default **400**, matching the
  reporting horizon) with the batched-delete prune idiom (scal-F4); volume is bounded
  by metered calls only (a small fraction of `feature_metrics`), which is why 400d of
  raw rows is affordable here where it was not for all internal calls.
- **The reporting join PREFERS the provider figure, labeled.** Layer 2's on-read cost
  for a row is: **(1)** the provider-reported cost when a `provider_cost_report` with a
  non-null `providerCostUsd` exists for that call/day+door+model
  (`costBasis: "provider-reported"`); **(2)** else internal token×as-of-price, using
  the provider-reported TOKEN counts where present, our recorded tokens otherwise
  (`costBasis: "internal-derived"` / `"internal-derived-provider-tokens"`). The view
  states the basis per row so "grounded on the provider" is never an unverifiable
  claim.
- **The PROVIDER-RECONCILIATION sweep (the cross-check the directive asks for) —
  named distinctly from the money layer's RESERVE-EXPIRY sweep, because they must
  never be conflated.** A cadenced (`routingSpend.reconciliation.sweepIntervalHours`,
  default 6 — an inert config knob), REPORTING-side sweep compares, per
  `(keyRef, door)` over a window, the internal-derived spend against the
  provider-reported spend (and, for the money increment, against the ledger's
  committed figure — the booked-vs-reported/booked-vs-billed comparison FD-11 already
  requires, here made per-call and faster than a monthly invoice). **Isolation from
  the money layer:** it only ever READS the committed totals (the same read surface as
  the caps view) — it NEVER takes the per-key money lock, never touches ledger rows,
  and runs entirely on the reporting side. **Event-loop safety (scal-F1/F7 applied):**
  it streams its bounded window with `.iterate()` (never `.all()`), and a
  larger-than-threshold pass rides the worker-thread-snapshot pattern like the Layer-2
  composer. It stores each comparison as its own timestamped append-only record
  (retention: the same `providerReportRetentionDays` horizon + batched prune) and
  computes a signed `driftPct` per key/door. **Direction +
  safety (one-way, matching the re-pricing rule):**
  - Drift where the provider reports **LOWER** than internally booked → the REPORT
    shows the lower provider figure; the money ledger's committed counter is **NEVER
    lowered** (lowering = re-opening spent headroom — forbidden).
  - Drift where the provider reports **HIGHER** than internally booked (our manifest
    price was stale/low, or cache assumptions were wrong) → surfaced as a **drift
    signal** that (a) raises the price-drift/reconciliation alert (Amendment 2's
    dedicated topic, §Alerts) and (b) is the natural trigger to PROMOTE a corrected
    canonical price (§Layer 1, the PIN-gated promotion flow) — which tightens FUTURE
    gate bookings. The committed counter is still **not** retroactively rewritten
    (converged gate semantics UNCHANGED); the drift is observability that feeds the
    human-reviewed price path, never the gate directly.
  - Above a configurable `routingSpend.reconciliation.driftAlertPct` threshold the
    drift becomes an alert; below it, it is recorded silently (Near-Silent
    Notifications).
- **Multi-machine (declared).** The `provider_cost_report` store and the
  reconciliation records are **`proxied-on-read`** exactly like `feature_metrics` (each
  machine records its own calls; the pool view merges via the shared per-peer poll
  cache). The booked-vs-reported reconciliation that involves the money ledger is
  computed **on the metered-lease holder** (the ledger's home), like `coverageOk`.
- **Never a gate input (the load-bearing invariant).** No `provider_cost_report`,
  reconciliation record, or drift figure is ever read by the O(1) money gate or the
  reserve/settle path. A unit test asserts the gate's read set excludes the
  provider-report store — the structural twin of the "gate never reads
  `feature_metrics`" and "subsidy/credit never reaches the gate" invariants.

### Layer 2 — Derived REPORTING views & rollups (immutable token pre-aggregate + price on read)

Requirement 4 (hourly/daily/monthly/total) is served WITHOUT freezing the event loop
and WITHOUT hoarding raw rows (scal-F1/F2/F3):

- **Pre-aggregate the IMMUTABLE fact, join the MUTABLE dimension on read.** A
  maintained rollup table `spend_token_rollup(day, door, modelId, tokensIn, tokensOut,
  tokensCached)` holds ONLY token sums per UTC day — provably untouched by any
  price/subsidy/credit correction. Price/subsidy apply on READ over the daily buckets;
  credits at rollup time. Because every canonical `effectiveAt` is UTC-day-aligned
  (FD-18), **each daily bucket maps to exactly one price regime — the daily rollup is
  EXACT under Instar's day-aligned reporting policy across the full 400-day horizon**
  (never claimed exact to provider invoices — C3-1/C4-1), and retroactive recompute
  (a price fix instantly reflows) holds with no raw-row splitting.
- **Hourly grain (the finest requirement)** is computed on read over the raw
  `feature_metrics` rows within the SHORT (30d) raw-retention window (bounded, indexed
  on `ts`) — hourly detail beyond 30d is not offered (stated honestly in the view).
  Daily/monthly/total are served from the daily token rollup and survive 400 days.
- **Retention decoupled (scal-F3).** Raw rows stay at 30d; `spend_token_rollup` is
  retained `routingSpend.tokenRollupRetentionDays` (default **400**). "Total" is
  honestly "total within the 400-day rollup horizon" (`horizonNote`).
- **Never freeze the event loop (scal-F1/F7).** The daily-bucket read is small and
  synchronous-safe. A genuinely large detect runs in a **worker thread serving a
  cached snapshot** (the cartographer #1069 pattern) above a concrete threshold
  (default: >250k raw rows in the queried window — only reachable on the hourly
  grain). Any raw-row pass streams with `.iterate()`, never `.all()`.
- **The daily token rollup is maintained cheaply.** On each `feature_metrics` insert
  the day's bucket is upserted (`INSERT … ON CONFLICT(day,door,modelId) DO UPDATE`) —
  off the LLM-latency path (post-call fire-and-forget, scal-F8). A **bounded boot-time
  reconcile** recomputes the LAST 30 DAYS of buckets from raw rows (batched), so an
  upsert dropped by a crash is repaired from raw truth before the raw rows prune; a
  missing rollup table is backfilled the same way.
- **The retention prune is batched (scal-F4).** Replace the unbounded `DELETE` with
  the SQLite-portable batch idiom — `DELETE FROM feature_metrics WHERE rowid IN
  (SELECT rowid FROM feature_metrics WHERE ts < ? LIMIT 5000)` — looped with a
  per-tick ceiling and yields between batches.
- **Provider-reported cost is preferred on read, per row, labeled (Layer 1c).** Each
  costed row carries a `costBasis` (`provider-reported` | `internal-derived` |
  `internal-derived-provider-tokens`) and, where reconciliation has run, a signed
  `providerDriftPct`. A row PREFERS the provider's own reported cost when one exists;
  otherwise it derives from tokens×as-of-price (using provider-reported token counts
  where available). This is the read-time expression of the operator's "ground on the
  provider" directive — always visible, never assumed.
- **Honesty when not-yet-live.** Before go-live, metered doors are skipped: token
  volume zero, cost `$0`, and the view states plainly "no paid door is live yet —
  metered spend is $0."
- **Two spend numbers, both labeled (A-M10/X-C2).** The REPORTING net (recomputed at
  CURRENT price/subsidy/credit) and the GATE's committed figure (booked at
  time-of-use) are DESIGNED to differ after a correction/credit. The view labels both
  — "recomputed at current price, net of credits" vs "committed at time of use (what
  the cap enforces)" — with a one-line note that the cap enforces the committed figure.

### Layer 3 — MONEY layer: authoritative booking-priced ledger + O(1) fail-closed gate (Increment B)

This is the ONLY layer that gates real money. It is deliberately SEPARATE from the
recomputable reporting views and does NOT read `feature_metrics` **or the Layer-1c
provider-report / reconciliation store** — provider-reported cost is REPORTING truth
and can never move the gate (the fail-closed gate cannot wait on a provider API, and a
provider figure that arrives after the call must never re-open committed headroom). The
gate books internal token×as-of-BASE-price at time-of-use, exactly as converged.
**Increment B ships it SINGLE-WRITER: the whole cap lives on ONE PIN-designated
metered-lease machine (C2-5); the multi-machine slice mechanics are Increment D.**

- **A NEW authoritative append-only booking ledger, `MeteredSpendLedger` (LF-F1 /
  A-B1 / I-2).** Per metered vault key, a durable append-only ledger records each
  booking row `{ ts, keyRef, door, modelId, kind: 'reserve'|'settle'|'expire',
  reserveId, costUsd (at BOOKING price), leaseEpoch }` PLUS a maintained O(1) running
  total `{ keyRef, committedLifetimeUsd, committedDayUsd, dayEpoch, updatedAt }`. This
  ledger — not `feature_metrics` — is the AUTHORITATIVE money truth and the ONLY
  rebuild source: `committed*` is a fold of the ledger rows.
  **Rebuild-from-Layer-0-joined-to-current-prices is explicitly FORBIDDEN at the
  gate** (a downward `corrects` would lower the counter and re-open capped headroom).
  Writes are **fail-closed and non-swallowing** (unlike `feature_metrics.record()`): a
  booking that cannot be durably persisted refuses the call. Adopts
  `DriftSpendLedger`'s discipline (append-only rows, `proper-lockfile`,
  malformed-row-skip) with an O(1) MAINTAINED total instead of its O(rows-in-day)
  tally. **Torn-write recovery invariants (C4-2 — the fold is canon, the totals file
  is a cache):** the append-only rows are the SOLE authority; the maintained totals
  file is a regenerable cache of the fold. On EVERY boot the ledger folds the rows
  and REWRITES the totals file (so a torn totals rename, or a totals write that
  landed without its append, is always corrected from row truth); between boots the
  totals are trusted only because every mutation appends the row FIRST (fsync'd)
  and updates the totals second — a crash between the two leaves totals STALE-LOW at
  most one booking, and the very next gate read is preceded by a cheap
  row-count/high-water check that triggers an incremental re-fold when they disagree.
  A torn trailing append (partial last line) is the malformed-row-skip case. Unit
  tests cover both torn directions (append-without-totals; totals-without-append is
  impossible by ordering, asserted).
- **Build-vs-reuse vs DriftSpendLedger (I-2/LF-F5, FD-17).** A NEW ledger (distinct
  domain) reusing the write-discipline, because the gate needs O(1) never-cached
  reads. A registered follow-up (Close the Loop) migrates drift-checks onto the same
  substrate and thereby closes the deferred `drift-spend-cross-machine` child. The two
  ledgers never overlap in domain.
- **Two-phase reserve/settle with IDEMPOTENT TERMINAL STATES and a locked
  RESERVE-EXPIRY sweep (A-B2 / A2-1 / scal-F5).** (This money-layer sweep is named
  the **reserve-expiry sweep** everywhere — distinct from Layer 1c's
  provider-reconciliation sweep, which never takes the money lock.)
  - **Reserve sizing (A2-4):** the metered call path MUST set a hard `max_tokens` on
    the provider request. `reserve = inputTokens/1e6 × inPerMtok + max_tokens/1e6 ×
    outPerMtok` (cached tokens reserved as full input — never under-books). **A
    metered call with no bounded output ceiling is REFUSED** (`unbounded-reservation`
    → fail closed): an unknown reservation is an unknown cost, and an under-sized
    reserve would defeat the concurrent-call protection the lock exists to provide.
  - **Lifecycle:** every reserve row carries a unique `reserveId` and moves through a
    terminal, idempotent state machine `reserved → settled | expired` — the FIRST
    terminal transition wins; the loser becomes a no-op. Lock scope: the per-key lock
    is held ONLY for the two short booking critical sections (reserve; terminal
    transition), RELEASED during the LLM round-trip. Process scope: metered calls
    funnel through the single server process (in-process async mutex); if
    multi-process issuance ever appears, the same `proper-lockfile` advisory lock
    applies.
  - **The reserve-expiry sweep TAKES THE PER-KEY LOCK (A2-1)** and expires only
    reserves older than the TTL that are still in `reserved` state. **A settle that
    arrives after its reserve was expired books the ACTUAL cost as a fresh ABSOLUTE
    row** (expiry-aware settle) — never a delta against a vanished reserve, so
    the late-settle race cannot under-count committed spend. The TTL is pinned
    comfortably above the maximum metered-call latency (default 15 min vs a 5-min
    call ceiling). Sweep runs at boot + on a cadence.
  - **ALL no-charge outcomes force-settle to $0 (A-B2):** 402/429/5xx/timeout/abort/
    connection-error settle $0 UNLESS tokens were demonstrably returned; keyed on the
    REAL HTTP status/outcome. A 200 books actual (`settleCost` on returned usage,
    cached billed per the reviewed cache rate or as full input) or worst-case.
  - **The settle books BILLED tokens per a per-door mapping, erring HIGH (the Gemini
    thinking-token trap).** Providers' "output tokens" fields do not all mean "billed
    output": Gemini bills thinking tokens as output while `candidatesTokenCount` can
    EXCLUDE them — a settle that naively books `candidatesTokenCount` under-books
    committed spend and the cap under-protects (and the reconciliation that would
    notice is forbidden from moving the gate). Each metered door therefore carries a
    CODE-DEFINED billed-token mapping the settle MUST use — Gemini output =
    `candidatesTokenCount + thoughtsTokenCount` on the native path, or
    `completion_tokens` + the reasoning-token detail on the OpenAI-compat path (the
    funnel's path — the mapping names BOTH response shapes); OpenRouter/Groq =
    `completion_tokens` — and a response whose billed-token basis cannot be confirmed
    from the mapping settles at the WORST-CASE estimate (the existing safe direction),
    never at a lower unverified field. **Honesty on "vendored, unchanged": the
    `settleCost` FORMULA is unchanged; the billed-output FIELD SELECTION feeding it is
    this new per-door mapping.** Unit test per door mapping and per shape.
- **O(1) never-cached, fail-closed, lease-fenced read at the gate.** Before a metered
  call the gate reads the committed total FRESH, reads the door's CANONICAL, VALIDATED
  price (never the observed cache, never the overlay), computes `estCost` at BASE
  price (NO subsidy/credit), and refuses when `committed + estCost > cap` (strict `>`).
  It **fails closed on EVERY uncertainty** — unreadable ledger, unknown/unpriced/
  implausible/negative price, unbounded reservation, invalid cap, `frozen`, or a stale
  lease epoch (`localSliceEpoch < currentLeaseEpoch` — re-validated on EVERY call,
  epoch cached + invalidated on lease-pull; A-B4). **The holder SELF-FENCES on
  isolation (N-2):** the gate ALSO fails closed (`lease-liveness-unconfirmed`) when
  this machine has not POSITIVELY re-confirmed its metered-lease designation/epoch
  against the pool within a bounded staleness window — and that window is pinned
  STRICTLY SHORTER than the mesh-death threshold that makes a reclaim eligible. By
  construction, an alive-but-partitioned old holder has already fenced itself to $0
  before the operator can ever be offered a reclaim, so a reclaim can never create
  dual money authority (the ~2× cap dual-spend scenario is structurally closed). A
  single-machine agent trivially self-confirms (it IS the pool) — no behavior change.
  **Outstanding `reserve` rows are INSIDE the committed total the gate reads** (that
  is what makes concurrent reservations visible to each other); a two-concurrent-
  reserves unit test pins it.
- **Booked at time-of-use BASE price, never retroactively rewritten (FD-3).** Cap
  enforcement protects real dollars committed at the moment of the call; later price
  re-interpretation is a Layer-2 REPORTING concern.
- **A money-gate refusal is a SWAP-TAIL ADVANCE, not a chain kill (LF-A2 — Signal vs
  Authority).** A cap-refused metered door advances the `swapTail` exactly like a dark
  door (often to a free CLI/subscription door). `RouterFailClosedError` fires ONLY
  when every door including the free tails is unavailable. Hitting a dollar cap never
  takes down a job-kind that has a free fallback.
- **`frozen` kill switch per key** — instant per-key stop, fails the gate closed with
  reason `frozen`. Freeze halts NEW admissions only; an in-flight reserved call
  settles its real cost (A-Min11). Cap/freeze writes are atomic (tmp+rename); a
  caps-read failure fails CLOSED.
- **STOP is Bearer; ARM is PIN (the green-PR asymmetry), with scoped STOP (S-F5 /
  X-C5).** FREEZING a key and disarming a paid door are Bearer-accessible (any hand
  halts spend instantly; the freeze route is **set-true-only** and records the actor);
  UNFREEZING, RAISING a cap, and going live are PIN-gated. Halting money is always
  cheap; releasing money is always the operator's.

### Door attribution — scope + single-source (I-1 / LF-F3 / A-M8 / GF1)

The `door` join key is load-bearing, and grounding shows it does NOT yet reach a
recorded row — this spec is HONEST about the dependency:

- **Today's reality (verified against `JKHeadley/main` v1.3.780):** the metrics tap
  `CircuitBreakingIntelligenceProvider.recordMetric` writes `model`/`framework` from
  the inner provider's `onModel` — no notion of a door; `resolveRoute` runs
  observe-only and falls through to the LEGACY category path (nature-routing
  ENFORCEMENT is the unbuilt "A2.2 remainder"); and the metered doors have **no
  provider implementation** (`IntelligenceRouter.ts:821` `continue`s past them).
- **Therefore, honestly:** real per-door money attribution and the money GATE's wiring
  into the metered call path DEPEND on separate, in-flight S4 work — the
  nature-routing enforcement dispatch (A2.2) and the metered provider implementations
  — which are **OUT OF THIS SPEC'S SCOPE**. This spec designs the surfaces, the
  reporting/pricing/rollup layers, and the money-ledger + gate; it declares the
  integration SEAM they plug into. **Increment A ships with metered `door` NULL and
  honest `$0`.** Increment B's ledger/gate/pool logic is fully unit-testable against a
  stub metered dispatch; only the live end-to-end proof waits for the real path.
- **The seam (single-source contract, A-M8).** When metered dispatch lands: the door
  is resolved ONCE at the metered call and stamped into
  `IntelligenceOptions.attribution.door`; the router passes it to `primary.evaluate`;
  `recordMetric` reads it into `extra.door`; and the money gate books against the SAME
  resolved `(keyRef → door → price)` tuple. Invariant + wiring test:
  `feature_metrics.door === gate.keyRef.door` for every metered call, and a metered
  `keyRef` can NEVER resolve to a `$0`/subscription price (S-F6). Interim: CLI-door
  rows may derive `door = framework` (1:1); only metered doors need the stamped thread.
- **The provider-report capture rides the SAME seam (Layer 1c).** The metered call
  path is the one place the provider's response body is seen, so it is where the
  provider-reported figures are captured: on a 200 the dispatch reads the door's
  provider-reported fields (`usage.cost`/`cost_details` and cached-token details for
  OpenRouter; the `usage`/`usageMetadata` token counts for all three) and appends a
  `provider_cost_report` row keyed on the call's **`meteredCallId`** (=== the ledger
  `reserveId`, stamped through `attribution` — the same single-source thread as
  `door`) plus the resolved `(keyRef, door, modelId)`; a later OpenRouter
  `/generation` cost supersedes the in-response `usage.cost` by a fresh appended row
  under the same `meteredCallId`. This capture is REPORTING-side and best-effort (a
  failed append is swallowed like a `feature_metrics` write) — it NEVER blocks the
  call and NEVER feeds the settle/gate. **Ordering:** the capture runs strictly AFTER
  the settle's terminal transition has been durably booked (or on a fully isolated
  post-call path), so a swallowed capture error can never mask — or share a failure
  domain with — the fail-closed, non-swallowing settle at the same seam.
  It shares the door-attribution dependency: until real metered dispatch lands, no
  `provider_cost_report` rows exist and the view shows honest `$0` / no-provider-data.

### Surface 1 — Spend view (read-only; Increment A)

- `GET /routing-spend/summary?grain=day&sinceHours=…&scope=pool` → per door/model and
  aggregate rollups (Layer 2), each row `{ door, modelId, doorClass, tokensIn,
  tokensOut, tokensCached, grossUsd, subsidyUsd, creditUsd, netUsd, committedUsd,
  priceBasis, costBasis, providerReportedUsd, providerDriftPct, priceStale,
  notLiveYet }` — `costBasis` and `providerReportedUsd` surface the Layer-1c
  provider-grounded figure (and `providerDriftPct` where the provider-reconciliation
  sweep has run) — plus `totals`, `horizonNote`, `adjustmentsSource`, and loud `unpricedTokens`
  rows. A companion `GET /routing-spend/reconciliation?scope=pool` returns the
  per-`(keyRef, door)` internal-vs-provider (and, post-B, vs-committed) drift records.
  **Best-effort labeling rides
  the summary too (C3-5):** the response carries a `reportingBasis` block (best-effort
  observability source; last boot-reconcile time; any known dropped-write/reconcile
  repair) so the analytical view never masquerades as the authoritative money number —
  the caps surface's committed figure is the number the cap enforces.
- `GET /routing-spend/caps?scope=pool` → each metered key's `{ keyRef, provider,
  lifetimeCapUsd, dailyCapUsd, frozen, committedLifetimeUsd, committedDayUsd,
  pctLifetime, pctDaily, goLiveState, meteredLeaseHolder, coverageOk }`.
  **Multi-machine posture (IL2-1): proxied-to-holder.** The committed aggregate is
  holder-known (the metered-lease machine's ledger is the authority), so the caps
  read RESOLVES AGAINST THE HOLDER: a non-holder machine proxies the money numbers to
  the metered-lease holder (the WS4.4 dumb-relay pattern) and tags the response
  `source: <holder machineId>`; if the holder is unreachable the response says so
  honestly (`holderUnreachable: true`, last-known values + age) — it NEVER renders its
  own empty local ledger as `$0 spent`. `coverageOk` (reporting-vs-ledger
  reconciliation) is computed ON the holder for the same reason. Before Increment B,
  committed is $0 and `goLiveState: "not-live"` everywhere — no proxy needed.
- Both are **Bearer-auth reads**, 503 when dark. Dashboard **"Spend" tab** mirrors the
  read-only "LLM Activity" / "Routing Map" tab convention.

### Surface 2 — Caps adjust + go-live (PIN-gated writes; phone-complete; Increment B)

- **State lives in a DEDICATED PIN-only store, never in config (S-F2).** Caps +
  go-live + metered-lease designation live in `state/routing-spend-caps.json`, written
  ONLY by the PIN routes. NEVER under any `PATCHABLE_CONFIG_KEYS` key — so
  `PATCH /config` (Bearer, deep-merge) can never arm a door, unfreeze a key, raise a
  cap, **or influence any gate-consumed price value** (A2-3). Regression tests assert
  both. Only inert knobs (`routingSpend.enabled` dark-toggle, retention days,
  `alerts.telegramTopicId` (the operator-configured dedicated-topic id — the zero-race
  find path), `alerts.channels`, `reconciliation.driftAlertPct`) live in config.
  `alerts.telegramTopicId` names WHERE alerts go — it can never arm a door, raise a
  cap, or move a price, so it is safe as a Bearer-`PATCH`able knob.
- `POST /routing-spend/caps/adjust` and `POST /routing-spend/go-live` — **PIN-gated**
  via `checkMandatePin` (`routes.ts:9044`; sha256 + `timingSafeEqual` + per-IP
  rate-limit). **Honest hardening note (S2-1):** `checkMandatePin`'s attempt counter
  is today an in-memory `Map` (`routes.ts:9038`) — there is NO durable attempt store
  in the tree. This spec adds one as an explicit build item: a small durable
  `state/pin-attempts.json` write-through behind the existing Map, shared by the PIN
  routes, so a restart does not reset brute-force lockout. (Express `trust proxy` is
  off fleet-wide, so `req.ip` already ignores `X-Forwarded-For` everywhere — no
  per-route XFF special-case exists or is needed.)
- **The PIN authorizes a CANONICAL server-rendered plan — nothing else applies
  (S2-3).** Flow: the agent (or the dashboard form) submits a structured request →
  the server renders a plain-language plan enumerating EVERY field it will change
  ("Arm openrouter-api; set daily cap $5.00; lifetime cap unchanged ($60)") → the
  operator PIN-approves THAT plan → **the commit derives solely from the rendered
  plan**. Any request field absent from the render is REJECTED (not silently
  applied); every caps/go-live dimension must appear in the render or the request is
  refused. Test: a payload field not present in the rendered plan cannot be committed
  under the PIN. This closes the smuggled-field gap in agent-proposes/operator-approves.
  **Plan canonicalization (C3-4):** each rendered plan is an IMMUTABLE snapshot
  carrying a server-minted single-use nonce and a short TTL; the PIN approval commits
  exactly that snapshot, the nonce is consumed on commit (no replay), an expired plan
  must be re-rendered, and the commit is REFUSED if the underlying caps/lease/manifest
  state changed since the render (approve-what-you-saw, never approve-then-drift).
  **Drift is judged by optimistic concurrency, not vibes (C5-3):** each governed
  store (caps store, go-live record, canonical manifest) carries an explicit VERSION
  field; a plan pins the version(s) it read; commit refuses only on a version
  mismatch of a store the plan touches; the refusal UX is deterministic
  ("re-rendered — here's the fresh plan"), so an unrelated background change can
  never invalidate a phone approval loop. No separable "approved-plan token"
  outlives the single commit — a captured approval is worthless. **Scope: this rule governs EVERY PIN action that writes ANY gate-consumed
  value** — caps/adjust, go-live, reclaim/re-designate, AND the price-promotion action
  (N-1, §Layer 1). **Defense-in-depth below the plan path (C4-4):** every committed
  money-authority record ADDITIONALLY passes a schema-level validator that is
  independent of the rendered-plan machinery (types, ranges, day-alignment, the
  cached≤input rule, cap ≥ 0, known keyRef/door) — so a plan-renderer bug can never
  become the sole authority boundary — and every cap/go-live/promotion audit row
  stores the canonical BEFORE and AFTER state, not just the delta.
- **Cap-LOWERING is fenced/acknowledged (A-M9):** bumps the lease epoch, forces slice
  re-derivation; the local gate re-reads the cap on its next O(1) read and clamps.
  Raising is monotonic-safe. All changes append to an audited cap-change log
  (`GET /routing-spend/caps/log`, Bearer-read).
- `POST /routing-spend/go-live` `{ pin, door, enabled }` arms/disarms a paid door for
  THIS agent and DESIGNATES the metered-lease machine (default: the current
  serving-lease holder — FD-13). Deny-by-default: with no go-live record every metered
  door stays skipped. **Availability honesty (C3-2):** the go-live plan and the Spend
  tab state plainly that **paid routing is single-machine until Increment D** — if the
  designated holder is down, paid doors are down everywhere (free doors still serve
  via the swap-tail) — and the go-live plan displays the candidate holder's current
  health (online, quota state, lease status) BEFORE the operator approves, so the
  availability cliff is an informed choice, never a surprise.
- **Phone-complete dashboard controls (CG2/B1).** The Spend tab gains a PIN-gated
  controls section (the Mandates-tab grant-form shape): leads with the primary action,
  zero raw internals, destructive actions de-emphasized, phone-width. Freeze/disarm
  are Bearer buttons; adjust/unfreeze/go-live require the PIN.
- **Credit/subsidy write authority (S-F3):** per Layer 1b — overlay/manifest edits or
  a PIN-gated append-only audited route; the refresh job is forbidden from either.

### Surface 2 — Alerts (channel-abstracted; Increment C)

- **`AlertChannel` abstraction — ONE dedicated topic, message-INTO not topic-PER
  (Amendment 2).** `dispatch(alert: SpendAlert): Promise<DispatchResult>` with a `kind`
  discriminator. Increment C ships `TelegramSpendTopicChannel`, which delivers each
  alert as a MESSAGE into the ONE dedicated **"💰 Routing & Spend Alerts"** topic via
  `TelegramAdapter.sendToTopic(topicId, text)` — the **`monitoring.burnDetection.alertTopicId`
  precedent** (`BurnThrottleRunbook.sendTelegram(this.alertTopicId, …)`), where alerts
  post to ONE configured topic. It deliberately does **NOT** route through
  `POST /attention`, because the attention queue spawns ONE forum topic PER item — the
  exact many-topics flood the operator directive forbids. A future `SlackSpendChannel`
  is a registry entry + `alerts.channels: ["telegram","slack"]` — no emitter rework
  (channel-neutral `SpendAlert`s; dispatcher-level dedup/aggregation/coalescing runs
  BEFORE any channel send, so one coalesced message per episode reaches the topic).
- **The invariant, stated honestly (steady-state one topic + ONE named emergency
  exception).** Steady-state, EVERY spend alert lands in the one dedicated topic. The
  lifeline/system topic is the single named EMERGENCY exception — used only when the
  dedicated topic is unresolvable or a money-critical delivery has failed (below) —
  so a money alert can never be silently dropped waiting on topic plumbing. This is
  "one single topic" as the operating rule, with the exception explicit rather than
  smuggled.
- **Idempotent find-or-create of the ONE dedicated topic — no duplicate, ever (the
  duplicate-topic guard the directive requires).** The resolution LADDER (first hit
  wins; only the last rung creates):
  1. **Operator-configured id wins.** If `routingSpend.alerts.telegramTopicId` is set,
     that id IS the topic — nothing is ever created (mirrors
     `burnDetection.alertTopicId`). On a multi-machine pool the operator should set it
     identically in each machine's (machine-local) config; a machine whose configured
     id disagrees with the pool-published record (rung 2) logs ONE warning line and
     follows its local config — creation stays fenced below, so a mismatch can never
     mint a second topic.
  2. **The POOL-PUBLISHED durable record.** The auto-created id is persisted
     machine-locally (atomic tmp+rename into the telegram messaging config block,
     exactly like `persistLifelineTopicId`) AND published pool-wide as a
     content-free field on the existing machine-registry/heartbeat surface — so every
     peer, and any FUTURE serving-lease holder, resolves the SAME id from local disk
     or the pool record. This is what makes the record durable across a lease
     handoff: a new holder inherits the id instead of re-creating (the
     machine-local-only persistence would otherwise guarantee a duplicate on any
     holder change — Telegram mints a fresh id per `createForumTopic`, so
     "last-writer-wins" can never merge two creations).
  3. **Create, ONCE — the `ensureLifelineTopic()` precedent** (`TelegramAdapter.ts`):
     created as a **bounded create-once SYSTEM topic** —
     `createForumTopic("💰 Routing & Spend Alerts", …, { origin: 'system',
     bounded: true, label: 'routing-spend-alerts' })`, which is **EXEMPT from the
     bounded-notification-surface budget** (the `bounded: true` create-once exemption
     at `TelegramAdapter.createForumTopic`) — then persisted locally + published
     pool-wide (rung 2). On every later boot/alert the id is verified (a
     `sendChatAction` typing probe) and only RE-created if the topic was genuinely
     deleted — never duplicated. Name-matching is never used to "find" the topic
     (topic names are mutable and duplicable); the persisted id is authoritative.
- **Concurrency-safe against a duplicate race (fenced single-writer creation).**
  Guards compose so two machines / two processes can never race-create two topics:
  - **Cross-machine: creation is SERVING-LEASE-HOLDER-ONLY — deliberately NOT the
    metered-lease holder.** The creator must exist in every increment and topology:
    the metered-lease holder exists only after Increment B's go-live PIN designates
    one, but alerts (door-dark/fallback in C; stale-price in B) can flow with no door
    ever armed. The SERVING-lease holder — the fenced, epoch-stamped "one awake
    machine" that always exists on a pool (and is trivially the machine itself on a
    single-machine install) — is the single topic-creator. Before creating (ladder
    rung 3) it MUST have re-confirmed its lease within the same bounded staleness
    window the money gate uses for self-fencing, so a just-deposed holder cannot
    race the new one; the fenced lease guarantees at most one machine is eligible at
    a time, and rung 2 guarantees the next holder REUSES the id rather than minting
    another.
  - **In-process: single-flight.** The creator serializes creation through its OWN
    in-flight-creation promise field, mirroring the existing per-lane
    `createForumTopic` single-flight pattern in `TelegramAdapter` (the
    `floodNoticePending` map that stops concurrent coalesced items double-creating;
    the routing-spend channel adds its own field — it does not literally reuse that
    map), so even a burst of first-alerts yields exactly one `createForumTopic` call.
  - **A machine that is not the serving-lease holder** (or a holder that cannot
    confirm its lease, or cannot verify no existing id because peers are unreachable)
    does NOT create — it delivers to the **lifeline fallback** and re-resolves the
    ladder on its next tick. Fail toward the lifeline, never toward a possible
    duplicate.
- **Money-critical alerts are DURABLE, and fall back on ANY failure — not only
  "unset" (G5 hardened).** Cap-hit, holder-dead, and chain-exhausted door-dark alerts:
  - ride the existing **durable relay path** (`PendingRelayStore` +
    `DeliveryFailureSentinel` — delivery-robustness Layers 2/3), never a
    fire-and-forget `sendToTopic`; their edge-trigger dedup latches only on CONFIRMED
    delivery, so a transient Telegram failure leaves the alert eligible for re-send
    instead of permanently suppressed;
  - fall back to the lifeline when the dedicated id is unset, fails its verification
    probe, OR delivery through the relay is exhausted — a set-but-wrong id is a
    fallback case, not a black hole;
  - and a change to `alerts.telegramTopicId` (a Bearer-`PATCH`able knob) is made
    AUDIBLE: on repoint the channel posts a one-line "spend alerts now route to
    <topic>" confirmation into BOTH the old topic (if still resolvable) and the new
    one, and the change is audited — so a Bearer-level actor cannot SILENTLY redirect
    the operator's money alerts (the knob still cannot touch money admission;
    informational kinds simply follow it).
  The dedicated topic is a create-once system topic; once it exists, all alert kinds
  converge to it.
- **Money-critical alerts ride a DISTINCT dedup lane (S-F8)** — now enforced at the
  dispatcher (before `sendToTopic`), since delivery no longer goes through
  `/attention`. Cap-hit/holder-dead carry a distinct `dedupeLane` from
  door-dark/fallback/price-drift, so a flapping door's volume can never coalesce a
  money-critical cap alert into a digest line. All kinds land in the SAME dedicated
  topic; the lane governs coalescing, not the destination.
- **Triggers (Self-Heal Before Notify):**
  - **Cap hit**: ONE edge-triggered alert, worded honestly — "a reservation would
    exceed key X's daily cap" with actual-vs-reserved shown (A-Min13). Protective;
    the adjust action is the operator's.
  - **Approaching cap** (50%/80%) fires on **BOTH daily AND lifetime** (G4),
    edge-triggered per (capKind, threshold, window); dedupe-key
    `spend-approach:<keyRef>:<capKind>:<threshold>:<window>`; coalesced into the digest.
  - **Door dark** (`RouterFailClosedError`): downstream of swap-tail self-heal;
    escalates only on whole-chain exhaustion. P19 brakes: `max-attempts` = chain
    length; `dedupe-key` = `spend-door-dark:<machineId>:<chain>:<episodeBucket>`
    (episode/time bucket lets a post-heal re-dark re-alert — A-Min14); widening
    backoff; flapping breaker (N exhaustions/window → critical, bypasses coalescing);
    `max-notification-latency: 120s`; scrubbed jsonl audit.
  - **Fallback used** (`onNatureRoutePlan` swapTail served): already self-healed —
    and routine self-healed churn is NOT an operator event (Near-Silent
    Notifications). Every fallback is recorded in the scrubbed jsonl; a Telegram
    digest line is emitted ONLY when the fallback RATE crosses a spike threshold
    (a sustained jump vs the trailing baseline, or an absolute per-hour ceiling) —
    steady-state fallback churn never buzzes the operator at all.
  - **Provider-reconciliation drift** (Layer 1c, Amendment 1): when the reconciliation
    sweep's signed `driftPct` for a `(keyRef, door)` exceeds
    `routingSpend.reconciliation.driftAlertPct`, ONE edge-triggered digest line lands in
    the SAME dedicated topic (dedupe-key
    `spend-recon-drift:<keyRef>:<door>:<driftBucket>`), worded as an observability
    signal ("openrouter reports ~12% more than we booked — your manifest price may be
    stale; promote?"). Below the threshold it is recorded silently (Near-Silent). This
    shares the price-drift lane (informational), never the money-critical lane, and —
    like every reconciliation output — NEVER moves the gate.
  - **Metered-lease holder dead (A2-2 — the named exception to holder-single-voice):**
    when the pool observes the metered-lease holder offline past the mesh-death
    threshold while any door is live, a SURVIVING machine emits ONE money-critical
    alert ("paid routing is frozen — the metered-lease machine <nickname> is
    offline; free doors still serve; reclaim from the dashboard") with a stable
    pool-wide id (`spend-holder-dead:<keyEpoch>`). Without this exception the freeze
    alert would be emitted by the corpse and the operator would never learn.
- **Holder-death recovery is operator-PIN reclaim, never auto-grab (A2-2/FD-13).**
  The Spend tab offers a PIN-gated **reclaim/re-designate**: the operator confirms the
  old holder is gone; the new holder REBASES the committed counter from an
  authoritative fold of the surviving pooled booking ledgers PLUS the operator's
  acknowledgment of the dead machine's last-known committed figure (shown in the
  plan). Reconstruction is authoritative-fold-only and EXCLUSIVE with counter transfer
  (never additive — the double-count guard); a planned handoff transfers the counter,
  an unplanned death rebases it. The daily `dayEpoch` is stamped by the (new) holder.
  **The attested figure is an EMERGENCY estimate, biased conservative (C4-3):** in
  Increment B the surviving fold is structurally near-empty (the dead holder held the
  ledger), so the holder's capacity heartbeat (the surface that already carries
  quota state pool-wide) ALSO carries the committed counter per key as a MONOTONE
  content-free observability value; every peer retains the last-seen figure. The
  rebase honesty is then: `rebasedCommitted = max(surviving fold, last
  heartbeat-carried committed, operator-attested last-known figure)` — the maximum,
  never the minimum, so a rebase can never UNDER-count and re-open spent headroom,
  and the operator's attestation is no longer the only defense against a holder that
  died mid-burst (the heartbeat figure trails real spend by at most one heartbeat
  interval, disclosed with its age in the reclaim plan). The heartbeat figure is
  observability INTO the rebase max() only — never a gate input on a live holder. A rebase that lands at/above the
  cap simply leaves the gate refusing until the operator raises the cap or the daily
  resets — the safe direction. The reclaim plan labels the attested figure as an
  estimate with its age; the audit row records all three inputs and which won.
  **Reclaim safety against a FALSE death (N-2):** the rendered reclaim plan displays
  the last-known committed figure's AGE, and when the alive-but-partitioned signal is
  present (the old holder's git-synced heartbeat still ADVANCING while its mesh ropes
  are down — the exact discriminator the rope-health monitor already computes), the
  reclaim route REFUSES until the signal clears. Combined with the gate's
  self-fencing window (< the mesh-death threshold), a reclaim is offered only after
  the old holder is provably fenced or provably dead — never against a machine that
  is still spending.
- **Alert/audit scrub is metadata-ONLY (S-F7).** door / chain / threshold / machineId /
  reason-code / counts — NEVER a provider response/error body, never a key-shaped
  substring. Redaction pass tested against a poisoned provider error body; the
  dispatch auth token is never serialized.
- **Router-signal fan-out is a dependency (I-9).** `onNatureRoutePlan` is a SINGLE
  optional callback (only consumer today: a dev-gated `console.log`). Increment C
  (a) routes it through a small fan-out preserving observer isolation (throw-swallow;
  one subscriber throwing never breaks the LLM path or double-fires the other), and
  (b) adds the durable scrubbed `logs/routing-spend-alerts.jsonl` sink. The plan is
  only emitted when `sessions.natureRouting.enabled` resolves truthy — so door-dark/
  fallback alerts are INERT until nature-routing observation is enabled (an explicit
  cross-increment dependency).

---

## Decision points touched

- **Adds** a NEW authoritative `MeteredSpendLedger` (booking-priced, fail-closed,
  idempotent-terminal reserve/settle) as the money-gate ground truth — SEPARATE from
  `feature_metrics` (reporting-only).
- **Adds** two PIN-gated money-authority write routes plus a PIN-gated
  reclaim/re-designate, all committing ONLY a canonical server-rendered plan, with
  state in a dedicated store OUTSIDE `PATCHABLE_CONFIG_KEYS`.
- **Adds** an O(1) fail-closed, lease-fenced money gate on the metered call path
  (Increment B, single-writer) that refuses at cap as a swap-tail ADVANCE (never a
  chain kill), refuses unbounded reservations, and fails CLOSED on every uncertainty.
- **Adds** an alert-emission path (Increment C) that delivers ALL alerts into EXACTLY
  ONE dedicated Telegram topic ("💰 Routing & Spend Alerts") via `sendToTopic`
  (idempotent find-or-create from a durable pool-published id;
  serving-lease-holder-only creation + single-flight duplicate guard; bounded
  create-once system topic; durable relay for money-critical kinds) — NOT
  `POST /attention` (topic-per-item) — downstream of self-heal, with a lifeline
  fallback and one named surviving-voice exception (holder-dead).
- **Adds** a nullable `door` column (+ type + writer + INSERT), a maintained
  `spend_token_rollup` table, the canonical/observed price stores, and the
  machine-local overlay/credits reporting stores.
- **Adds** an immutable append-only `provider_cost_report` store + a reconciliation
  record set (Layer 1c) — the provider-grounded REPORTING anchor + internal-vs-provider
  (post-B vs-committed) drift — captured at the metered-call seam, PREFERRED on read,
  and structurally excluded from the money gate.
- **Modifies** the token-prune to a batched delete; adds the rollup retention knob.
- **Depends on (out of scope):** nature-routing enforcement (A2.2) + metered provider
  implementations (real attribution + live gating); nature-routing observation
  enablement (Increment C alerts).
- **Does NOT modify** the router's selection logic, the Routing Map, or the existing
  `/metrics/features` / `/tokens/*` routes.

## Frontloaded Decisions

Each tagged with reversibility; the closed non-cheap taxonomy (durable external
side-effects, money, identity, published interface) overrides any "cheap" tag.

- **FD-1 — REPORTING ground truth is `feature_metrics` + a nullable `door` column; no
  USD stored there.** *Not cheap*, frontloaded.
- **FD-2 — Prices: a git-tracked CANONICAL reviewed manifest (human-written only) with
  effective-dated history + a machine-local OBSERVED cache (the only file the refresh
  job writes) + an explicit PIN/git promotion flow; corrections/backdated points are
  PIN/human-only; the promotion PIN action commits SOLELY from a canonical rendered
  plan (full point + doors-meta enumerated; single-use nonce + TTL + refuse-on-drift —
  N-1/C3-4).** *Not cheap*, frontloaded.
- **FD-3 — Cap enforcement uses cost booked at time-of-use BASE price in the
  authoritative `MeteredSpendLedger`, never retroactively rewritten, never rebuilt by
  joining Layer 0 to current prices; reporting views DO recompute.** *Not cheap*,
  frontloaded.
- **FD-4 — Cross-machine caps are enforced via a FENCED pool lease with
  CUMULATIVE-COMMITTED accounting; Increment B ships SINGLE-WRITER (whole cap on one
  PIN-designated machine); slicing is Increment D.** *Not cheap*, frontloaded.
- **FD-5 — Reporting rollups pre-aggregate IMMUTABLE daily token sums and apply
  price/subsidy on read.** *Not cheap* (retroactive-recompute + event-loop-safety +
  disk), frontloaded.
- **FD-6 — ALL alerts deliver to ONE dedicated Telegram topic ("💰 Routing & Spend
  Alerts") via a channel abstraction — message-INTO the topic (the
  `burnDetection.alertTopicId` `sendToTopic` precedent), NOT `POST /attention`
  (topic-per-item, the flood the operator forbids); the lifeline is the single NAMED
  emergency exception (unresolvable topic / failed money-critical delivery), never a
  second routine destination. Idempotent find-or-create via the resolution LADDER:
  operator-configured id → the POOL-PUBLISHED durable record (machine-local persist
  + a content-free field on the machine-registry/heartbeat surface, so peers and
  future lease holders inherit the id) → create ONCE as a bounded create-once SYSTEM
  topic (budget-exempt, persisted like `persistLifelineTopicId`). Duplicate guard:
  creation is SERVING-lease-holder-only (fenced, lease-confirmed within the
  staleness window; exists in every increment/topology — deliberately NOT the
  metered-lease holder, which exists only after a B go-live) + in-process
  single-flight + everyone-else-falls-back-to-lifeline (fail toward the lifeline,
  never toward a possible duplicate). Money-critical alerts ride the durable relay
  (PendingRelayStore/DeliveryFailureSentinel), dedup-latch on CONFIRMED delivery,
  fall back to the lifeline on ANY failure (unset/probe-failed/exhausted), and a
  repoint of `alerts.telegramTopicId` is audible (confirmation into old + new topic,
  audited). The minimal resolver foundation ships WITH the first alert-emitting
  increment (B); the full channel abstraction/emitters are C. Slack a later
  config-add; ONE named surviving-voice exception (holder-dead); dispatcher-level
  dedup/coalescing (one message per episode, money-critical on a distinct lane);
  routine self-healed fallback churn is jsonl-only (a digest line ONLY on a
  rate-spike — Near-Silent Notifications).** *Not cheap*, frontloaded.
- **FD-7 — Amortized subscription-cost estimation is OUT OF SCOPE (the DEFERRAL is
  cheap-to-change-after); the `$0 (subscription — not per-token billed)` DISPLAY ships
  now and is frontloaded.** Deferral tag survives contest.
- **FD-8 — The price-refresh job ships OFF by default, free-probe first,
  metered/web-verify probes manual-only + budget-capped, FORWARD-ONLY
  (`effectiveAt ≥ now`, day-aligned, `corrects: null`, never credit/subsidy rows),
  Tier-1 supervised (sane-price validation) with P19 brakes, and writes ONLY the
  machine-local observed cache — structurally never the canonical manifest (lint +
  test).** *Not cheap*, frontloaded.
- **FD-9 — The MONEY gate reads the NEW authoritative booking-priced
  `MeteredSpendLedger` (fail-closed, non-swallowing), NOT `feature_metrics`.** *Not
  cheap*, frontloaded.
- **FD-10 — Cross-machine cap accounting (Increment D) is CUMULATIVE-COMMITTED-DOLLARS
  (remainder = globalCap − Σcommitted − Σoutstanding; a slice is remaining spendable
  dollars, decremented by real bookings, NEVER re-credited on release for a lifetime
  cap; only the daily cap resets, on the holder-stamped pool dayEpoch; pool committed
  reports are ABSOLUTE folded values, never deltas). The FencedLease MECHANISM is
  reused; the WS5.2 outstanding-allocation ACCOUNTING is NOT.** *Not cheap*,
  frontloaded (rules now; shipped in D).
- **FD-11 — Real per-door attribution + live money-gating DEPEND on out-of-scope
  A2.2 + metered provider impls; Increment A ships metered `door` NULL and honest $0;
  the door is single-sourced with the gate when they land; Increment B is
  stub-testable meanwhile. RELEASE GATE (C4-5/C5): a production go-live (arming a
  real paid door) is REFUSED until (a) one end-to-end LIVE metered call has proven
  `door === ledger door === priced door` on this agent — the wiring invariant as a
  gate precondition, not merely a test target (the Live-User-Channel-Proof posture
  applied to money); (b) the holder-death runbook exists and one holder-death DRILL
  (kill the holder, observe the surviving-voice alert, PIN-reclaim) has been
  exercised; and (c) provider-invoice drift REPORTING (booked-vs-billed comparison,
  observability-only, never gate authority) is wired, so a policy-exact rollup that
  drifts from real invoices is seen, not assumed.** *Not cheap*, frontloaded
  (declared dependency).
- **FD-12 — Subsidies and credits are REPORTING-ONLY and NEVER reach the money gate;
  operator-specific deals live in the machine-local overlay/credits stores (declared
  machine-local BY DESIGN), applied exactly once at the pool-merge point by the
  serving machine.** *Not cheap*, frontloaded.
- **FD-13 — The go-live PIN designates the metered-lease machine (default: the
  serving-lease holder); a metered call on a machine holding no cap authority fails
  closed `no-cap-slice`; holder-death = FREEZE fleet-wide + a surviving-machine alert +
  a PIN-gated operator reclaim/rebase (authoritative-fold-only, exclusive with
  transfer) — never an auto-grab. The holder SELF-FENCES (`lease-liveness-unconfirmed`)
  on a designation/epoch staleness window pinned strictly SHORTER than the mesh-death
  threshold, and reclaim is REFUSED while the alive-but-partitioned (heartbeat-
  advancing) signal is live — so dual money authority is structurally impossible
  (N-2).** *Not cheap*, frontloaded.
- **FD-14 — The money gate consumes ONLY canonical reviewed, validated, non-stale
  price points; per-door `freshnessSlaDays` / `staleMode` / `conservativeMax` live in
  the canonical manifest (or PIN store), NEVER config; global default SLA 45 days;
  stale default = book-conservative-max.** *Not cheap*, frontloaded.
- **FD-15 — The reporting NET figure and the gate's COMMITTED figure are both
  surfaced with explicit labels; the cap enforces the committed figure.** *Not cheap*,
  frontloaded.
- **FD-16 — Maturation: Increment A ships ENABLED on developer agents (omit `enabled`
  + `DEV_GATED_FEATURES`, dark on fleet); Increments B and D are documented
  `DARK_GATE_EXCLUSIONS` action-bearing cases; Increment C ships dryRun-first
  live-on-dev.** *Not cheap*, frontloaded.
- **FD-17 — Build a NEW `MeteredSpendLedger` (distinct domain) reusing
  DriftSpendLedger's write-discipline; a registered follow-up migrates drift-checks
  onto the substrate and closes `drift-spend-cross-machine`.** *Not cheap*,
  frontloaded.
- **FD-18 — Every canonical price point's `effectiveAt` is UTC-day-aligned
  (`T00:00:00Z`), including corrections and backdated fixes (manifest-lint enforced).
  Every daily token bucket therefore maps to exactly ONE price regime — the daily
  rollup is exact under Instar's day-aligned reporting policy for the full horizon
  (never a claim of exactness to provider invoices), and no raw-row splitting path
  exists. The ≤24h mid-day approximation is disclosed and reporting-only.** *Not
  cheap* (accounting-correctness policy), frontloaded.
- **FD-19 — Cached-token pricing: an optional per-point `cachedInPerMtok` (reviewed
  like any price); absent ⇒ cached reads bill as FULL input (the over-booking safe
  direction, matching the vendored bench). The gate reserves cached-as-input always.**
  *Not cheap* (money accounting), frontloaded.
- **FD-20 — Increment B is SINGLE-WRITER money (whole cap, one machine); multi-machine
  slicing (Increment D) ships later, dark, with FD-10's rules and the portable
  operator-signed (Ed25519) cross-machine arming mechanism — a per-machine local PIN
  is the ONLY arming authority until D.** *Not cheap* (money blast radius +
  complexity sequencing), frontloaded. This resolves the replicated-authority tension:
  in B there is nothing to replicate (one holder); in D, arming a peer requires the
  receiver-verifiable operator signature (never bare replication).
- **FD-21 — Provider-reported cost/usage is the PREFERRED REPORTING anchor (operator
  directive), captured as immutable append-only `provider_cost_report` records at the
  metered-call seam — joined per call on ONE durable `meteredCallId` (=== the ledger
  `reserveId`, stamped through `attribution` into `feature_metrics.callId`, the
  booking rows, and every provider report, so matching/supersession is exact and can
  never double-count) — PREFERRED on read (per-row `costBasis`), receive-clamped on
  capture, retention-declared (default 400d, not regenerable), and cross-checked by
  the cadenced provider-reconciliation sweep that surfaces internal-vs-provider (and
  post-B vs-committed) drift. It flows DOWN the reporting side like a price correction:
  provider-LOWER never lowers the committed counter (no re-opened headroom);
  provider-HIGHER is a drift signal feeding the price-drift alert + the PIN price-
  promotion path, never the gate. Per-provider truth is honest and asymmetric:
  OpenRouter reports per-call USD cost in-response (+ a `/generation` cost + `/credits`
  balance); Groq and Gemini report authoritative per-call TOKEN usage but NO cheap
  per-call USD cost (Gemini USD only via the heavyweight lagged Cloud-Billing export —
  a registered follow-up reconciliation input alongside FD-11). The provider-report
  store is NEVER a money-gate input (unit-tested, the twin of FD-9/FD-12). Lands:
  capture + display in Increment A (empty until metered dispatch lands), the
  authoritative booked-vs-reported reconciliation in Increment B (extends FD-11's
  invoice-drift REPORTING), the drift ALERT in Increment C.** *Not cheap* (money
  accounting + immutable-record discipline), frontloaded.

## Multi-machine posture

This is a multi-machine agent. Default posture is `unified`. Every surface is declared:

- **Token ground truth (`feature_metrics` raw rows + `spend_token_rollup`):
  `proxied-on-read`.** Each machine records its OWN calls locally (the existing
  `FeatureMetricsLedger`/`TokenLedger` posture). The operator-facing spend NUMBER is
  UNIFIED by pool-scope fan-out: `GET /routing-spend/summary?scope=pool` merges each
  online machine's local rollup. **Fan-out model = `GET /guards?scope=pool` /
  `GET /subscription-pool?scope=pool`** (NOT `/metrics/features`, which is LOCAL-ONLY
  — I-7); the merge rides the **shared per-peer poll cache (WS4.4(f))** with
  load-shed-to-`stale` (scal-F6). A dark peer degrades to a tagged `pool.failed` row.
- **Provider-report + reconciliation records (Layer 1c): `proxied-on-read`.** Each
  machine appends its own metered calls' `provider_cost_report` rows locally (same
  posture as `feature_metrics`); the pool spend/reconciliation view merges via the
  shared per-peer poll cache. The booked-vs-reported reconciliation that reads the
  money ledger is computed **on the metered-lease holder** (proxied-to-holder, like
  `coverageOk`). No provider-report row ever crosses into a peer's money gate.
- **Price authority: `unified` (canonical manifest) + machine-local observed cache.**
  The canonical manifest is git-tracked and identical everywhere; the per-machine
  SQLite index is a regenerable view. The observed cache is machine-local REPORTING
  input only (its `machine-local-justification`: probe results are this machine's
  observations; they carry no authority, feed no gate, and promote only through
  git/PIN).
- **Operator adjustments (overlay + credits): machine-local BY DESIGN — declared, with
  the merge-once composition rule (IL2-2/FD-12).** See Layer 1b. They never reach the
  gate; pool reads apply the SERVING machine's adjustments exactly once at the merge
  point, labeled `adjustmentsSource`.
- **Money authority (caps, go-live, committed counter): SINGLE-WRITER in Increment B
  (FD-20).** The whole cap and the `MeteredSpendLedger` live on the ONE PIN-designated
  metered-lease machine; other machines hold no cap authority and their metered calls
  fail closed `no-cap-slice` (in B, metered dispatch is only armed on the holder
  anyway). The caps money-READ is **proxied-to-holder** (IL2-1): a non-holder machine
  proxies `GET /routing-spend/caps` money numbers to the holder and NEVER renders its
  empty local ledger as `$0 spent`; holder-unreachable is stated honestly with
  last-known values + age.
- **Increment D (dark until built): `replicated` cap authority via the FENCED pool
  lease with CUMULATIVE-COMMITTED accounting (FD-10).** Issuance is fenced
  single-writer (`FencedLease`; epoch-stamped; failover re-derives before issuing —
  the `AccountFollowMeGrants`/`AccountFollowMeSpendSlice` MECHANISM, not its
  allocation accounting). The local O(1) gate re-validates the slice epoch on EVERY
  call (A-B4). Pool committed reports are ABSOLUTE folded values. Cross-machine ARMING
  in D uses the receiver-verifiable operator-signed authorization (S-F4/C2-3);
  a replicated record alone can never arm a door or raise a cap on a peer. The
  signed arming record is bound with a nonce, an expiry, and an AUDIENCE (the target
  machine id) so it cannot be replayed onto a different peer or re-played to re-arm
  after a disarm — pinned here as a D design requirement for D's own convergence.
- **`frozen` is FREEZE-WINS / monotone-latching under any replication (S-F5).** Any
  `frozen:true` from any machine wins; `frozen:false` is authoritative only from a
  LOCAL PIN unfreeze on the holder.
- **Alert emission: `unified` single-voice from the metered-lease holder** with stable
  pool-wide ids (`spend-cap:<keyRef>:<capKind>:<threshold>:<dayEpoch>`, holder-stamped
  dayEpoch — A-M6), plus the ONE named surviving-voice exception: holder-dead is
  emitted by a surviving machine (A2-2). Door-dark/fallback alerts key on
  `<machineId>:<chain>` (machine-specific by nature). **The ONE dedicated
  "💰 Routing & Spend Alerts" topic is a `unified` create-once system topic: the
  SERVING-lease holder is its sole CREATOR (fenced + lease-confirmed — the
  duplicate-topic guard; deliberately not the metered-lease holder, which may not
  exist yet), the persisted id is published pool-wide on the machine-registry/
  heartbeat surface (so peers and every future lease holder inherit the SAME id
  instead of re-creating), and any machine that is not the confirmed creator falls
  back to the lifeline rather than risk creating a second topic** (Amendment 2). A
  single-machine agent is trivially its own serving-lease holder.
- **Fresh single-machine agent = clean no-op.** Dark → routes 503; no peers →
  `scope=pool` degrades to self; nothing armed → gate inert.

The two machine-local surfaces (observed price cache; operator overlay/credits) are
declared above with their justifications; every other surface is unified,
proxied-on-read, proxied-to-holder, or (in D) lease-replicated.

## Self-Heal Before Notify — watcher declaration

Only the **alert layer (Increment C)** introduces monitor/notice sources:

| Degradation | Class | Self-heal (upstream) | Escalation gate | P19 brakes |
|---|---|---|---|---|
| Door dark (`RouterFailClosedError`) | recoverable | swap-tail (incl. a cap-refused door advancing like a dark one) falls to the next; escalate ONLY on whole-chain exhaustion (incl. free tails) | downstream of chain-exhaustion | `max-attempts` = chain length; `dedupe-key` = `spend-door-dark:<machine>:<chain>:<episodeBucket>`; widening backoff; flapping breaker (N/window → critical, bypasses coalescing); `max-notification-latency: 120s`; scrubbed jsonl |
| Fallback used (swapTail served) | recoverable | the fallback succeeding IS the heal | jsonl-only; a digest line ONLY on a rate-spike (vs trailing baseline / absolute ceiling) — routine churn never notifies | spike-threshold gate; `dedupe-key` per chain |
| Cap hit (reservation would cross) | recoverable (protective) | none needed — blocking spend is the safe direction | one edge-triggered notice ("reservation would exceed", actual-vs-reserved) | edge-trigger dedup latched on CONFIRMED delivery (durable relay); DISTINCT money-critical lane; `dedupe-key` = `spend-cap:<keyRef>:<capKind>:<dayEpoch>` |
| Approaching 50%/80% (daily AND lifetime) | recoverable | n/a informational | one edge-triggered notice per (capKind, threshold, window) | edge-trigger dedup; digest-coalesced |
| Metered-lease holder dead | critical (money frozen) | the freeze itself IS the safe state; recovery = operator PIN reclaim | mesh-death threshold confirmed; emitted by a SURVIVING machine (named single-voice exception) | ONE per episode, stable pool-wide id `spend-holder-dead:<keyEpoch>`; never per-heartbeat |
| Provider-reconciliation drift (Layer 1c) | recoverable (informational) | n/a — observability of a booked-vs-reported gap; the fix is a human price promotion | one edge-triggered digest line above `driftAlertPct`; below it, jsonl-only (Near-Silent) | edge-trigger dedup; `dedupe-key` = `spend-recon-drift:<keyRef>:<door>:<driftBucket>`; shares the informational (non-money-critical) lane; NEVER moves the gate |

Composes with No Silent Degradation: every detection + heal-attempt is audited to the
scrubbed metadata-only `logs/routing-spend-alerts.jsonl`. The door-dark watcher's gate
extraction into the reusable `SelfHealGate` layer is a registered follow-up (Close the
Loop).

## Testing (Testing Integrity Standard — three tiers; I-6 / B5 / LF-F3)

- **Unit** — as-of join (correction-supersede, freshness/stale + staleMode,
  validation-fail-closed, day-alignment lint, cached-rate formula, canonical()
  round-trip); subsidy/credit REPORTING math + the never-reaches-gate invariant;
  `MeteredSpendLedger` reserve/settle/expire idempotent terminal states (late settle
  after expiry books ABSOLUTE — the A2-1 race test), all-no-charge→$0, locked sweep,
  TTL; the O(1) gate boundary (`≤ cap` allow, `> cap` refuse) + the full fail-closed
  matrix (unreadable/unknown/implausible/negative/stale-epoch/frozen/
  unbounded-reservation/**lease-liveness-unconfirmed** — the N-2 self-fence, incl.
  window < mesh-death-threshold); reserve sizing requires hard `max_tokens`;
  **two concurrent reserves are mutually visible in the committed total**;
  cumulative-committed pool math (never-re-credit lifetime; dayEpoch daily reset;
  absolute folded reports); gate-refusal → swap-tail advance; alert edge-trigger dedup
  + episode bucket + the fallback **rate-spike gate** (steady churn emits nothing);
  metadata-only scrub vs a poisoned provider error body; NULL-door uncosted composer;
  refresh-job-writes-observed-only; `cachedInPerMtok ≤ inPerMtok` lint;
  **provider-report PREFER-on-read (provider-reported cost wins; provider tokens
  replace the estimate; append-only supersede by `(meteredCallId, capturedAt)` — a
  same-call `/generation` row supersedes the in-response row, two different calls
  never cross-match); the per-door BILLED-token mapping at the settle (Gemini
  candidates+thoughts; unconfirmable basis → worst-case); receive-time clamp
  (NaN/Infinity/negative dropped as `invalid-provider-report`; poisoned provider body
  through capture + render); reconciliation drift math (signed `driftPct`,
  LOWER-never-lowers-committed, HIGHER→alert+promotion-hint) + the never-reaches-gate
  invariant (the gate/settle read set excludes the `provider_cost_report`/
  reconciliation store — twin of the `feature_metrics` + subsidy/credit
  gate-exclusion tests — and the settle takes tokens ONLY from the in-hand response);
  corrupt/stale/missing totals-checkpoint → full re-fold recovery (fail-closed while
  folding)**.
- **Integration** — routes 200 / 503 (dark) / 403 (Bearer-without-PIN); **Bearer
  `PATCH /config` can neither arm/unfreeze/raise NOR influence any gate-consumed price
  value** (S-F2 + A2-3 regression); a payload field absent from the rendered plan
  cannot commit — asserted for caps/adjust, go-live, reclaim, AND the
  **price-promotion route** (S2-3 + N-1); a plan nonce is single-use, expires, and a
  commit is refused when underlying state changed since render (C3-4); reclaim is
  REFUSED while the alive-but-partitioned signal is live (N-2); `scope=pool` merges +
  tags `pool.failed`; caps read proxies to holder + honest `holderUnreachable`;
  `door === keyRef.door` wiring; a metered `keyRef` never resolves to
  $0/subscription; the summary/reconciliation routes expose `costBasis`/
  `providerReportedUsd`/`providerDriftPct` (Layer 1c).
- **Alerts — ONE dedicated topic (Amendment 2)** — every alert kind (cap /
  approaching / door-dark / fallback / price-drift / reconciliation-drift) delivers to
  the SAME resolved topic id via `sendToTopic`, NEVER `POST /attention` (asserted: no
  per-item topic is created); the resolution LADDER resolves an operator-configured id
  without creating, and inherits a pool-published id without creating; auto-create
  makes EXACTLY ONE topic — a concurrent burst (single-flight), a non-serving-lease
  machine, an unconfirmed lease, AND a post-handoff NEW serving-lease holder (which
  must inherit the pool-published id) each create NO second topic; a deleted-topic
  re-create does not duplicate; money-critical alerts ride the durable relay with
  dedup latched on CONFIRMED delivery (a failed send stays eligible) and fall back to
  the lifeline on unset/probe-failed/exhausted; a `telegramTopicId` repoint posts the
  audible confirmation into old + new topics.
- **E2E** — feature-alive through the production init path (`GET /routing-spend/summary`
  200 when enabled); PIN-gated write refused without PIN; fresh-single-machine no-op.
- **Burst-invariant** — the `SpendAlert` dispatcher's own dedup/coalescing under burst,
  asserting a burst of alerts across all kinds collapses to the bounded per-episode
  message count into the ONE dedicated topic (never a topic-per-item flood).

## Migration parity & Agent Awareness (I-3 / I-4)

- **Schema:** `door` AND `callId` (the `meteredCallId` join key — FD-21) ride
  `ensureAddedColumns()` (every DB open); the type + writer + INSERT all gain both.
  `spend_token_rollup` and the `provider_cost_report` + reconciliation tables are
  created idempotently at open; boot-reconcile backfills the rollup.
- **Config:** `migrateConfigRoutingSpendDark` (mirroring `migrateConfigNatureRoutingDark`,
  `PostUpdateMigrator.ts:440`) with existence checks, or `?? default` reads
  everywhere. The retention/prune edit point is `AgentServer.ts:1113`.
- **Jobs:** the price-refresh job ships as a template manifest under
  `src/scaffold/templates/jobs/instar/` (the `doorway-scan` precedent);
  `installBuiltinJobs()` (invoked from `PostUpdateMigrator.ts:3452`) installs it
  non-destructively on update — no bespoke migration needed (named for completeness).
- **CLAUDE.md template (Agent Awareness):** `generateClaudeMd()` gains a Capabilities
  block (curl examples + proactive triggers + a Registry-First "what's my spend /
  caps?" row); `migrateClaudeMd()` gets a content-sniff insertion for existing agents.

## Vendored bench logic (grounding-honesty; F4 / GF3)

The earned bench patterns (`settleCost`, two-phase reserve-settle, no-charge
force-settle, `frozen`, edge-triggered thresholds) live on `echo/serve-main`, NOT
canonical main. This spec VENDORS the exact logic into `src/` (the `MeteredSpendLedger`
+ alert emitters) as production code with its own tests. The metered-caps shape
(`{ keys: { <keyRef>: { provider, lifetimeCapUsd, dailyCapUsd, frozen } } }`,
key-NAMES-only) and metered-prices shape are re-expressed in the production
manifest/store above (the `(door, modelId)` key is an IMPROVEMENT over the bench's
model-id-only key, which carried prefixed/unprefixed duplicates at different prices).
One `keyRef` spans multiple `(door, model)` points (openrouter hosts `gpt-5.5` AND
`opus-4.8` under one key) — the per-key cap correctly aggregates across them.
**Honesty note on what the bench funnel does NOT vendor (FD-21):** the funnel's
`settleCost` books INTERNAL token×price from the parsed `usage` tokens — it does not
read a provider-reported COST. Layer 1c's provider-cost capture (OpenRouter's
`usage.cost`/`/generation`) is therefore NEW production behavior beyond the vendored
logic, added at the metered-call seam on the REPORTING side only; the vendored gate
math is unchanged.

## Alternatives considered (X-C6)

- **Stored cost projection.** Rejected for the money number (goes stale on price
  correction). ADOPTED for the immutable TOKEN sums (Layer 2), which never go stale —
  and made exact by day-aligned price points (FD-18).
- **Event-sourcing the whole spend domain.** The `MeteredSpendLedger` IS an
  append-only event log with a maintained fold — event-sourcing where it earns its
  keep (the money gate), not across the analytical layer.
- **Provider reporting as source of truth.** Split by what "provider reporting"
  actually is (FD-21). Per-call provider-REPORTED figures — OpenRouter's in-response
  `usage.cost` + `/generation` cost, and every provider's authoritative token counts —
  are **ADOPTED as the PREFERRED REPORTING anchor** (grounding on the provider per the
  operator directive) and as the reconciliation cross-check, but NEVER as the GATE
  source (the fail-closed gate cannot wait on a provider API, and a report arriving
  after the call must never re-open committed headroom). The heavyweight lagged path —
  monthly invoices / Google Cloud Billing (BigQuery) export — is Rejected as any
  real-time source and retained as a FUTURE drift-detection input (registered
  follow-up, alongside FD-11's booked-vs-billed reporting).
- **A live price service instead of a git manifest (X-G1).** Rejected for the gate:
  a network dependency on the money path adds a fail-open temptation and an
  unreviewed admission channel. The observed-cache + promotion flow captures the
  freshness benefit while keeping gate admission human-reviewed.
- **A plain SQLite transactional table instead of the `proper-lockfile` + append-only
  JSONL ledger for the money gate (C3-6).** SQLite would give transactions, but this
  repo's earned money-ledger discipline (`DriftSpendLedger`) is lockfile + append-only
  rows for load-bearing reasons: rows are human-auditable and grep-able after an
  incident; a partial/corrupt line is SKIPPED (malformed-row-skip) rather than taking
  the whole store down the way a corrupt SQLite page can (the NativeModuleHealer
  exists because better-sqlite3's native ABI breaks on Node upgrades — an acceptable
  risk for best-effort observability, NOT for the ledger whose unreadability fails
  the money path closed); and append-only files make the "never mutate a booking"
  invariant structurally obvious. The maintained O(1) total file (tmp+rename atomic)
  gives the read performance a transactional table would have provided. SQLite
  remains the right substrate for the REPORTING side (feature_metrics, the rollup,
  the price index), where a rebuildable/regenerable store is acceptable. **Bounded
  bespoke-ness (C5-2):** the ledger reuses DriftSpendLedger's daily-rotation
  convention (one file per UTC day + a monthly archive) so no single file grows
  unbounded — the fold-on-boot reads the current day + the totals checkpoint, not
  all history; and the build phase includes a short failure-injection comparison
  (torn append / torn rename / stale lock, JSONL-vs-SQLite-WAL) as a documented
  design proof rather than an assertion. **Checkpoint ≠ authority across rotation
  (the lifetime-cap corollary of C4-2):** with rotation, the LIFETIME total's fast
  path necessarily reads the checkpoint for pre-rotation history — so the checkpoint
  must be VERIFIABLE, not trusted: it records, per folded segment (day-file/archive),
  that segment's row-count + last-row high-water marker; a checkpoint that is
  missing, unparseable, or disagrees with any on-disk segment's markers triggers a
  FULL re-fold from all retained segments (which remain the complete rebuild source
  and are never pruned below the lifetime-cap accounting horizon), and the gate fails
  CLOSED for the key until the re-fold lands. Unit tests cover corrupt/stale/missing
  checkpoint → full-fold recovery.

## Increment split (FD-style — what ships when, and behind what gate)

- **Increment A — Read-only spend VIEW (dev-agent ENABLED, dark on fleet; no money
  authority).** Layer 0 `door` column; Layer 1 canonical manifest + observed cache +
  index + as-of join + validation + freshness; Layer 1b reporting subsidy/credit +
  overlay; **Layer 1c as SCHEMA + DISPLAY + INTERFACE CONTRACT: the
  `provider_cost_report` store, the PREFER-on-read `costBasis`, and the capture seam
  declared as an explicit interface (stamped `meteredCallId` + per-door capture
  fields) exercised by STUB-ONLY tests — the LIVE capture wiring lands with the
  out-of-scope metered dispatch itself (exactly like `door` attribution, FD-11), so A
  ships honestly empty provider data (display notes + the no-provider-data state),
  never a claimed-but-unwired capture**; Layer 2 daily token rollup + on-read pricing +
  boot reconcile + `GET /routing-spend/summary` + `GET /routing-spend/caps` (read); the
  Spend tab; the refresh job (OFF). Via `resolveDevAgentGate` on `routingSpend.enabled`;
  routes 503 when off. Honest `$0` / `not-live-yet`. Reversible by revert; persistent
  state is additive (and regenerable except the `provider_cost_report` store — which
  is empty in A and retention-governed thereafter).
- **Increment B — Money authority, SINGLE-WRITER (`DARK_GATE_EXCLUSIONS`,
  PIN-gated).** `MeteredSpendLedger` + the O(1) fail-closed gate (stub-testable
  against a fake metered dispatch until A2.2 + providers land — FD-11); whole-cap
  single-machine (FD-20); PIN routes + rendered-plan commit + phone-complete controls +
  the durable PIN-attempt counter + the cap-change audit log + the PIN-only state
  store; the stale-price + observed-drift alerts (C5-5 — they change money admission,
  so they ship with the money) **together with the MINIMAL dedicated-topic resolver
  foundation they deliver through** (the §Surface 2 resolution ladder + duplicate
  guard + durable money-critical delivery + lifeline fallback — B is the first
  alert-emitting increment, so the foundation ships here, keeping "B never depends on
  C" true); **the authoritative provider-reconciliation sweep (Layer 1c,
  booked-vs-provider-reported) — the per-call, faster form of FD-11's
  booked-vs-billed invoice-drift REPORTING, observability-only, never gate
  authority**. Go-live additionally requires
  FD-11's release gate (live wiring proof + holder-death drill + invoice/
  provider-report drift reporting). Inert until the operator arms a door.
- **Increment C — Alerts to ONE dedicated topic (dryRun-first live-on-dev).**
  `AlertChannel` + `TelegramSpendTopicChannel` delivering ALL alert kinds (cap /
  approaching / door-dark / fallback / price-drift / provider-reconciliation-drift)
  into the single **"💰 Routing & Spend Alerts"** topic via `sendToTopic`, EXTENDING
  the resolver foundation Increment B ships (the resolution ladder — operator id →
  pool-published record → serving-lease-holder create-once — + duplicate guard +
  durable money-critical delivery; on an agent with no Increment B the same
  foundation code ships with C itself, so C-without-B remains fully independent),
  NOT `POST /attention`; the emitters + Self-Heal gates + lifeline fallback + the
  surviving-voice holder-dead alert; the fan-out + scrubbed sink; dispatcher-level
  dedup/coalescing. Inert until nature-routing observation is enabled (I-9). Slack is
  a later config-add (`SlackSpendChannel` registry entry).
- **Increment D — Multi-machine cap slicing (dark until built;
  `DARK_GATE_EXCLUSIONS`).** FD-10's cumulative-committed lease slicing; per-call
  epoch fencing at every gate; the operator-signed cross-machine arming mechanism;
  quota-aware slice placement. Single-machine agents and un-enabled pools are strict
  no-ops. Ships only after B has a live soak.

Each increment is independently reversible and independently gated. A never depends
on B/C/D; B never depends on C; D extends B without changing A–C's surfaces.

## Open questions

*(none)*
