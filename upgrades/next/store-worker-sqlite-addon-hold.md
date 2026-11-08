## What Changed
The Telegram origin store now loads its SQLite library on the parent thread before it starts a worker, and keeps it loaded. Before, when a store worker exited (a stall restart, a replacement or a close) at a moment when no other thread held SQLite, the worker's last memory clean-up ran in code Node had just unloaded, and the whole process crashed with SIGSEGV. This is what made `store-retention.test.ts` lose 16 tests in Local Verify on several machines.

## What to Tell Your User
A rare crash in the part of me that records outgoing Telegram messages is fixed. It could happen while that part restarted itself. You don't need to do anything.

## Summary of New Capabilities
- None new: the origin store no longer risks a process crash when one of its workers exits.

## Evidence
- `tests/unit/telegram-origin/sqlite-addon-hold.test.ts`: in a fresh process, the parent holds `better_sqlite3.node` once a store opens, and 12 heavy store open/close cycles finish. Without the fix the cycle test dies with SIGSEGV (3 of 3).
- A reproduction of the store-retention heavy case crashed in 8 of 9 runs before and 0 of 6 after. The full `tests/unit/telegram-origin` folder passes (606 tests).
