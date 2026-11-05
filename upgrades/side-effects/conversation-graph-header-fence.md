# Side-Effects Review — local erasure fence and admission check for effort headers

**Version / slug:** `conversation-graph-header-fence`
**Date:** `2026-11-05`
**Author:** `Dawn (claude-code), effort-header owner for Echo's Conversations run`
**Second-pass reviewer:** `independent verifier (claude-code subagent, fresh context)`

## Summary of the change

On top of ede8d9d88 (metadata-only `EffortHeaderStore`), per v3 §7.6 "immediately suppress local serving" and the runtime owner's request (Echo topic 137342, 2026-11-05):
- `suppressHeader(headerId, {kind:'owner-forget-intent', id, at})` persists a LOCAL erasure fence at once — before any witness, peer or network step. From then on `titleOf` returns null (even while custody still answers), every set is refused `erasure-pending` (including a replayed older certified set), the fence survives restart, and nothing lifts it; the certified `forget-header` later completes the erasure. `get().erasure` is `none | pending | complete`. The receipt is shape-checked only (exactly `{kind, id, at}`, identifier id, real millisecond timestamp); verifying the owner (device / PIN) is the runtime ingress's job.
- `revalidate(op)` — the strict client-side admission check for not-yet-submitted operations (exact compare-and-set, no reused opId, refused on fenced/forgotten headers; a forget is always admissible). Deliberately STRICTER than `applyCertified`, which must accept every certified operation so members converge.
- Snapshot `schemaVersion` 5 (adds the fence), so an older build refuses the file instead of ignoring and overwriting the fence. No v4→v5 migration: the store is unwired, so no v4 file exists outside tests.
- `applyCertified` / `suppressHeader` work on a private copy of the record, so a refused operation never alters the cached state.
Tests: `tests/unit/EffortHeaderStore.test.ts` (18; 88 across the four conversation-graph suites). Tier 2. Unwired.

## Decision-point inventory

- `suppressHeader` — **add** — accepts a shape-valid owner forget-intent receipt and fences the header.
- `applyCertified` — **modify** — refuses sets on a fenced header (`erasure-pending`).
- `titleOf` — **modify** — null whenever a fence or forget exists.
- `revalidate` — **add** — admission answer for the pending queue.

---

## 1. Over-block

A fenced header refuses every later set, including one the owner might want after changing their mind; §7.6 gives no un-forget, so a new title needs a new header.

## 2. Under-block

The store trusts the caller that a receipt reflects a verified owner intent; a caller that fences without verification would hide a title (fail-safe direction: suppression, never disclosure). The fence is local: other members keep serving until they receive the forget, which is §7.6's documented pending state ("Removed here · Waiting for MacBook").

## 3. Level-of-abstraction fit

Right layer: the fence lives where serving decisions are made for header text, so suppression cannot depend on network or witness availability.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface on any live path (unwired).

## 4b. Judgment-point check (Judgment Within Floors standard)

None: the fence is a fail-safe floor; the owner's verified intent is the judgment, taken at the runtime ingress.

## 5. Interactions

Consistent with ede8d9d88's rules: forget always wins; refused operations are never recorded. `revalidate` mirrors the client-facing 409 `header-version-conflict`.

## 6. External surfaces

None until wired.

## 6b. Operator-surface quality

Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: local fence by design, completed by the certified forget.** The fence is deliberately machine-local and immediate (§7.6 pending state); the certified, all-member `forget-header` makes every member converge on `complete`. machine-local-justification: operator-ratified-exception <!-- tracked: v3 §7.6 "immediately suppress local serving … completion waits for every installed member" -->

**Status surfaces:** none added or changed.

## 8. Rollback cost

Revert the commit. Unwired; no production file exists.

## Conclusion

A forget is now honoured on this machine the moment the owner's intent is accepted, independent of the network, and it cannot be undone by replay, restart or an older build.

## Second-pass review

**Reviewer:** independent-verifier (Claude Code subagent, fresh context, 2026-11-05)
**Independent read of the artifact: concur**

Round 1: concern — a refused opId-reuse set mutated the cached snapshot; an unbumped schema let an older build silently lift the fence; the `revalidate` docstring falsely claimed parity with `applyCertified`; the receipt accepted impossible dates and extra keys. All fixed with tests. Round 2: "Concur with the review" after re-running every probe (noting only that v4 files would need a migration, which no real deployment has).

## Class-Closure Declaration

- **Defect class:** `unbounded-self-action`
- **Closure:** `n/a` (negative declaration)
- **Reason:** No self-triggered action: methods applied by a caller; no timer, loop, retry, restart, spawn or notification.

## Evidence pointers

- `npx vitest run tests/unit/EffortHeaderStore.test.ts` → 18 passed (88 across the four conversation-graph suites, 3 runs).
- `npx tsc --noEmit -p .` → exit 0.
