# Side-effects review — TokenLedger scanLoopAsync close guard

**Spec:** `docs/specs/TOKENLEDGER-SCANLOOP-CLOSE-GUARD-SPEC.md`
**Change:** `src/monitoring/TokenLedger.ts` (+ unit test)
**Class:** use-after-close hardening (completes the #534 shutdown-safety work).

## What changed

`scanLoopAsync()` now checks the existing `this.closed` flag after resuming from
an `await yieldFn()` — at the top of both the outer (per-directory) and inner
(per-file) loops — and returns the partial `{ filesScanned, inserted }` before
any further DB/fs work if the ledger was closed mid-scan. Two one-line guards;
no other behavior changed.

## Blast radius

- **`scanAllAsync()` callers** (the poller): unchanged in the live case — the
  guard only triggers after `close()`, which a live poller never calls mid-scan.
  The only behavioral change is during shutdown: the scan ends early and cleanly
  instead of throwing/logging a caught error.
- **`scanAll()` / `scanLoopSync()`**: untouched — synchronous, cannot interleave
  with `close()`.
- **Public API / schema / config**: none. No signatures, no DB schema, no
  options changed.

## What could break (and why it doesn't)

- **Lost scan progress?** No — the async scan is best-effort and resumes from its
  persisted cursor on the next poll of a *live* ledger. A closed ledger has no
  next tick, so there is nothing to resume.
- **Masking a legitimate in-progress scan?** No — `this.closed` is set only by
  `close()`, after which the ledger is terminal.

## Security

No new external input, network, auth, or filesystem surface. Pure liveness check
on an internal flag.

## Migration parity

Server-internal monitoring code, not an agent-installed file — no
PostUpdateMigrator entry required.

## Rollback

Revert the commit. No persisted state or schema is affected.

## Tests

Unit (`tests/unit/token-ledger.test.ts`): new close-during-scan regression test
— verified to FAIL without the guard (exact `database connection is not open`
error) and pass with it. 22 tests green; `tsc --noEmit` clean.
