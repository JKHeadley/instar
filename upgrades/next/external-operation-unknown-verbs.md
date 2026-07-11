# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The external-operation PreToolUse hook now fast-paths only explicitly read-only MCP actions. Unrecognized action verbs are classified as `modify` and sent to the existing gate for the authoritative decision instead of silently bypassing evaluation.

## What to Tell Your User

Novel or unusually named external-service actions now receive the same safety evaluation as recognized writes and modifications. Familiar read-only actions remain fast and unchanged.

## Summary of New Capabilities

- Explicit read-only verb allowlist for MCP action classification.
- Unknown verbs route to the gate as `modify` rather than inheriting read safety.
- Existing delete, write, and modify prefixes retain their established classifications.
- Fresh installs, upgrades, and Codex hook installs share the corrected canonical hook source.

## Evidence

Real generated-hook tests prove seven bypass-class verbs attempt a gate call as `modify`, four representative read verbs make zero gate calls, and delete/send/update retain their original classifications. Adjacent installer, Codex wiring, and server-side fail-safe tests pass.
