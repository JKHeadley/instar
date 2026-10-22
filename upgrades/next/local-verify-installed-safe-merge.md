## What Changed

- **local-verify's status loop now loads safe-merge from the running server's own install** (`<package>/scripts/safe-merge.mjs`) instead of the agent-home checkout. On the first enable after release, the checkout held an older safe-merge, so the loop was never built (`GET /local-verify/status` answered 503 "no safe-merge floor").

## What to Tell Your User

Nothing changes for you: this fixes a wiring issue in the still-off "test locally instead of waiting on GitHub" work.

## Summary of New Capabilities

- None (fix to an off-by-default feature).

## Evidence

- `tests/e2e/local-verify-lifecycle.test.ts`
