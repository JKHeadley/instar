<!-- bump: patch -->

## What Changed

Proactive subscription-account swapping now includes a bound default-login
interactive session, filters sessions that cannot be safely respawned, and
chooses the eligible same-framework account with the lowest current usage.
Slack-only servers and disk-restored Slack bindings use the same path, and
execution failures retain their concrete refusal reason.

## What to Tell Your User

Your main conversation can now move off a nearly exhausted subscription before
it hits the wall, even when it started on the default login. If several accounts
are safe destinations, Instar picks the one with the most breathing room. Busy
work still waits rather than being interrupted.

## Summary of New Capabilities

Bound default-account conversations participate in safe proactive quota swaps
across Telegram and Slack, including Slack-only installs.

## Evidence

Focused unit, production-wiring, integration, and E2E tests cover the fresh
target and hold boundaries, stale-source refusal, unrefreshable exclusion,
structured refusal propagation, and Slack disk-binding recovery.
