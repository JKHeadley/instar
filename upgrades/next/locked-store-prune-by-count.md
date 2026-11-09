# Upgrade Guide — locked-store-prune-by-count

## What Changed

The macOS desktop helper now prunes finished locked-screen duty records by count (newest 30 kept) as well as by age (7 days), and its `state-op read` reply applies the same trim without writing. Before this, a Mac with more than about 126 unlocks in a week grew `locked-state.json` past the server's 64,000-byte state-op read limit, and `/desktop/locked/status` answered 503 `mac-desktop-host-output-limit` until records aged out (fb-3a84590d-1e8). Owed duties and unreported relock failures are never pruned.

## What to Tell Your User

Remote desktop to a locked Mac no longer stops working after the Mac has been unlocked remotely many times in one week. Before, it could refuse for up to a week; the Mac always stayed safe and relocked.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Locked-Mac remote desktop stays available on Macs that are unlocked often | Automatic |

## Evidence

`tests/unit/desktop-helper-state-op.test.ts` ("stays readable with 200 finished duties") runs the real built helper against a 200-record store: the read returns under 64,000 bytes with the owed duty, the unreported failure and exactly the newest 30 finished records, the file is unchanged by the read, and the next `marker-create` leaves 30 finished records on disk. Run on macOS with `INSTAR_REAL_DESKTOP_HELPER_TESTS=1`: the new test passes. Original failure measured on the proof Mac: 126 records = 63,351 bytes worked, 127 failed.
