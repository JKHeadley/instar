# Upgrade Guide - vNEXT

<!-- bump: patch -->

## What Changed

The Instar CLI now rejects unknown top-level commands before the bare setup flow can run. A typo such as `instar dev:claim-checkk` prints a clear unknown-command error and exits with status 1 instead of falling into the interactive setup wizard.

Bare `instar` remains unchanged: it still opens the setup flow for new or interrupted setup sessions. `instar help` now prints CLI help instead of entering setup.

## What to Tell Your User

- **Clearer command typos**: "When I mistype an Instar command, I now fail fast with a clear message instead of opening setup and looking stuck."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unknown command rejection | Automatic for mistyped top-level Instar commands |
| Bare setup preservation | Automatic when running Instar without a command |
| Help command preservation | Automatic when asking Instar for help |

## Evidence

Reproduced the typo path locally with the built CLI. Before this change, a typoed command could enter the interactive setup path and hang an agent shell. After the change, `node dist/cli.js dev:claim-checkk` exits 1 with `error: unknown command 'dev:claim-checkk'` and the help hint. A separate `node dist/cli.js help` probe exits 0 and prints CLI help. A separate bare invocation probe, `timeout 3 node dist/cli.js`, still enters setup and times out at status 124, confirming the default setup behavior remains intact.
