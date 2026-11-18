<!-- bump: patch -->
## What Changed

If the Instar app on a Mac loses the key it connected to an agent with (after a reinstall, for example), it can now connect again. `instar install --app-ticket --key <new> --replace-app-key` writes a ticket that replaces only connections this same Mac's app made. The agent removes the old key and accepts the new one in one step, and tells the person. Connections from other computers, and phones the person paired, can't be replaced this way.

## What to Tell Your User

If the Instar app on your Mac was reinstalled and can't reach an agent it created, it can now reconnect. I'll let you know when that happens.

## Summary of New Capabilities

- `instar install --app-ticket --replace-app-key`.
- `POST /mobile/local-owner-device` accepts a replace ticket and answers with `replaced`.

## Evidence

The unit tests in `tests/unit/mobile-local-owner-device.test.ts` cover the replace path, refusals that leave the owner untouched, recovery after a failure, and the person's notice. The E2E test `tests/e2e/mac-app-creates-agent-alive.test.ts` replaces the key on the production boot path, and the old key then gets 401.
