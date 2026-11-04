<!-- bump: patch -->

## What Changed

After a confirmed yes, the agent can now start the work itself: a session in the service's own conversation, briefed to do the whole setup, with a real check that decides when it's done. A regular check stops the work after a no from any machine and restarts a session that dies, up to a limit. This only runs on a throwaway or development agent that has chosen to prove a recipe, so nothing changes on other agents.

## What to Tell Your User

Nothing changes for you yet. This is the part where your agent does the setup itself, and it's still being proven.

## Summary of New Capabilities

`POST /recommended-services/:id/verify` and `POST /recommended-services/:id/key`, both answering `no-recipe` unless this agent is proving one. `GET /recommended-services` adds `verified`, `alreadyHeld` and `stalled`.

## Evidence

`tests/integration/recommended-services-setup.test.ts`, `tests/integration/recommended-services-confirm-wiring.test.ts`, `tests/unit/self-action-convergence.test.ts`, `tests/e2e/recommended-services-alive.test.ts`. Not yet proven with a real session or a real TypeSafe account.
