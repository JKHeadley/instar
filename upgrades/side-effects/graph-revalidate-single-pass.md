# Side-Effects Review — conversation-graph revalidation verifies once, not three times

**Version / slug:** `graph-revalidate-single-pass`
**Date:** `2026-11-18`
**Author:** `Echo (echo-graph-event-loop-blocks, topic 144559)`
**Second-pass reviewer:** `independent general-purpose subagent — concur`

## Summary of the change

Tier 1 (performance only, a revert fully undoes it). 3 source files + 1 test file, about 50 changed lines.

The Studio server's event loop stalled for 8-35 s (live log, 2026-11-17) and for 2-5 s uninterrupted on the two-machine accept-all rig. A CPU profile of the rig during a real Accept all (6 windows of 75 s, 2026-11-18 00:46-00:55Z) put `GraphSourceObservationRecoveryCoordinator.revalidate` at 34% of all busy time. `revalidate` is synchronous and verified the whole source collection three times per call: (1) `verifyHistoricalRecord` on every row to find pending rows, (2) `certifiedUnion`, which verifies every row again, and (3) `verifyHistoricalRecord` again on every union row. `validatedContinuation` calls it once per record being continued, so Accept all stacked these passes back to back. The checkpoint (`sweep`) branch also scanned every union row once per checkpoint entry with `find` and `some`, recomputing `nodeKey` each time, which is quadratic.

The change, in `src/core/ConversationGraphReplication.ts` and `src/core/ConversationGraphSourceObservationRecovery.ts`:

- `certifiedUnion` also returns `verifiedEventIds`: the accepted rows this same synchronous pass verified with `origin === packet.writerId` (exactly what `verifyHistoricalRecord` checks) and returned unchanged. A row the second loop rebuilds (this machine's own rows, possibly with a peer erasure attached) is removed from the set, because the returned object is not the verified one. Rows in the set were verified moments earlier in the same synchronous pass.
- Pass (1) tests the cheap terminal flags first, so only still-pending rows are verified. `&&` over pure predicates: the same rows enter the set.
- Pass (3) skips re-verification for rows in `verifiedEventIds`. No await separates `certifiedUnion` from the check, so the row was verified moments earlier in the same pass against the same writer.
- `sweep` indexes union rows by `sourceId` (keeping the first match, as `find` did) and keeps the highest `producerSequence` per producer machine and subject, so "a newer observation exists" is a lookup instead of a scan.

Second commit (same theme): `assertGraphSourceObservationAdmission` in `src/core/ConversationGraphSourceInventory.ts`, run once per local observation (per accepted item in Accept all), had the same shape: its pending filter verified every row before the cheap terminal flags, it deep-copied all rows twice (`recordsForRepair()` before and after `certifiedUnion`), and it re-verified matching rows the union had just verified. It now copies once (the union is synchronous and does not change stored rows, so the second copy was identical), tests flags first, and skips re-verification for ids in `union.verifiedEventIds`. In the rig profile this function was 30% of a 7 s stall.

No decision changes: every row that was verified before is still verified (once instead of up to three times), and every returned verdict is the same.

## Decision-point inventory

- `GraphSourceObservationRecoveryCoordinator.validate` / `sweep` (revalidation adopt/refuse/held) — pass-through — same inputs, same verdicts, fewer redundant verifications.
- `ConversationGraphReplication.certifiedUnion` — pass-through — same records/partial/quarantine output; one additional read-only field.

---

## 1. Over-block

No block/allow surface change. Every verdict is computed from the same predicates over the same rows. Over-block not applicable.

## 2. Under-block

The one place a skipped check could matter is pass (3): a row in `verifiedEventIds` is not re-verified. That is safe only if the returned row is the exact row verified, against its writer, with no state change in between. All three hold: the set excludes rows the second loop rebuilds; it includes only `origin === writerId`; `validate`/`sweep` are synchronous from `certifiedUnion` to the check. One nuance (from the second-pass review): `verify` is not purely a function of in-memory state. For a V2 paged materialization, `validMaterialization` reads lock/identity files and compares the native lease with `Date.now()`, so a lease expiring during the multi-second pass would previously have failed the third check and now passes. That is the same verdict reached a few milliseconds earlier in the same pass, not a new trust grant; the row was verified moments earlier against the same writer. `cloneGraphRecord` copies content and keeps the same `materialization` reference, so `verify` sees identical input. The unit test pins both sides: the peer's row (verified against `writer`) is in the set and `verifyHistoricalRecord` agrees; the writer's own rebuilt row is not in the set.

## 3. Level-of-abstraction fit

Right layer: the redundancy was inside the caller (re-verifying what the union had just verified), so the fix is in the caller plus a read-only fact from the union. A global verify-verdict cache was considered and rejected: `verify` reads mutable state (erasures, installed membership, member-loss authority) and stored rows are mutated in place in about ten places, so a cache would need invalidation at every mutation site, which is the stale-"valid" risk this change avoids.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It changes how often an existing check runs, not what it decides.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

`certifiedUnion` has 13 callers; all read the existing fields and ignore the new one (type-checks clean). Sweep "stale-heads": same result as the old `some` (exists a conversation-source-observation from the same producer machine and subject with a higher sequence ⇔ the max for that key is higher). The first-match rule of `find` is kept for the `sourceId` index.

## 6. External surfaces

None. No route, config, file format, message or log line changes. Revalidation proofs are byte-identical for the same inputs.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: an in-memory, per-call computation on each machine's own source store. Every machine runs the same code over its own copy; nothing is replicated or proxied. Status surfaces: none changed.

## 8. Rollback cost

Revert the commit and ship a patch. No state, migration or data repair: nothing is persisted.

## Conclusion

Safe to ship as Tier 1. Expected effect: one full verification pass per revalidation instead of three, and no quadratic scans in the checkpoint branch. Measured before/after on the rig is in the PR body.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (read-only), 2026-11-18 01:21Z
**Independent read of the artifact: concur**

Concur with the review. `verifyHistoricalRecord(r)` is `this.verify(r, r.packet.writerId)`; the set only takes ids with `union.value.origin === record.packet.writerId`; `cloneGraphRecord` keeps content and the `materialization` reference. The second loop either deletes a rebuilt key from the set or blocks it; dedup and lineage/missing filters only remove rows. validate and sweep are synchronous between `certifiedUnion` and the checks. Caveat adopted above: for V2 paged materializations `verify` also reads files and the clock, so "would recompute" overstated it; the accurate statement is "verified moments earlier in the same pass". Sweep rewrites are equivalent: observed entries must have an opaque `sourceId`, first-match equals `find`, `producerSequence` is a positive safe integer so max equals `some`. All 13 `certifiedUnion` callers checked; `retainedProjection` spreads the union and may filter records, so the set can name ids not in `records` there; nothing reads it there, and readers should look rows up in `records`.

## Evidence pointers

- Rig profile before (6 × 75 s, 2026-11-18 00:46-00:55Z): `revalidate` 34.1% of busy time; `certifiedUnion` 27.1%; `verify` 29.5%; uninterrupted stretches up to 5.5 s.
- Unit test: `tests/unit/conversation-graph-replication.test.ts` → "names only rows it verified against their own writer and returned unchanged as verifiedEventIds".
