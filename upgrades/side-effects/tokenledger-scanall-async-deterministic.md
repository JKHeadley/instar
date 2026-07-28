# TokenLedger scanAllAsync deterministic yield test

## Scope

This change touches `TokenLedger` and its unit test for `scanAllAsync`.

## Behavioral Change

Production behavior is unchanged by default. `scanAllAsync` still yields with
`setImmediate` when callers do not provide an override.

The new behavior is an optional constructor seam, `asyncYieldFn`, that lets
tests or specialized callers provide the async yield primitive used by
`scanAllAsync`.

## Side Effects Review

1. User-facing behavior: none expected. The server's token ledger scanner keeps
   the same default event-loop yielding behavior.
2. Data persistence: none. No database schema, ingestion format, offset, or
   summary-query behavior changes.
3. Runtime risk: low. The new option is opt-in and defaults to the previous
   implementation.
4. Signal versus authority: no new blocking or routing authority is introduced.
   The seam only changes how an async pause is performed.
5. Test quality: improved. The unit test now observes the scanner's yield call
   directly instead of depending on wall-clock timer scheduling.
6. Rollback: remove the option and restore the prior test. No migration or state
   cleanup is required.

## Verification

- Affected test passed 10 consecutive local runs.
- Full `tests/unit/token-ledger.test.ts` passed locally.
