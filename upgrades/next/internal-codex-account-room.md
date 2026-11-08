## What Changed

Internal Codex calls (sentinels, gates, extractors) now run on the Codex account with the most room, instead of only the machine's default `~/.codex` login.
- **Primary pick.** Each call reads the subscription pool and uses the `active`, locally signed-in Codex account whose live 5-hour and weekly readings are lowest and below 100%. With no such account, it uses the default login as before. The framework and model never change.
- **Backup retry.** The sibling-account retry now skips accounts at a usage wall, skips a second slot holding the same login as the failed one, tries the roomiest first, and never retries the account the call was just given.
- **Off switch.** `intelligence.codexAccountSelection.enabled: false` keeps every call on the default login.

Fixes fb-feb1652a-948: on 2026-11-06 a walled default login on Mama PC failed every background check, though four other Codex accounts had room.

## What to Tell Your User

If you have more than one Codex account, my background checks now use whichever one has the most room left. One account running out no longer stops them.

## Summary of New Capabilities

- Internal Codex calls choose the pool account with the most room, falling back to the default login.
- The backup retry skips full accounts and duplicate logins.

## Evidence

- `tests/unit/internal-codex-account-room.test.ts`: picker, wall and reset handling, twin-login and walled-sibling exclusion, late binding, server wiring.
- `tests/integration/internal-codex-account-room.test.ts`: a real pool and a real factory-built provider run a child under the roomiest account's home, follow a new reading on the next call, and stay on the default login when switched off.
