# Feedback drain no longer treats a macOS reboot as a restored backup

## What Changed

The operated feedback drain fingerprints its SQLite file so it can tell a
routine restart from a database restored out of a snapshot. The fingerprint
was `st_dev:inode:birthtime`. macOS APFS renumbers `st_dev` across reboots and
remounts, so an untouched database looked "restored": `restorePending()`
returned true, the drain refused every tick and checkpoint, and the only way
out was the PIN-gated failover-finalize route. On the Mac Studio 274 feedback
reports were stuck this way.

The fingerprint is now `inode:birthtime`. Checkpoints written in the old
three-part form are compared on their inode and birth-time parts, so an
already-stuck drain recovers on its next check after the update with no
operator step. The checksum and owner-epoch checks are unchanged, and a
genuinely replaced file (new inode and birth time) is still detected.

## Evidence

- `tests/unit/feedback-drain-store.test.ts`: a legacy checkpoint whose
  `st_dev` differs on the same file is not a restore; a new checkpoint carries
  no `st_dev`; a file replaced from a snapshot is still detected with both the
  new and the legacy checkpoint form. The `st_dev` tests fail on the old code.
- `tests/integration/feedback-drain-backup-restore.test.ts` and
  `tests/e2e/feedback-factory-drain-lifecycle.test.ts` stay green.

## What to Tell Your User

Nothing to do. If feedback processing had stalled after a Mac restart, it
resumes on its own after this update.

## Summary of New Capabilities

- None — a reliability fix to the feedback drain's restore detection.
