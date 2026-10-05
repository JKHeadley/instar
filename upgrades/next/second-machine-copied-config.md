# A second machine no longer goes silent because of state copied from the first

## What Changed

Fixes the blocker in instar#2122, found while bringing Luna up on a second machine.

- **Copied Claude path** (`src/core/Config.ts` → `resolveConfiguredClaudePath`). `sessions.claudePath` that provably does not exist on this machine is replaced by the detected Claude binary, with a warning naming both paths; with none detected the configured value is kept. Previously it was used verbatim, every Claude session died at spawn, and each death revoked the session's Telegram sending credential (`invalid-origin-token`). An existing path, a bare command name, or an unprobeable path is kept as configured — the rule `sessions.frameworkBinaryPaths` already follows.
- **Half-revoked machine entries** (`src/core/MachineIdentity.ts` → `isRegistryEntryActive`). A registry entry is active only with `status: 'active'` and no `revokedAt`. Used by the active-machine list, awake lookup, nickname lookup, `instar machine` views, the passkey cell-state check and the origin pool audit. A removed identity whose endpoints were this machine's own no longer receives this machine's cross-machine calls (`wrong-recipient`).

## What to Tell Your User

If you add a second machine by copying settings from the first, I no longer go silent on the new machine when my settings name a Claude program that only exists on the old one — I find the right one and note the mismatch. A machine you removed also stays removed, even if an old copy of the machine list still calls it active.

## Summary of New Capabilities

- A copied `sessions.claudePath` that is missing on this machine falls back to the detected Claude program, with a boot warning.
- A machine-list entry carrying a removal date is always treated as removed.

## Evidence

- Luna's Mac Studio log: 34 sessions "died during startup" while `sessions.claudePath` was `/opt/homebrew/bin/claude` (absent on the Studio); none after it was corrected by hand. Continuous `[mesh-rpc] rejected telegram-origin from <self>: wrong-recipient` from a registry entry with `revokedAt` set and `status: 'active'`.
- `tests/unit/second-machine-copied-config.test.ts` (8 tests), `tests/unit/Config.test.ts`, `tests/unit/machine-identity.test.ts` and 165 related unit files pass.
