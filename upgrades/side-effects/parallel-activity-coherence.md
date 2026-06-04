# Side-Effects Review — Parallel-Work Awareness, Phase A core (cross-topic index)

**Version / slug:** `parallel-activity-coherence`
**Date:** `2026-06-03`
**Author:** `Echo (instar-dev agent)`
**Tier:** `2` (new capability; converged + approved spec: docs/specs/parallel-activity-coherence.md)
**Second-pass reviewer:** `not required (the converged spec carries a 2-reviewer adversarial+integration pass that reshaped it)`

## Summary of the change
Phase A CORE of the Parallel-Work Awareness feature: `ParallelActivityIndex` — a thin
CROSS-topic read aggregator over the EXISTING Topic-Intent Layer. It does NOT add a new
per-topic store (convergence: that would duplicate `TopicIntentStore`); it only READS the
existing per-topic intent files and presents the cross-topic view ("all my topics + what
each is working on") that genuinely did not exist. Plus `extractTags` — high-specificity
token extraction (drops generic boilerplate so two "fix the test" topics don't false-match).

New:
- `src/core/ParallelActivityIndex.ts` — enumerate `{stateDir}/topic-intent/*.json`; per
  topic derive `focus` (latest goal > latest decision > purpose), `tags` (high-specificity
  tokens), `refCount`, `updatedAt`, `running`. Read-only; an injectable `getRefs` seam for
  testability (production uses the real `TopicIntentStore.getRefsAtOrAbove`).
- `tests/unit/parallel-activity-index.test.ts` — 7 tests.

Phase A is now COMPLETE: `GET /parallel-work/activities` route + CapabilityIndex entry
(`parallelWork`, prefixes `['/parallel-work']`) + server wiring (constructed in AgentServer
in its OWN try/catch, injected into routeCtx, `running` enriched from the live session list)
+ integration/e2e tests + CLAUDE.md template + migrateClaudeMd agent-awareness. The overlap
ParallelWorkSentinel is Phase B (ships dark), a separate PR.

## Decision-point inventory
- `ParallelActivityIndex` read aggregation — **add** — pure read over existing state; no
  block/allow surface, no mutation.

## 1./2. Over/Under-block
No block/allow surface. Signal-only observability over existing data.

## 3. Level-of-abstraction fit
Correct — it reads the Topic-Intent layer (the right source for "what each topic intends")
and presents a cross-topic view; it does not re-implement intent capture or storage.

## 4. Signal vs authority
**Reference:** docs/signal-vs-authority.md. [x] No block/allow surface. A read aggregator.

## 5. Interactions
- **No new store / no new write path** — reuses `TopicIntentStore` (which already has the
  structural per-turn write path via TopicIntentCapture). No duplication, no second decay engine.
- **False-positive containment starts here:** `extractTags` strips generic boilerplate +
  requires specificity (compound/identifier tokens, or rare ≥4-char words), so the Phase B
  overlap comparison rests on genuine shared entities, not coincidental generic words.
- **Robustness:** missing intent dir ⇒ empty list; a corrupt/again topic file ⇒ that topic
  contributes no refs (swallowed), never throws.

## 6. External surfaces
- (Remaining) `GET /parallel-work/activities` + CapabilityIndex classification (the #727
  lesson). No persistent state of its own (reads existing topic-intent files). Config flag
  (`monitoring.parallelWorkSentinel`) lands with the sentinel (Phase B), ships dark.

## 7. Rollback cost
Pure additive read code. Revert ⇒ gone, no state, no migration.

## Conclusion
Phase A core complete + unit-tested (7 tests, tsc clean): the cross-topic index over the
existing Topic-Intent layer + specificity-aware tag extraction. Non-duplicative (the
convergence-mandated reshape). Route + wiring + integration/e2e + agent-awareness follow on
this branch; the overlap ParallelWorkSentinel is Phase B (ships dark).

## Evidence pointers
- `tsc --noEmit` clean; `vitest run tests/unit/parallel-activity-index.test.ts` → 7/7
  (extractTags specificity boundary incl. the cpu vs cpu-sampling case; focus derivation
  goal>decision>purpose; tags; running/nickname; empty-dir ⇒ []).
