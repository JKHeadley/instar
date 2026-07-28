<!-- bump: patch -->

## What Changed

The `analysis-paralysis-guard` hook was installed by the update path but not by fresh init, so
existing agents would have received it and newly-created agents never would — silently, with nothing
failing.

`installHooks()` now writes it too, from the same `getHookContent()` source as the migrator, so the two
paths cannot drift.

## What to Tell Your User

Nothing — this repairs the hook's install coverage before it ships.

## Summary of New Capabilities

None. It makes the guard reach new agents as well as updated ones.

## Evidence

- `tests/unit/migration-parity-hooks.test.ts`: 5/5 green; the parity assertion failed before with
  `Newly-unaccepted: [analysis-paralysis-guard.js]`.
- The `INSTALL_VS_MIGRATE_KNOWN_GAPS` allowlist would also have made the test pass. Not used: it exists
  for hooks that genuinely should not ship on fresh init, and this one has no such reason. Using it
  would have recorded an oversight as a deliberate decision.
