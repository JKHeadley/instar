---
title: TokenLedger async scan loop must not touch a closed DB
status: approved
review-convergence: converged
approved: true
approval-basis: >
  Completes the use-after-close hardening introduced with the #534 boot-fix
  (which added the `closed` flag for the background backfill timer). Same defect
  class, surfaced as a benign stderr during E2E teardown while shipping #534.
  Test-verified (fails without the guard with the exact runtime error) and
  changes behavior only during shutdown. Shipped under the standing
  complete-delivery directive (Justin, topic 13435); self-approved as a
  low-risk robustness completion and flagged to Justin for review.
eli16-overview: TOKENLEDGER-SCANLOOP-CLOSE-GUARD-SPEC.eli16.md
date: 2026-05-29
---

# TokenLedger async scan loop must not touch a closed DB

## Problem

`TokenLedger.scanLoopAsync()` walks the Claude Code JSONL transcript tree and
`await`s an event-loop yield (`yieldFn`) every N files so a large backfill can't
monopolise the event loop. If `close()` runs **during one of those yields**, the
resumed loop calls `ingestFile()` on a connection that is already closed, and
better-sqlite3 throws `TypeError: The database connection is not open`.

This was observed as a benign `[token-ledger] scan error: ... database
connection is not open` line during E2E test teardown (the test closes the
ledger while the poller-driven async scan is mid-flight). The scan is a
best-effort observability task, so the throw is caught upstream and logged — no
data loss, no crash — but it is noise that masks real scan errors and is a latent
use-after-close.

## Root cause

`scanLoopAsync` had no liveness check after resuming from `await yieldFn()`.
`close()` already sets a `this.closed` flag and clears the background backfill
timer (added with the #534 boot-fix), but the scan loop never consulted it.

## Design

Consult the existing `this.closed` flag inside `scanLoopAsync`, returning the
partial result (`{ filesScanned, inserted }`) before any further DB or filesystem
work whenever the ledger has been closed:

- At the top of the outer (per-directory) loop — covers a `close()` that landed
  during the directory-boundary yield, before `listJsonlFiles`.
- At the top of the inner (per-file) loop — covers a `close()` that landed during
  the per-file yield, before the next `ingestFile()`.

The synchronous scan path (`scanLoopSync`) needs no guard: it never `await`s, so
`close()` cannot interleave with it.

## Convergence notes (adversarial self-review)

- *Does returning early lose data?* No — the scan is best-effort and resumes from
  its persisted cursor on the next poll tick of a live ledger. A closed ledger
  has no next tick by definition.
- *Could the guard mask a real scan that should continue?* No — the only state
  that sets `this.closed` is `close()`. After `close()` the ledger is terminal.
- *Why not also wrap `ingestFile` in try/catch?* That would swallow the symptom
  without fixing the race; the guard removes the use-after-close at its source.

## Testing

- **Unit** (`tests/unit/token-ledger.test.ts`): a new test injects an
  `asyncYieldFn` that calls `close()` on the first yield, then `await`s
  `scanAllAsync()` and asserts it resolves without throwing and bailed before
  scanning the remaining files. Verified that the test FAILS without the guard
  (with the exact `database connection is not open` error) and passes with it —
  a genuine regression test, not a tautology.

## Migration parity

Server-internal monitoring code, not an agent-installed file — no
PostUpdateMigrator entry required. Every agent receives the fix by running the
new server build.
