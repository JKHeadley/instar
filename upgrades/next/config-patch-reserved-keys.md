# Config updates refuse keys that name JavaScript's object machinery

## What Changed

A config update over the API (`PATCH /config`) now refuses, with a plain 400, any key named `__proto__`, `prototype` or `constructor` at any depth. Such a key is never a real setting; following it during a merge changed shared program state instead of the agent's config. The deep merges used for config defaults, guard posture, dispatched config merges and secret migration also skip these keys.

## What to Tell Your User

Nothing changes: no real setting uses these names.

## Summary of New Capabilities

None. Security hardening of config updates.

## Evidence

Reproduced in the integration test: before this change a config update nesting a setting under one of these keys was accepted (200) and changed live behaviour without being saved; now it is refused (400), nothing is written, and no shared state changes.
