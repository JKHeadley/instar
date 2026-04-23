# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`CapabilityMapper.classify()` now correctly labels agent-local capabilities (skills, scripts, jobs, context segments, custom hooks) that are NOT in the shipped builtin manifest and NOT linked to an evolution proposal as `user` provenance, instead of leaving them as `unknown`. The `Provenance` type has always declared `user` as a first-class value, but the classifier never assigned it — so every agent's drift report over-counted "unmapped" capabilities and `userConfigured` was always zero in the summary.

Concretely, in `classify()` the final fallback checks `cap.provenance === 'unknown'` and, if so, returns the capability with `provenance: 'user'`. Non-`unknown` pre-classify provenance (e.g. the `hooks/instar/` subdir which hardcodes `instar`) is preserved untouched. The persisted `capability-manifest.json` now records `classificationReason: 'agent-local config directory'` for these entries.

On the first scan after upgrading, each agent's `drift.changed` list will show a one-time provenance transition from `unknown` → `user` for every affected capability. That's expected — it's the signal that the fix took effect. `drift.unmapped` shrinks accordingly; `summary.userConfigured` populates correctly.

No schema change, no API surface change, no migration required.

## What to Tell Your User

- **Cleaner drift reports**: "I stopped flagging my own config as mystery items. The capability map now recognizes what you and I set up together as user-authored."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Accurate user-provenance classification | Automatic on next `capability-map` scan |

## Evidence

Reproduction: on an agent running pre-fix, call the capability-map drift endpoint. The `unmapped` list contains every agent-local skill/script/job/context segment that isn't in the builtin manifest (~100+ entries on a mature agent). `summary.userConfigured` reads 0 even when the agent has many user-authored capabilities.

After upgrading and running one scan: those entries move out of `unmapped` and into the `user`-provenance tally. `drift.changed` shows the one-time transition for each affected capability.

Unit-level verification: `tests/unit/capability-mapper-advanced.test.ts` "classifies unmatched agent-local capabilities as user (not unmapped)" asserts both that a mystery skill is NOT in `drift.unmapped` and that its `provenance` on the capability map equals `'user'`. All 208 tests across the three capability-mapper test files pass.

Reporter: `cluster-capability-map-has-104-unmapped-capabilities` (2 reports, governance=implement).
