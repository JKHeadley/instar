# Private Local History Exchange Support

<!-- bump: patch -->

## What Changed

Added a process-held, state-directory-shared exchange admission helper for the developing local-history intake. Competing allocations are refused before entering their callbacks, while an admitted callback retains its slot until disposal finishes. The private namespace and fixed database sidecars are excluded from file viewing, backup and synchronization. No route calls this helper yet.

## What to Tell Your User

Local Codex and Claude Code history import through the app is still in development. This supporting change does not enable an import action.

## Summary of New Capabilities

None available in the app yet.

## Evidence

Ten semantic helper cases passed, including actual process death, cross-process contention and private-path refusal. Existing key-material route checks passed21 cases; SQLite wiring passed10. TypeScript no-emit passed, and independent review found no remaining concrete issue after fixed-path protection was added. Complete feature wiring and ordinary full verification remain required.
