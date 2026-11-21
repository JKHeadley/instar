<!-- bump: patch -->
## What Changed

A plan's "Waiting for your OK on round N" ask now names the round when it has a name ("Waiting for your OK on round 1: Tier 1 - stop silent loss of local fixes"), in the dashboard Needs-you list, the Plans page and the phone app. A round without a name reads as before. Overview: `docs/specs/plans-ok-names-round.eli16.md`.

## What to Tell Your User

When a plan waits for your OK, the dashboard and the app now say which round and what it is about, so you can tell what you are approving without opening the plan.

## Summary of New Capabilities

- None beyond clearer wording (no new routes or settings).

## Evidence

- Unit: `tests/unit/console-plans.test.ts`, `tests/unit/mobile-native-plans-people.test.ts`. E2E: `tests/e2e/console-home-lifecycle.test.ts`. Integration: `tests/integration/mobile-native-plans-people.test.ts`.
