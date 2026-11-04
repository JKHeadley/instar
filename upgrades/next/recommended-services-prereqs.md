<!-- bump: patch -->

## What Changed

Groundwork for recommended services, with no offers sent. The door and Tailscale setup steps moved out of the install command so the server can run them later. New agents are marked ready for offers when created, and existing agents wait until their own first list ships. Agents also note the first reply Telegram or Slack accepted. The recommended services route reports both values.

## What to Tell Your User

Nothing changes for you yet. This prepares your agent to recommend helpful services later.

## Summary of New Capabilities

No new capabilities. `GET /recommended-services` now reports `migrationComplete` and `firstResult`.

## Evidence

`tests/unit/offer-prerequisites.test.ts`, `tests/unit/install-door-steps.test.ts`, `tests/unit/install-flow.test.ts`, `tests/integration/first-result-wiring.test.ts`, `tests/integration/recommended-services-routes.test.ts`, `tests/integration/install-agent-init.test.ts`, `tests/e2e/recommended-services-alive.test.ts`. The wiring test fails when the Telegram hook is removed.
