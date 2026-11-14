# Side-Effects Review — NCB slice 3d: answer the two unit ratchets

**Version / slug:** `ncb-3d-transcript-reads-ratchets`
**Date:** `2026-11-13`
**Author:** `echo`
**Second-pass reviewer:** `not required (no new decision point, no behavior change)`

## Summary of the change

Local Verify failed PR 3100 on two unit ratchets, both caused by the PR's own lines (main has 494 silent fallbacks and zero unqualified responses; the PR head had 496 and five).

- `src/server/routes.ts`, session transcript route catch: the 400 answer for a cursor that does not line up (`RangeError`) put `err.message` straight into the JSON. It now goes through `operatorError(err, stateDir)`, the same qualifier every other caught-exception response uses. A `RangeError` is not a storage failure, so the text is unchanged (`bad-cursor`, `row-gone`, `bad-byte-range`). The catch also carries `@silent-fallback-ok`: it is not a fallback, every failure is answered to the caller; the scanner's 20-line window reached the next route's "bearer fallback" comment.
- `src/server/routes.ts`, pool History row-continuation catch: the 502 answer used `err.message` / `String(err)` raw. It now uses `operatorError(err, stateDir)`, so a local disk/SQLite failure names this machine, and the same text is given to `asleepEntry`.
- `src/core/SessionTranscriptReader.ts`, backward scan: `catch { continue; }` on a line that does not parse as JSON (a partial write at the file's tail) is tagged `@silent-fallback-ok` with that reason, matching the existing tag on the forward read in the same file.

Neither baseline changed.

## Decision-point inventory

- None added or modified. The response text for a storage failure gains the machine name; everything else is byte-identical.

## 1. Over-block

None: no new refusal.

## 2. Under-block

None: no check removed.

## 3. Level-of-abstraction fit

Uses the existing shared qualifier (`operatorError` in `src/core/storageMachineName.ts`).

## 4. Signal vs authority compliance

No gate added; error text only.

## 5. Interactions

`asleepEntry` now receives the message without the `Error: ` prefix `String(err)` added, the same form the signed-read failure path at the transcript route already passes.

## 6. External surfaces

The 502 continuation answer's `error` text: a storage failure now names the machine. No field added or removed.

## 7. Multi-machine posture (Cross-Machine Coherence)

No change: same routes, same verbs.

## 8. Rollback cost

Revert the commit; no state, no migration.

## Conclusion

Ratchet answers with real handling, no baseline raised.
