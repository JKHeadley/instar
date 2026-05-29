# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Robustness cleanup — token-ledger background scan no longer logs a
"database not open" error during shutdown.** The token-ledger's background scan
yields the event loop between files; if the ledger was closed during one of
those yields, the resumed scan tried to read the now-closed database and threw a
caught-and-logged `database connection is not open` error. Harmless (no data
loss, no crash — it only happens at shutdown) but noisy, and a latent
use-after-close. The scan now checks a liveness flag after each yield and stops
cleanly if the ledger has been closed. This completes the shutdown-safety work
started by the token-ledger boot fix.

## What to Tell Your User

Nothing changes in normal operation. This removes a spurious error line that
could appear in logs when an agent shut down mid-scan.

## Summary of New Capabilities

- Token-ledger background scan (`scanAllAsync`) bails cleanly if the ledger is
  closed mid-scan, instead of throwing a use-after-close error.

## Evidence

- `tests/unit/token-ledger.test.ts` — new regression test injects a yield that
  closes the ledger mid-scan and asserts the scan resolves without throwing.
  Verified the test FAILS without the guard (with the exact `database connection
  is not open` error) and passes with it.
- Side-effects: `upgrades/side-effects/tokenledger-scanloop-close-guard.md`.
