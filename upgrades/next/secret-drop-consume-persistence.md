<!-- bump: patch -->
## What Changed

Consuming a submitted secret now removes its existing encrypted copy even if Secret Drop persistence was switched off after submission. Storage failures keep the submission retryable; a submission that was never stored does not create a vault or key during consumption.

## What to Tell Your User

A secret that has been used and cleared will no longer reappear after secure storage is switched back on and the agent restarts. You do not need to change any settings.

## Summary of New Capabilities

None. This repairs the existing behavior for clearing a consumed secret.

## Evidence

Five storage unit tests, thirteen HTTP route tests and three production-server lifecycle tests passed. The policy-toggle restart regression failed before the repair and passed afterward. Build, TypeScript and all 55 commit lints passed. Independent source/test/side-effects review concurred; full verification remains pending through the shared verifier. Review: `upgrades/side-effects/secret-drop-consume-persistence.md`.
