# Side-Effects Review — one verified read view per graph read

**Version / slug:** `graph-read-view-pin`
**Date:** `2026-11-18`
**Author:** `Echo (echo-graph-event-loop-blocks, topic 144559)`
**Second-pass reviewer:** `not required (read path only, no decision point)`

## Summary of the change

Tier 1 (performance; a revert fully undoes it). 3 source files, 2 test files.

A CPU profile of the accept-all rig during a real Accept all (2026-11-18 01:44-01:52Z) showed 25-28 s uninterrupted stalls, 87% of one inside a single `GET /conversation-graph/nodes/:ref`: `GraphProjection` → `effortTitle` → `EffortHeaderStore.titleOf` → `ConversationGraphHeaderCustody` → `runtime.retainedForRead()` → `readView()` → full rebuild (`certifiedUnion` + source inventory, decrypting every payload). `readView` caches only while its key is stable, and `readViewMarker()` returns null while any write is in flight, which during Accept all is nearly always. So one read rebuilt the whole verified view once in `readiness()` and again for every effort title on the page.

The change:
- `ConversationGraphReplicationRuntime.withPinnedReadView(fn)`: builds (or reuses) the view once, pins it, runs `fn`, clears the pin in `finally`. `readView()` returns the pinned view while pinned. Nested calls run unpinned-inside-pinned (reuse the outer pin). If the view cannot be built, `fn` runs unpinned and meets the same refusal itself.
- `ConversationGraphRuntimeReadSource.scoped(fn)` calls it; `GraphReadSource.scoped` is optional.
- `ConversationGraphReadModel`'s four entry points (`unassignedConversations`, `roots`, `node`, `destinations`) run their bodies inside `scoped`.

Effort: one commit attempt, no spec rounds.

## Decision-point inventory

No decision-point surface. Read-only: which identical verified view a read uses.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface. Freshness: every lookup inside one synchronous read call now sees the view built at that call's start instead of a view rebuilt a few milliseconds later. The entry points are synchronous (no await inside), so no write can complete between those points; the views would have been built from the same state. The one exception is clock-dependent verification of V2 paged materializations, where a lease could expire within the call; the read then shows what was valid at the start of the call, a few milliseconds old. Erasure: an erasure cannot complete inside a synchronous call, and the pin never outlives the call.

## 3. Level-of-abstraction fit

Right layer: the read model owns "one read request"; the runtime owns the view. Write paths are untouched (they call `retainedProjection`/`inventory` directly and never read the pin).

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

The existing read-view cache (15 s, key-checked) is unchanged and still answers first when its key is stable. `ConversationGraphOwnerChanges` (line 173) still calls `retainedForRead()` unpinned; behaviour unchanged there. If `fn` ever returned a promise, the pin would end at that return and the asynchronous part would read unpinned, as today.

## 6. External surfaces

None. Same responses; faster under writes.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: an in-memory per-call reuse of each machine's own verified view. No status surfaces changed.

## 8. Rollback cost

Revert and ship a patch. No state.

## Conclusion

Ship as Tier 1.

## Evidence pointers

- Rig profile after PR 3341 (`after-2.cpuprofile`, 2026-11-18 01:36Z run): 27.9 s stretch, 87% under `readView` via `effortTitle`.
- Tests: `tests/unit/conversation-graph-read.test.ts` (every entry point, readiness and titles included, runs inside the source scope; 24 passed); `tests/integration/conversation-graph-read-view-cache.test.ts` new case (with the view key forced null, three lookups inside one pinned call build one union; the pin ends with the call, also on throw) — runs in Local Verify.
