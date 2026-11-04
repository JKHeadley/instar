<!-- bump: patch -->

## What Changed

The confirm page for saying yes to a recommended service now exists. It shows what the service involves, takes the dashboard PIN and a single-use token, and saves the yes along with the machine it authorizes. It records the approval and opens a tracked commitment for setup. No real service can reach it yet, because none has a proven setup, so nothing changes today.

## What to Tell Your User

Nothing changes for you yet. This prepares the page you'll use to say yes to a service once I've proven I can set it up.

## Summary of New Capabilities

`GET` and `POST /recommended-services/:id/confirm`, and a page at `/dashboard/service-yes`. Both answer that a service isn't available until it has a proven setup.

## Evidence

`tests/integration/recommended-services-confirm.test.ts`, `tests/integration/recommended-services-confirm-wiring.test.ts`, `tests/unit/recommended-services-ledger.test.ts`, `tests/e2e/recommended-services-alive.test.ts`. An independent review found three blocking problems, which were fixed and re-read.
