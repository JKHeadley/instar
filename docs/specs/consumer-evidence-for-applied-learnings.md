---
title: "Consumer Evidence for Applied Learnings — a learning that asserts a behavioral consequence cannot be marked applied on producer-side evidence alone"
slug: consumer-evidence-for-applied-learnings
author: "echo"
parent-principle: "Verify at the Consumer, Not the Producer (EDITED is not DELIVERED is not READ)"
sibling-principles: "Structure > Willpower (the verification trip must be forced at the write chokepoint, not remembered); Signal vs Authority (the detector is a conservative keyword floor; the AUTHOR declares, the gate only refuses an undeclared assertion); Close the Loop (a false causal claim marked applied is inherited by everything downstream); Testing Integrity"
eli16-overview: consumer-evidence-for-applied-learnings.eli16.md
source-proposal: "EVO-009 (approved 2026-08-23)"
status: draft
review-convergence: pending
approved: false
depends-on: "LearningEntry type (src/core/types.ts:1510-1529 — carries applied/appliedTo, no evidence field today); EvolutionManager.markLearningApplied (src/core/EvolutionManager.ts:1118-1126 — sets applied=true unconditionally, returns boolean); PATCH /evolution/learnings/:id/apply (src/server/routes.ts:23362-23380 — validates only that appliedTo is a non-empty string); LearningsReplicatedStore field clamp list (src/core/LearningsReplicatedStore.ts:161 — the replicated-field allowlist any new field must join)"
---

# Consumer Evidence for Applied Learnings

## 0. One-paragraph summary

A learning whose description asserts a **behavioral consequence** — "X cannot do
Y", "the guard prevents Z", "this reclaims N slots" — can today be marked
`applied` with no evidence that anyone ever went to the consumer end and looked.
Four learnings in this agent's own registry took that path, and one of them
(LRN-001) rode a false causal claim into an approved evolution proposal before
LRN-007 falsified it. This spec adds a required `consumerEvidence` field to
consequence-asserting learnings and refuses `PATCH .../apply` without it. The
detector is deliberately conservative and the author retains the declaration —
the gate refuses an *undeclared* assertion, it does not adjudicate truth.

## 1. Problem — the pattern across four learnings, three surfaces

The same failure recurs in different clothing: **a producer-side artifact is
read as evidence of a consumer-side effect.**

| Learning | Producer-side artifact taken as proof | What the consumer actually showed |
|---|---|---|
| LRN-001 | job manifest + `job_allowlist_clamped` log line | jobs held full tools regardless (falsified by LRN-007) |
| LRN-002 | a remediation written to derived state | inert by construction — the file was regenerated |
| LRN-007 | the clamp recorded in state and logged | the spawned process argv restricted nothing |
| LRN-008 | store-wide redundancy of 19.4% (270/1392 rows) | 263 duplicates sat in the invisible tail; merging reclaims 7 of 200 visible slots (3.5%) |

The through-line is not carelessness. **Producer-side evidence is cheap and
always at hand; consumer-side evidence requires going to the other end and
looking.** Nothing in the current write path forces that trip, so the cheap
evidence wins by default.

The acute cost is inheritance. LRN-001 reasoned from a manifest and a log line
straight to a behavioral claim, was marked `applied` with `appliedTo: EVO-002`,
and its central causal claim was never tested. Everything downstream inherited
a false premise, and the correction cost three days of remediation aimed at a
capability loss that had never occurred.

## 2. What exists today

- `LearningEntry` (`src/core/types.ts:1510`) carries `applied: boolean` and an
  optional free-text `appliedTo?: string`. There is no evidence field.
- `EvolutionManager.markLearningApplied` (`src/core/EvolutionManager.ts:1118`)
  finds the record, sets `applied = true`, sets `appliedTo`, saves, returns
  `true`. It performs no validation beyond existence.
- `PATCH /evolution/learnings/:id/apply` (`src/server/routes.ts:23362`)
  validates only that `appliedTo` is a non-empty string, then delegates.

So the write path has exactly one bar: *name something you applied it to.* That
bar is satisfiable by a producer-side artifact, which is the failure.

## 3. Design

### 3.1 Data model (additive, back-compatible)

Two optional fields on `LearningEntry`:

```ts
/** Author's declaration that the description asserts a behavioral
 *  consequence ("X cannot do Y", "this reclaims N"). When true, apply
 *  requires consumerEvidence. Undefined means "not declared" — the
 *  detector's conservative floor then decides. */
consequenceAsserted?: boolean;

/** Consumer-side evidence gathered before this learning was applied. */
consumerEvidence?: {
  /** WHAT was inspected at the consuming end — a live process argv, a
   *  rendered output, the visible slice of a capped view. */
  consumer: string;
  /** WHAT was observed there. */
  observed: string;
  /** ISO-8601 instant the observation was made. */
  observedAt?: string;
};
```

Every existing record is untouched and stays readable. `applied` semantics are
unchanged for learnings that assert no consequence.

### 3.2 Detection — conservative floor, author declares

A pure, dependency-free exported function:

```
assertsBehavioralConsequence({ title, description, consequenceAsserted })
  → { asserts: boolean, basis: 'declared' | 'keyword-floor' | 'none',
      matched?: string[] }
```

Resolution order:

1. `consequenceAsserted === true` → `asserts: true`, basis `declared`.
2. `consequenceAsserted === false` → `asserts: false`, basis `declared`.
   **The author can always opt out explicitly.** This is the escape hatch that
   keeps the gate from becoming an unappealable authority.
3. Otherwise → keyword floor over title + description. Any match →
   `asserts: true`, basis `keyword-floor`.

The floor matches consequence-shaped constructions, not topics:
`cannot`, `can't`, `unable to`, `prevents`, `blocks`, `stops`, `ensures`,
`guarantees`, `means that`, `results in`, `causes`, `reclaims`, `saves`,
`reduces … by`, `will not`, `never runs`, `has no effect`, `is inert`.

**Fail direction:** ambiguity resolves toward *requiring* evidence. A false
demand costs one verification trip; a false exemption cost three days.

### 3.3 The refusal

`markLearningApplied` gains an options parameter and returns a discriminated
result instead of a bare boolean:

```
{ ok: true, learning }
| { ok: false, reason: 'not-found' }
| { ok: false, reason: 'consumer-evidence-required',
    basis, matched, guidance }
```

`PATCH /evolution/learnings/:id/apply` maps:

- `not-found` → **404** (unchanged).
- `consumer-evidence-required` → **422** with the basis, the matched keywords,
  and the two questions the author must answer (which consumer, what observed).
- success → **200** (unchanged shape, plus the stored evidence).

422 rather than 400: the request is well-formed; the *record* is not yet
eligible. This also keeps the existing 400 (`"appliedTo" is required`)
distinguishable from the new refusal in any caller that branches on status.

### 3.4 Signal vs authority

This is a **write-precondition on the agent's own bookkeeping**, in the same
class as the existing `appliedTo` requirement one line above it. It gates no
message, no outbound action, and no user-facing behavior. It cannot block work
— only the *claim* that a lesson was verified. The author retains the final
word through `consequenceAsserted: false`, so the brittle keyword floor never
holds unappealable authority over the mind. That is the signal-vs-authority
shape: brittle detector, cheap override, no blocking power over real work.

### 3.5 Replication

`consequenceAsserted` and `consumerEvidence` join the
`LearningsReplicatedStore` field allowlist (`src/core/LearningsReplicatedStore.ts:161`)
with the same type clamps the store already applies: booleans strictly
boolean, free text length-clamped, `observedAt` ISO-8601-or-dropped. A peer's
evidence is quoted untrusted data inside the existing
`<replicated-untrusted-data>` envelope — advisory, never authority, and never
sufficient on its own to satisfy a local apply.

## 4. The measurement rule (the same principle, applied to numbers)

LRN-008 is the same error wearing a statistic. The generalized rule, worth
carrying past this gate:

> **Evaluate a remedy inside the window that is actually consumed, never
> across the whole store.** An aggregate over a population says nothing about
> the sample the consumer reads.

This spec does not mechanize the measurement rule — a store-wide-vs-visible-slice
detector is not reliably computable from a free-text description. It is recorded
here because the rule is what makes the `consumer` field meaningful: for a
capped, ranked, or filtered view, "the consumer" is *the visible slice*, not the
store. The field's guidance text says so explicitly.

### 4.1 The mirror error — an average over a selected set measures the selection

The rule above guards one direction: generalizing from the whole store to the
slice the consumer reads. The opposite direction failed live on 2026-08-26 and
belongs beside it (LRN-022; proposal EVO-015).

> **Never generalize from a hand-picked slice to the population — and treat it
> as disqualifying when the picking criterion correlates with the axis being
> measured.**

MEASURED. A hygiene pass reported the durable memory class as 212 lessons ×
280 words = 59,360 words = 11× the 5,000-word budget. The 280-word figure was
the average size of the **pinned** entries. Pinning is a deliberate act prior
passes performed on hand-authored, detailed lessons, so the pinned set *is* the
large-entry set — selected on exactly the axis under measurement. Direct
measurement over all rows: 228 lessons = 11,799 words = 2.4× budget. Unpinned
entries average 242 chars; pinned average 1,745 (7.2×). Fourteen hand-authored
pinned entries hold 38% of the file in 7% of the slots.

COST. Two work items (proposal EVO-007, action ACT-292) reached approved state
on that one unchecked average, and the remedy it implied — a per-item
compression stage across every exported entity — was aimed at a defect the
population does not have. The refuting check needed no new data collection.

THE TELL WAS ALREADY ON THE SCREEN. The unpinned population is uniform at
198–242 average chars across *every* entity type (decision 242, lesson 242,
pattern 238, fact 223, project 212, tool 203, person 198) because one write site
generates them all. Uniformity across categories that have no reason to be
uniform is the signature of a single producer: a per-item size defect cannot
exist in a machine-written population produced by one writer.

SELECTED SETS TO TREAT AS SUSPECT BY DEFAULT — pinned vs unpinned, retained vs
dropped, escalated vs routine, alerted vs silent, sampled vs full. Each is a
selection, and an average over it measures the selection.

### 4.2 Reporting form — every average carries its n and its selector

Both rules above are unenforceable on a bare number, and cheap to satisfy in the
report:

> **A reported average states the sample size it was taken over and the rule
> that chose the sample.**

"280 words" and "228 lessons averaging 52 words, measured over all rows" cost
the same to write; only the second can be checked. This is a **reporting-format
requirement on measurement prose, not a schema field** — a field here would be
enforcement theatre, because nothing can verify a free-text selector string. It
is recorded as a spec-level rule for the same reason §4 is: the `consumer` field
is only meaningful if the number attached to it is checkable.


## 5. Acceptance criteria

1. A learning asserting no consequence applies exactly as today (200, no new
   fields required). **Back-compat is a test, not an assumption.**
2. A learning whose description trips the keyword floor, applied with no
   evidence → 422 naming the basis and matched keywords.
3. The same learning applied WITH `consumerEvidence` → 200, evidence persisted
   and readable on `GET /evolution/learnings`.
4. `consequenceAsserted: false` on a floor-tripping learning → 200 (explicit
   author opt-out honored).
5. `consequenceAsserted: true` on a learning with no keyword match and no
   evidence → 422 (declaration outranks the floor in both directions).
6. Evidence with an empty/whitespace `consumer` or `observed` is refused —
   a blank field must not satisfy the gate.

## 6. Testing (three tiers, per the Testing Integrity Standard)

- **Unit** — the detector as a pure function across all six acceptance rows,
  plus the manager's discriminated return.
- **Integration** — the full HTTP path: 404 / 400 / 422 / 200 for the same
  route, asserting the 422 body carries basis + matched + guidance.
- **E2E** — production initialization path: create a consequence-asserting
  learning, observe the 422, supply evidence, observe the 200, and read the
  evidence back off the listing route.
- **Wiring integrity** — assert the route's refusal is produced by the manager,
  not re-derived in the route (one authority, one place).

## 7. Rollback

Single revert. The fields are optional and additive: reverting leaves any
already-written `consumerEvidence` inert on disk and restores the prior
unconditional apply. No migration, no data loss, no fleet-rollout surface.

## 8. Decided defaults (not open questions)

| Decision | Value | Why |
|---|---|---|
| Refusal status | 422 | Well-formed request, ineligible record; keeps 400 distinguishable |
| Ambiguity direction | require evidence | A false demand costs one trip; a false exemption cost three days |
| Author override | `consequenceAsserted: false` honored unconditionally | A brittle floor must never hold unappealable authority |
| Ships dark? | No — always on | It gates only the agent's own bookkeeping; no user-facing surface, no fleet blast radius |
| Retroactive sweep of already-applied learnings | No | Rewriting history would erase the record of how the false claims got in |
