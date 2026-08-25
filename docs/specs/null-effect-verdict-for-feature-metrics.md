---
title: "Null-Effect Verdict for Feature Metrics — a component that runs cleanly and acts on nothing must be graded, not merely counted"
slug: null-effect-verdict-for-feature-metrics
author: "echo"
parent-principle: "Report the State I Can Evidence (posted / delivered / read / acted-on are four different facts)"
sibling-principles: "Structure > Willpower (the ratio must be graded where I already look, not by resolving to look harder); Observable Intelligence (no autonomous action the system takes may be invisible — including the action it never took); Signal vs Authority (the verdict is observability; it gates nothing and pauses nothing); Verify at the Consumer (the number exists at the producer; nothing reads it at the consumer)"
eli16-overview: null-effect-verdict-for-feature-metrics.eli16.md
source-proposal: "EVO-012 (approved 2026-08-25) — scope note: item 1 only, which the proposal itself designates as the smallest buildable piece"
status: draft
review-convergence: pending
approved: false
depends-on: "FeatureRollup shape (src/monitoring/FeatureMetricsLedger.ts:110-141 — already carries fired/noop/unclassified/shed/fireRate/fireRateInsufficientEvidence); the rollup mapper (src/monitoring/FeatureMetricsLedger.ts:1123-1160 — where fireRate is computed and where a verdict field would be added); GET /metrics/features (src/server/routes.ts:10407-10434 — the serving route, which passes the rollup through unchanged)"
---

# Null-Effect Verdict for Feature Metrics

## 0. One-paragraph summary

`GET /metrics/features` already computes `fireRate` for every component. Nothing
reads it. A component that made 8,806 clean calls and fired on zero of them
scores identically to a healthy one on every surface that grades this ledger —
because what is graded is `errorRate`, which only speaks when work breaks
loudly. Work that runs cleanly and produces nothing scores perfectly. This spec
adds one derived verdict field to the existing rollup, keyed on `fireRate === 0`
with a classified denominator and a minimum call floor. It adds no new
collection, no new store, and no new route. It gates nothing.

## 1. Problem — the number exists and nothing reads the ratio

Measured on this agent, `sinceHours=168`, 2026-08-25:

| feature | calls | fired | noop | unclassified | errors | fireRate |
|---|---|---|---|---|---|---|
| durable-output-scrub | 8806 | 0 | 8806 | 0 | 0 | **0** |
| TopicIntentExtractor | 3089 | 0 | 0 | 3003 | 86 | null |
| completion-claim-verify | 1898 | 0 | 0 | 1802 | 96 | null |
| MessagingToneGate | 1260 | 0 | 0 | 1219 | 41 | null |
| SessionActivitySentinel | 746 | 0 | 0 | 724 | 22 | null |
| ProfileIntentClassifier | 487 | 0 | 0 | 78 | 409 | null |

`durable-output-scrub` is the case the proposal describes: a classifier is
wired, it returned a verdict on all 8,806 calls, and the verdict was `noop`
every single time. It is dead work, and no surface says so.

The proposal (EVO-012) also asserted a standing self-observation of mine —
*absence of output reads to me as health* — and the observation holds against
this table. Nothing here alarmed. `errorRate` is the only graded ratio, and a
component with 0 errors and 0 effect is, by that grade, perfect.

## 2. The premise correction this spec makes to its own proposal

**EVO-012 item 1 proposed flagging `calls ≥ floor && fired === 0 && shed === 0`.
Applied literally to the table above, that rule flags 14 components — and 13 of
them would be a false alarm.**

The `fired === 0` population splits into two classes that the ledger already
distinguishes and the proposed rule would conflate:

- **Class A — classifier wired, never acts.** `fired=0`, `noop=N`,
  `fireRate = 0`. One component: `durable-output-scrub`. This is genuinely
  dead work.
- **Class B — no classifier wired at all.** `fired=0`, `noop=0`,
  `unclassified=N`, `fireRate = null`, `fireRateInsufficientEvidence = true`.
  Thirteen components. `MessagingToneGate` is the decisive counterexample: it
  is the always-on outbound gate that fails closed and hard-blocks the
  self-stop family. It certainly acts. Its effect is invisible because its
  **callsite never declares a verdict**, not because it does nothing.

Grading Class B as "dead work" would put a false alarm on a live safety gate —
the precise failure mode the parent principle exists to prevent, run in the
opposite direction. So:

> **The verdict keys on `fireRate === 0`, never on `fired === 0`.**

Class B is a real gap too, and it is larger (13 components, ~9,109 unclassified
calls in the window). But it is a *different defect with a different fix* —
an unwired classifier at the callsite, not a component to retire. It gets its
own separate, non-alarming verdict so the two are never merged into one count.

`ProfileIntentClassifier` — LRN-016's original example — belongs to Class B,
not Class A: its 487 calls are 409 errors and 78 unclassified, with zero
classified verdicts. LRN-016's diagnosis (dead work, invisible) stands; its
specific mechanism is refined by this measurement.

## 3. Design

### 3.1 Two derived fields on `FeatureRollup`

Added in the mapper at `FeatureMetricsLedger.ts:1123-1160`, beside the existing
`fireRate` computation. Both are **derived per read** from counters already in
the rollup — no schema change, no migration, no new column.

```ts
/** Classified verdicts exist and none of them acted. Dead work. */
nullEffect: boolean;
/** No callsite verdict classifier: effect is unmeasured, not absent. */
effectUnmeasured: boolean;
/** Why the grade is what it is — always populated, never null. */
effectVerdict: 'acts' | 'null-effect' | 'unmeasured' | 'below-floor';
```

Computation, in full:

```ts
const classifiedCalls = fired + noop;          // already computed at :1127
const eligible = realCalls >= NULL_EFFECT_MIN_CALLS && shed === 0;
const nullEffect       = eligible && classifiedCalls > 0 && fired === 0;
const effectUnmeasured = eligible && classifiedCalls === 0 && unclassified > 0;
const effectVerdict =
    !eligible                 ? 'below-floor'
  : nullEffect                ? 'null-effect'
  : effectUnmeasured          ? 'unmeasured'
  :                             'acts';
```

`NULL_EFFECT_MIN_CALLS` is a module constant, default **50**, matching the
proposal's suggested floor. `shed === 0` is required because a shed call never
ran — a breaker-throttled component has not been given the chance to act, and
counting it as null-effect would blame the wrong layer.

`realCalls` (not `calls`) is the denominator, so shed rows cannot pad a
component over the floor.

### 3.2 One summary count on `totals`

```ts
nullEffectFeatures: string[];    // feature names, sorted, verdict 'null-effect'
unmeasuredFeatures: string[];    // feature names, sorted, verdict 'unmeasured'
```

Names rather than a bare count, because a count alone reproduces exactly the
defect this spec exists to fix: it says something is wrong without saying what.
Both arrays are bounded by the number of distinct features in the window
(29 on this agent) and are already-public component names — no new data class.

### 3.3 `/health` degraded reason

EVO-012 asks that a clean-erroring dead component be as visible as a
97%-erroring one. `/health` gains **one** additional degraded reason:

```
feature-null-effect: <n> component(s) ran ≥50 calls and acted on none (<names>)
```

**Severity is `degraded`, never `unhealthy`.** A dead component is a waste, not
an outage, and promoting it to unhealthy would make a bookkeeping finding page
someone. `unmeasured` does **not** appear in `/health` at all — 13 components
would put a permanent degraded banner on a healthy agent, and a permanently-lit
warning is a warning nobody reads. `unmeasured` lives on `/metrics/features`
and the LLM Activity dashboard tab only.

### 3.4 What this deliberately does not do

- **It does not gate, pause, disable, or throttle anything.** The verdict is
  observability. A null-effect component keeps running until a human decides
  otherwise. (Signal vs Authority.)
- **It does not touch collection.** No new `record()` callsites, no new
  outcomes, no change to what is written.
- **It does not cover EVO-012 items 2 and 3** (job-gate skip alarms;
  predicate match counts). Those are separate builds against separate
  surfaces; the proposal's own scope note says item 1 ships first and alone.

## 4. Rollback

Single-revert. The fields are derived per read from existing counters, so
reverting the mapper change removes them with no residue — no migration to
undo, no rows to rewrite. The `/health` reason is one branch guarded by the
same constant; setting `NULL_EFFECT_MIN_CALLS = Infinity` disables every
verdict (`below-floor` everywhere) without a deploy of the mapper itself.

## 5. Test plan (Testing Integrity Standard — all three tiers)

**Tier 1 — unit (`tests/unit/`), against `FeatureMetricsLedger.summary()`:**

| case | fired | noop | unclass | shed | realCalls | expected verdict |
|---|---|---|---|---|---|---|
| classifier wired, never acts | 0 | 8806 | 0 | 0 | 8806 | `null-effect` |
| classifier wired, acts | 388 | 17801 | 0 | 0 | 18189 | `acts` |
| no classifier | 0 | 0 | 1219 | 0 | 1260 | `unmeasured` |
| under floor | 0 | 12 | 0 | 0 | 12 | `below-floor` |
| exactly at floor | 0 | 50 | 0 | 0 | 50 | `null-effect` |
| all shed | 0 | 0 | 0 | 60 | 0 | `below-floor` |
| some shed, over floor | 0 | 60 | 0 | 5 | 60 | `below-floor` (shed ≠ 0) |
| zero calls | 0 | 0 | 0 | 0 | 0 | `below-floor` |

The **third row is the regression test that matters**: it is the false alarm
this spec's premise correction exists to prevent, and it must assert
`nullEffect === false` for a component with 1,260 calls and zero fires.

**Tier 2 — integration (`tests/integration/`):** `GET /metrics/features`
returns `effectVerdict` on every feature row and `nullEffectFeatures` /
`unmeasuredFeatures` on `totals`; `?feature=` filtering preserves both;
the 503 path when the ledger is unavailable is unchanged.

**Tier 3 — E2E (`tests/e2e/`):** through the production initialization path,
seed a component with 60 noops and no fires, assert `/health` reports the
`feature-null-effect` degraded reason naming it, and assert a 13-component
`unmeasured` population does **not** degrade `/health`.

**Wiring integrity:** assert the route serves the mapper's computed verdict
rather than recomputing it — one grading site, so a future change to the floor
cannot silently disagree between `/health` and `/metrics/features`.

## 6. Live example to verify against

`durable-output-scrub` on this agent: 8,806 calls / 0 fired / 8,806 noop /
fireRate 0 over 168h as of 2026-08-25. It should be the single member of
`nullEffectFeatures` on first run. If the implementation returns 14 members,
it has keyed on `fired === 0` and §2 was not honored.
