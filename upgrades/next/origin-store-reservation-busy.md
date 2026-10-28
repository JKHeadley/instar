# A locked-out Telegram recovery reservation answers "not reserved"

## What Changed

- `OriginStoreBackend.reserveRecoveryAttempt` returns false when SQLite refuses its write lock (`SQLITE_BUSY`), instead of throwing `database is locked`. The refusal happens before any write, so nothing is spent and the operation is retried on a later pass.

## What to Tell Your User

Nothing to do. One kind of warning in the agent's own log goes away, and message retries behave exactly as before.

## Summary of New Capabilities

- None; a reliability fix.

## Evidence

New test holding the write lock from another connection fails on main with "database is locked" and passes with the change; the CI-flaky race test passes 15/15 under extra CPU load; telegram-origin unit tests 369 passed.
