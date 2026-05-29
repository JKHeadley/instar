---
title: TokenLedger scanAllAsync deterministic yield test
review-convergence: retrospective-single-pass
approved: true
eli16-overview: tokenledger-scanall-async-deterministic.eli16.md
---

# TokenLedger scanAllAsync deterministic yield test

## Problem

`TokenLedger.scanAllAsync` has a unit test that can fail locally even when run
alone. The implementation yields with `setImmediate`, but the test proves that
yield indirectly by starting a real `setInterval(..., 1)` and expecting the
interval callback to run before `scanAllAsync` resolves.

That is a timing race. On a fast machine, `scanAllAsync` can yield and complete
before the timer phase runs the interval callback. The scanner did yield; the
test simply observed the wrong event-loop signal.

## Change

Add a narrow `asyncYieldFn` option to `TokenLedgerOptions`. Production keeps the
existing behavior by defaulting to `setImmediate`. The unit test injects a
deterministic async yield function and counts how many times `scanAllAsync`
invokes it.

## Acceptance

- The `scanAllAsync` test no longer uses real timers.
- The test still proves the async path yields during the scan.
- Production behavior remains unchanged when no test hook is provided.
- The affected test passes repeatedly in local isolation.

## Side Effects

The new option is intentionally narrow and only affects `scanAllAsync`'s yield
primitive. Existing callers do not pass it, so their behavior remains the same.
