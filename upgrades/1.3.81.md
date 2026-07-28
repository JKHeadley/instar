# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

TokenLedger now has route-level regression coverage for the two `/tokens` 503 recovery paths. The test opens an old pre-attribution SQLite database, verifies the missing attribution column is migrated before the token summary route reads it, and asserts `/tokens/summary` returns HTTP 200 with seeded data. It also simulates a prior successful sqlite native heal from another subsystem and proves a later TokenLedger open retries successfully without starting a second rebuild.

## What to Tell Your User

I added a stronger safety check so the token summary endpoint stays alive after the two known recovery cases.

## Summary of New Capabilities

| Area | Capability |
| --- | --- |
| Token usage | Route-level regression test proves `/tokens/summary` returns data against an old TokenLedger schema. |
| Native sqlite recovery | Test coverage proves TokenLedger can open after another subsystem already completed the shared heal. |
| Release safety | Future TokenLedger changes now have an endpoint-alive guard against silent 503 regressions. |

## Evidence

- Integration: `tests/integration/tokens-503-regression.test.ts` seeds an old database without the attribution column, opens TokenLedger, and verifies the token summary route returns HTTP 200 with the seeded totals. The same file simulates a prior successful native heal, then proves TokenLedger retries open without a second rebuild and the route still returns data.
