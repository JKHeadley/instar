# Side-Effects Review — Disk steward measures the npm cache it freed

## Summary of the change

`pruneNpmCache` (src/monitoring/diskSteward/pruneCategories.ts) now measures `_cacache` again after `npm cache clean` and records `bytesFreed = max(0, before - after)`, keeping npm's error when there is one. Before, a non-zero exit recorded 0 even when the clean succeeded: on 2026-11-19 at 08:06Z the cache went from 13.7 GB to 0.34 GB but was recorded as 0 (fb-eecd4dde-608). When the size afterwards is unreadable, a clean exit keeps the old answer (the planned size) and an error claims 0.

## Decision-point inventory

- **The breaker.** It counts runs freeing under 1%, and now reads the measured number. A real success no longer counts against it. No new decision point is added.

## 1. Over-block

None. Nothing is refused that wasn't before.

## 2. Under-block

When something writes to the cache while it is being cleaned, the measured number undercounts by that write. This is accepted, because the number never overstates what was freed.

## 3. Level-of-abstraction fit

The change is in the category function, the only place that knows the folder.

## 4. Signal vs authority compliance

It is a measurement feeding an existing brake. There is no new authority.

## 4b. Judgment-point check

None.

## 5. Interactions

The breaker, the audit log and the posted cleanup summary all read `bytesFreed`. Each now sees the real number. The added `sizeOf` call runs in the prune child, off the event loop, under the same budget cap.

## 6. External surfaces

The cleanup summary post shows the real freed size.

## 6b. Operator-surface quality

The number in the summary becomes correct.

## 7. Multi-machine posture

`machine-local-justification: hardware-bound-resource`. Each machine measures its own cache.

## 8. Rollback cost

Revert the commit. Only the reported numbers are affected, and no state carries over.

## Conclusion

Safe. It is a reporting fix.

## Second-pass review (if required)

Not required: no gate, kill or messaging authority changes.

## Evidence pointers

`tests/unit/diskSteward-pruneCategories.test.ts` gains 4 cases: npm fails after deleting, fails with nothing deleted, fails with the size unreadable, and exits clean with a partial clean. That file plus `diskSteward.test.ts`: 34 of 34 pass. tsc is clean.

## Class-Closure Declaration (display-only mirror)

Class: unbounded-self-action. Closure: n/a. No self-triggered action is added or changed; only the reported number is.
