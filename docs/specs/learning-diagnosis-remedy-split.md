---
title: "Learning Diagnosis/Remedy Split — the perishable half of a durable record must not inherit the durable half's authority"
slug: learning-diagnosis-remedy-split
author: "echo"
parent-principle: "Close the Loop (Untracked = Abandoned) — a record that is never revisited rots, and a rotted remedy is acted on with the confidence its diagnosis earned"
sibling-principles: "Report the State I Can Evidence (a remedy's preconditions are part of its state and must be recorded, not assumed); Structure > Willpower (a reader cannot be trusted to remember that the recipe half went stale); Verify at the Consumer (a reproduction step must carry the exact invocation, because the dropped parts are what make the next reproduction fail for the wrong reason)"
eli16-overview: learning-diagnosis-remedy-split.eli16.md
source-proposal: "EVO-013 (approved 2026-08-25)"
status: draft
review-convergence: pending
approved: false
depends-on: "LearningEntry type (src/core/types.ts:1510-1529 — carries applied/appliedTo, no diagnosis/remedy/supersededBy today); markLearningApplied (src/core/EvolutionManager.ts:1118-1126 — one-way, sets applied=true unconditionally); PATCH /evolution/learnings/:id/apply (src/server/routes.ts:23362-23380); LEARNING_STORE_KNOWN_FIELDS replicated-field allowlist (src/core/LearningsReplicatedStore.ts:154-163 — any new field must join it or it is stripped on replication)"
related-spec: "docs/specs/consumer-evidence-for-applied-learnings.md (EVO-009 — the other end of the same loop: evidence required BEFORE applied; this spec is what happens AFTER the world moves)"
---

# Learning Diagnosis/Remedy Split

## 0. One-paragraph summary

A learning is stored today as one undifferentiated block of durable truth. In
practice it holds two halves that age at completely different rates: a
**diagnosis** (what was happening and why — usually durable) and a **remedy**
(what to do about it — perishable, and quietly dependent on conditions that
held only on the day it was written). Because they share one field and one
authority, a stale remedy is acted on with the confidence its diagnosis earned.
This spec splits them, requires a remedy to name its preconditions, and makes
`applied` reversible so a refutation has somewhere to attach.

## 1. Problem — verified in this agent's own registry

Read from `GET /evolution/learnings`, 2026-08-25 — 20 learnings, and the stored
fields on every one of them are exactly:

```
['applied', 'appliedTo', 'category', 'description', 'id', 'source', 'tags', 'title']
```

There is no `diagnosis`, no `remedy`, no `supersededBy`. Everything a learning
knows lives in one prose `description`, and `applied` is a boolean with no
reverse gear.

**LRN-015 → LRN-019 is the case that proves the cost, and it is live in the
registry right now.**

- **LRN-015** (`applied: true`, `appliedTo: ACT-283`) diagnosed reroute-lane
  starvation and closed with a remedy: *close the unbound session holding a
  lane*. On 2026-08-24 that remedy was correct — the holder was a stray.
- **LRN-019** (`applied: true`, `appliedTo: EVO-013`) records that on
  2026-08-25 every lane holder was sanctioned Window 26 work, and following
  LRN-015's remedy literally **would have killed live work**.

The diagnosis was still true 24 hours later. The remedy was not. And LRN-015
still reads `applied: true` today with no pointer to the learning that refuted
half of it. A reader arriving at LRN-015 cold gets the destructive instruction
at full authority, and nothing in the record warns them.

Three more in the same registry share the shape:

- **LRN-014**: a verification artifact recorded only the URL path and dropped
  the required intent header. The next reader reproduced a 403 that was the
  route's *shape*, not a regression. The recipe outlived its unstated
  dependencies.
- **LRN-011**: refuted two claims that were **already marked applied**. Because
  `applied` is one-way, the refuted claims stayed marked done. The refutation
  had nowhere to go except a brand-new learning that the original does not
  reference.
- **LRN-018**: a live defect was diagnosed and written durably to two places,
  then ran unchanged for the rest of the day. Writing the diagnosis felt like
  responding to it.

## 2. Design

Three additive changes. No new store, no new route, no migration of existing
rows.

### 2.1 Split the fields (additive, optional)

`LearningEntry` gains three optional fields. `description` is untouched and
remains the canonical body — every one of the 20 existing learnings stays valid
and is never rewritten.

```ts
/** What was happening and why. Durable — survives condition changes. */
diagnosis?: string;
/** What to do about it. Perishable — void when its conditions no longer hold. */
remedy?: {
  action: string;
  /** The conditions this action assumes. REQUIRED when remedy is present. */
  assumes: string[];
};
/** Set when a later learning refutes this one, in whole or part. */
supersededBy?: string;
```

**A `remedy` without a non-empty `assumes` is refused** at the write path. That
refusal is the whole mechanism: the cost of LRN-015 was not that its remedy was
wrong, it was that the remedy's preconditions were never written down, so no
reader could check them. Had LRN-015 carried
`assumes: ["the lane holder is unbound", "no jobSlug", "no topic", "not
protected"]`, a 2026-08-25 reader would have checked four conditions, found
them false, and stopped.

**Reader contract (documented, not enforced):** if a remedy's `assumes` do not
hold, the remedy is void and the diagnosis still stands. This is deliberately
not machine-checked — `assumes` entries are prose about arbitrary world state,
and a checker that could evaluate them would be a much larger build. The value
is in forcing the author to *name* them, which is what was missing.

### 2.2 Make `applied` reversible

`markLearningApplied` is one-way today (`EvolutionManager.ts:1118-1126`). Add:

- `POST /evolution/learnings/:id/supersede` with `{ supersededBy, reason }` —
  sets `supersededBy`, sets `applied = false`, and appends the reason to the
  record. `supersededBy` must reference an existing learning id (404 otherwise),
  so a refutation cannot point at nothing.
- The reciprocal is **not** automatic. Marking LRN-019 applied does not reach
  back and reopen LRN-015; a human or a later pass makes that call explicitly.
  Auto-reopening on a keyword match would let one learning silently invalidate
  another, which is authority the detector should not have.

Backfill for the live case is a **one-line call, not a migration**: supersede
LRN-015 with LRN-019 once the route exists.

### 2.3 Reproduction steps carry the invocation, not the path

Anything recorded as a reproduction step carries the **exact invocation** —
method, full URL including query, required headers, and working directory —
not a bare path. LRN-014 is the whole argument: the dropped part (`X-Instar-Request: 1`)
was exactly the part that made the next reproduction fail for the wrong reason.

This is a **documentation and template change**, not a schema change: it lands
in the `/learn` skill's capture template and in the verification-artifact
format. There is no field to enforce it, and inventing one would be enforcement
theatre over a free-text body.

### 2.4 Replication

Every new field must join `LEARNING_STORE_KNOWN_FIELDS`
(`LearningsReplicatedStore.ts:154-163`) or it is stripped on replication — a
learning would sync between machines with its remedy silently removed, which
is a worse failure than not having the field. `remedy` is an object, so the
receive-side clamp needs a shape check (`action` string, `assumes` array of
strings, both length-bounded) consistent with how `source` is already clamped.

## 3. What this deliberately does not do

- **It does not adjudicate whether a remedy is stale.** It records the
  conditions and leaves the check to the reader. (Signal vs Authority.)
- **It does not rewrite the 20 existing learnings.** All fields are optional;
  a learning with no `remedy` behaves exactly as today.
- **It does not gate `/learn` on the new fields.** Requiring `diagnosis` and
  `remedy` on every capture would make the cheapest useful act — writing
  something down — expensive, and the result would be fewer learnings, not
  better ones. The only refusal is the narrow one in §2.1: a remedy present
  without its assumptions.

## 4. Rollback

Single-revert on the type + route + clamp change. Fields are optional and
additive, so reverting leaves existing records valid; any `remedy`/`supersededBy`
already written becomes an unknown field, which the replication clamp already
strips safely rather than erroring.

## 5. Test plan (Testing Integrity Standard — all three tiers)

**Tier 1 — unit:**
- a learning with no new fields round-trips byte-identically (the 20-row case)
- `remedy` with a non-empty `assumes` is accepted
- `remedy` with `assumes: []` / missing / non-array is **refused**
- `supersede` sets `supersededBy` and flips `applied` to false
- `supersede` with an unknown target id 404s and mutates nothing
- superseding an already-superseded learning is idempotent, not an error
- replication clamp: `remedy` survives a round-trip; a malformed `remedy`
  (non-string `action`, non-array `assumes`) is stripped, not stored

**Tier 2 — integration:** `POST /evolution/learnings/:id/supersede` over the
full HTTP pipeline; `PATCH .../apply` unchanged for learnings without a remedy;
the 503 path when evolution is unconfigured is unchanged.

**Tier 3 — E2E:** through the production initialization path, create a learning
carrying a remedy, supersede it, and assert `GET /evolution/learnings` returns
`applied: false` with the pointer set — the "is the feature actually alive"
test.

**Semantic correctness — both sides of the boundary:** the refusal test for
`assumes: []` is the one that matters. Without it the field is optional in
practice and the mechanism is decorative.

## 6. Live case to verify against

LRN-015 (`applied: true`, no `supersededBy`) and LRN-019 (which refutes its
remedy) are both in the registry now. After implementation, LRN-015 should
carry `supersededBy: "LRN-019"` and `applied: false`, and its remedy should
carry the four conditions named in §2.1. If LRN-015 still reads `applied: true`
with no pointer, the route exists but nothing consumed it — a producer-side
claim, which is the failure this spec's sibling (EVO-009) exists to catch.
