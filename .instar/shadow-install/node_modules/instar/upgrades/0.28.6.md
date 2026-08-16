# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fixed a bug where `loadConfig()` silently dropped many optional config fields — including `safety`, `evolution`, `agentAutonomy`, `externalOperations`, `autonomyProfile`, `notifications`, `responseReview`, `inputGuard`, `dashboard`, and `moltbridge`. These fields were defined in `InstarConfig` and written to `config.json` by subsystems like `AutonomyProfileManager.applyProfileToConfig()`, but were never read back because `loadConfig()` constructed its return object with only explicitly listed properties.

The fix spreads `fileConfig` as the base object before applying explicit overrides, so all config fields pass through while preserving existing defaults and transformations.

**Impact**: If you had manually set `safety.level` in your config or changed autonomy profile settings, those overrides were being silently ignored — the system always fell back to profile defaults. After this update, your config file settings will be respected.

## What to Tell Your User

- **Config settings now fully respected**: "If you've customized safety levels, autonomy settings, or other advanced configuration, those settings are now properly loaded. Previously they could be silently ignored — that's fixed now."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Config passthrough fix | Automatic — all config.json fields now properly loaded |
