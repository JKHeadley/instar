# Side-Effects Review — feedback drain file identity drops st_dev

**Version / slug:** `feedback-drain-identity`
**Date:** `2026-09-30`
**Author:** `echo`
**Second-pass reviewer:** `not required (one pure comparison function; checksum + epoch checks untouched)`

## Summary of the change

`FeedbackDrainStore.sqliteFileIdentity()` recorded `dev:ino:birthtimeMs`. macOS APFS renumbers
`st_dev` across reboots/remounts. Live on the Mac Studio the checkpoint held
`16777231:454176:1787103639952.4048` while the untouched file now stats as dev `16777232`, same
inode and birth time. `restorePending()` saw a different identity, the checksum and epoch matched,
so it returned `true`: the drain refused every tick and checkpoint (274 reports waiting) and the
only exit was the PIN-gated failover-finalize route — a false operator escalation.

Change: identity is now `ino:birthtimeMs`. New exported pure helper `sameSqliteFileIdentity(recorded, current)`
compares a legacy three-part identity on its `ino:birthtime` parts. Both comparison sites
(`restorePending()` and `finalizeRestore()`) use it. Checksum and epoch checks are unchanged.

## Decision-point inventory

- Is the DB file the checkpointed one? — **modify** — compare on inode + birth time only.

## 1. Over-block

Less than before: a reboot or remount no longer makes the drain refuse work.

## 2. Under-block

A replacement file that keeps the same inode AND the same birth time would pass. A restore by copy
or rename produces a new inode and a new birth time (tested). The previous form had the same
exposure for same-device replacements; st_dev only added detection for a cross-volume move with a
colliding inode and birth time, which is not credible. On filesystems without birth time
(`birthtimeMs` 0) identity falls to the inode alone, the same as before within one device.

## 3. Level-of-abstraction fit

The fix lives in the one function that defines identity; no caller changes.

## 4. Signal vs authority compliance

Unchanged: restore detection still blocks via `DrainConflictError`/restorePending, with the same
checksum and epoch authority.

## 5. Interactions

`finalizeRestore()` requires the identity to DIFFER from the checkpoint; it now uses the same
comparison, so a same-file finalize is still refused and a genuine restore still finalizes
(existing destructive-restore test passes).

## 6. External surfaces

None. `/feedback-factory/drain/status` output shape unchanged; the stuck drain reports
`restorePending:false` after the update.

## 7. Multi-machine posture

Per-machine file identity; not replicated. No change.

## 7b. Constitutional Rules touched

Durable intake floor: restores the drain's intake without weakening restore detection.
Occam (Rule 116): one comparison helper, no new state or options.

## 8. Rollback cost

Release revert. Checkpoints written in the two-part form read as "different" to the old code,
which reproduces today's escalation, no data loss.

## Conclusion

Safe to ship. Tests: unit (st_dev change on the same file → not restored; replaced file → still
restored, new and legacy formats), integration backup-restore and e2e drain lifecycle all green.

## Evidence pointers

- `tests/unit/feedback-drain-store.test.ts` — new identity tests; the st_dev tests fail on the old code.
