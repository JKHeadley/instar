<!-- bump: patch -->

## What Changed

Fixes from the first live run of setup on a throwaway agent. A yes after a no can now replace a dead key that setup stored itself, and a setup session's brief now covers shared folders, disposable email addresses and closing browser windows. This only runs on a throwaway or development agent proving a recipe.

## What to Tell Your User

Nothing changes for you yet. The part where your agent sets services up itself is still being proven.

## Summary of New Capabilities

None. `POST /recommended-services/:id/key` accepts a replacement for setup's own key after a no and a new yes.

## Evidence

`tests/integration/recommended-services-setup.test.ts`: the new test fails without the fix. Live run on 2026-11-04, recorded in `upgrades/side-effects/recommended-services-proof-fixes.md`.
