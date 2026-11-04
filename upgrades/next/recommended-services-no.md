<!-- bump: patch -->

## What Changed

A person can now say no from a recommended service's confirm page, with an optional reason, and the page explains what a no does before they tap. The dashboard offers the page wherever this machine has no yes of its own, including after a later no cancelled one. Opening the page is limited to 30 times a minute. No real service can reach any of this yet, because none has a proven setup.

## What to Tell Your User

Nothing changes for you yet. This prepares the way you'll say no to a service.

## Summary of New Capabilities

`POST /recommended-services/:id/confirm` now requires `answer: yes | no`. `GET /recommended-services` adds `grantedHere`.

## Evidence

`tests/integration/recommended-services-confirm.test.ts`, `tests/integration/recommended-services-confirm-wiring.test.ts`, `tests/unit/recommended-services-catalog.test.ts`, `tests/e2e/recommended-services-alive.test.ts`. Page viewed at phone size.
