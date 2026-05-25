---
slug: cwa-unify-stores
title: Unify the working-awareness stores under one ranked read path
author: echo
project: continuous-working-awareness
status: approved
review-convergence: "2026-05-25T08:48:00Z"
review-iterations: 1
review-note: "Claude-authored + manual standards/lessons self-review (single angle). Full /spec-converge + /crossreview multi-model convergence NOT run — tooling absent on this host. Ratified by Justin 2026-05-25 with that caveat explicit; this is the most architectural rung — fuller multi-model review especially advisable before/with merge."
approved: true
approved-by: justin
eli16-overview: cwa-unify-stores.eli16.md
---

# Unify the Working-Awareness Stores (rung 2)

## Problem statement

Rungs 0–1 fill the topic-intent store from live conversation (facts/decisions +
task frame). But that's now *another* island of agent memory alongside the
others:

- **Playbook** — a manifest of tagged, trigger-gated context items with their own
  usefulness/decay lifecycle (`instar playbook`).
- **Semantic / Episodic memory** — entity + episode stores with embeddings, vector
  search, and digests (`src/memory/`).
- **Topic-intent** — per-topic refs with a confidence/decay/tier model (rungs 0–1).

Each has its own read path, its own ranking, its own decay. So "what context is
relevant right now?" has *three different answers from three different doors* —
and nothing reconciles them into one ranked set. That's the fragmentation the
North Star (`docs/NORTH-STAR.md`) names as the real problem: *"a dozen
single-purpose watchers with private state, no shared working set."* Rung 2 gives
them **one ranked, decaying working set with one read path.**

## The key reframing (and the central decision)

There is already a partial unifier: **`WorkingMemoryAssembler`** — a
token-budgeted assembler that queries SemanticMemory + EpisodicMemory + others and
returns "right context, right amount, right moment" with per-source budgets and a
tiered render strategy (top-N full / next-N compact / rest name-only).

So rung 2 is **NOT** "migrate three stores into one database" (a massive, risky,
low-reward data migration). It is **"make the assembler the single unified READ
path"**: add topic-intent and Playbook as assembly *sources*, normalize every
source's relevance + recency into one ranking under the existing token budget, so
one assembled context draws from all of them consistently. The stores keep their
specialized write paths and backends; the **read** is unified.

**Decision flagged for ratification (A) — the architecture fork.** Recommended:
**unify the read path** (extend `WorkingMemoryAssembler`), leaving storage as-is.
Alternative: build a new physical unified store and migrate. Recommendation is
strongly the former — it delivers the North Star's "one ranked working set, one
read path" with additive, reversible change and no data migration, and it's
honest about what these stores are (specialized backends, not interchangeable rows).

## Proposed design

### 1. A common ranked-item shape (the lingua franca)

Define a normalized `WorkingSetItem` the assembler ranks across sources:
`{ source, id, text, relevance (0–1), recencyAt, kind, originRef }`. Each source
adapts its native model into it:

- **topic-intent** → refs at/above a tier; `relevance` from the confidence
  projection, `recencyAt` from `lastReinforcedAt`. (Decay already lives in the
  projection — rungs 0–1.)
- **Playbook** → items matching the session triggers/tags; `relevance` from the
  item's usefulness score, `recencyAt` from its last-used timestamp.
- **semantic/episodic** → the assembler's existing scored entities/digests,
  wrapped in the same shape (no behavior change — just the adapter).

### 2. One ranking + one decay posture

The assembler ranks the merged `WorkingSetItem[]` by a blended score
(relevance × a recency-decay factor), then applies the existing token budget +
render tiers. Decay is **demotion not deletion** (the rung-0 posture, now applied
across sources): a faded item drops out of the hot assembled set but remains in
its backing store and re-warms on reference. Per-source decay half-lives are
respected (topic-intent's per-kind horizons; Playbook's lifecycle) — the assembler
normalizes them into one recency factor, it does not override them.

### 3. One read path, additively

`WorkingMemoryAssembler.assemble()` gains topic-intent + Playbook sources behind
per-source token budgets (so adding them can't starve existing sources — budgets
are additive with sane defaults). Callers that already use the assembler get the
richer set for free; the individual stores' direct reads remain for their
specialized callers (briefing, ArcCheck, `playbook list`). **No read path is
removed** — the assembler becomes the *unified* one, not the *only* one.

### 4. Signal vs. authority, near-silent, observability

- The assembler **signals** a ranked set; it has no blocking authority (it informs
  context, doesn't gate). Consistent with the whole North Star.
- Observability (per the Observability article): meter what each source
  contributes to assembled contexts (items offered / included / dropped-by-budget,
  per source) so we can SEE whether unification actually improves the mix and tune
  budgets from data.
- No new per-turn cost: assembly already runs at session-start/compaction; adding
  sources is more ranking, not more LLM calls.

## Non-goals (tracked, not silent)

- **Physical store merge / data migration** — explicitly rejected for v1
  <!-- tracked: cwa-physical-store-merge --> (the read-path unification supersedes
  the need; revisit only if a concrete backend reason emerges).
- **The Usher / mid-task re-surfacing** is rung 4 <!-- tracked: cwa-usher -->; this
  spec unifies the session-start/compaction read, not continuous mid-task injection.
- **Capability + standards descriptors as sources** (rung-3 inward facet) ride a
  follow-up <!-- tracked: cwa-capability-index-context --> once the lingua-franca
  shape exists (this spec makes that cheap later).

## Lessons carried (manual lessons-grep)

- **No greenfield / build on what exists**: extend the assembler, don't reinvent —
  the North Star explicitly says "not greenfield; generalizes a pattern we already
  prototyped."
- **Signal vs. authority**, **near-silent**, **Observability**, **framework-agnostic**
  (pure ranking, no engine coupling), **migration parity** (additive sources +
  budgets; no store schema change), **testing integrity** (3 tiers + the
  no-regression pin that existing assembler output is unchanged when the new
  sources are empty).
- **Best-effort / degrade-safe**: a source that errors or is absent contributes
  nothing and never breaks assembly (each source adapter is wrapped).

## Testing (all three tiers)

- **Tier 1 (unit):** each source adapter maps its native model → `WorkingSetItem`
  correctly; the blended ranking orders a mixed set sanely; per-source budget caps
  hold; an empty/erroring source is skipped (degrade-safe); **regression pin** —
  with topic-intent + Playbook sources empty, assembled output is identical to
  today's.
- **Tier 2 (integration):** the assembler endpoint returns a context that includes
  items from topic-intent + Playbook + semantic, correctly budgeted; observability
  counts per-source contribution.
- **Tier 3 (e2e):** boot the real path; populate a topic-intent ref + a Playbook
  item + a semantic entity; assemble; confirm one ranked context draws from all
  three under budget — the unified read path, alive.

## Acceptance criteria

1. `WorkingMemoryAssembler` produces one ranked context drawing from topic-intent,
   Playbook, and semantic/episodic, under a token budget — verified e2e.
2. Each source's native decay/recency is respected (not overridden) in the blend.
3. With the new sources empty, assembled output is byte-for-byte today's
   (regression pin) — additive, no behavior change for existing callers.
4. A failing/absent source contributes nothing and never breaks assembly.
5. Per-source contribution is metered (offered / included / dropped).
6. No store schema migration; the individual read paths still work.
7. All three tiers green; tsc + lint clean.

## Risk and rollback

Medium — it touches the shared assembler, but additively and behind per-source
budgets, with a regression pin guaranteeing unchanged output when the new sources
are empty. Worst case on a bug: a sub-optimal mix in an assembled context (a
quality issue, never a delivery/data-loss issue). Rollback: drop the new source
adapters; the assembler returns to its current sources. No data migration to undo.

## Migration parity

Additive assembler sources + per-source token-budget defaults (existence-checked)
+ observability counters. Server-side (every agent gets it on update). No store
schema change, no hook/template/skill change.

## Open decisions for ratification

- **(A)** Unify the READ path via `WorkingMemoryAssembler` (recommended) vs. a new
  physical unified store + migration. *This is the load-bearing decision.*
- **(B)** The blended-score formula (relevance × recency-decay) and default
  per-source token budgets — starting points, tunable via the observability
  counters.
- **(C)** Whether Playbook's trigger/tag gating stays Playbook-internal (assembler
  consumes the already-filtered set — recommended) or moves into the assembler.

## Convergence note (honest)

Claude-authored draft + manual standards/lessons self-review; full `/spec-converge`
+ `/crossreview` multi-model tooling is absent on this host
(`[[feedback_external_crossmodel_catches_what_internal_misses]]`). This is the
largest, most architectural rung so far — ratification here = "this read-path-unification
direction is right, build it," and a fuller multi-model review is especially
worth doing before the code merges given the blast radius touches the shared
assembler.
