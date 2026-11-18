<!-- bump: patch -->
## What Changed

For Always available on Mac: `instar always-available token --email <account>` stores a Claude setup-token code (read from stdin) as the agent's Claude sign-in, after checking that it belongs to that account. `token-clear` puts the earlier sign-in back, and `status` reports FileVault and the code's state. The Instar app uses these behind its switch.

## What to Tell Your User

Nothing yet. This is the part that lets an agent use Claude before anyone logs in, once the Mac app's Always available switch ships.

## Summary of New Capabilities

- `instar always-available token | token-clear | status`.

## Evidence

`tests/unit/always-available-token.test.ts` (8) covers the email check, the refusals, restore after two sets, a code the person changed since staying, and FileVault from the exit code. The oracle's own tests pass (39).
