# Upgrade Guide — v1.0.3

<!-- bump: patch -->

## What Changed

Lands the second Layer-3 functional primitive parity rule: Hook. Follows the Skill prototype's template (canonical-source-of-truth + per-framework rendering + parity rule that keeps them in sync), with hook-specific details (event vocabulary, script executable contract, settings.json/hooks.json merge semantics).

v0.1 covers the `session-start` event only. Remaining events are documented in the canonical vocabulary but not yet rendered; extension is mechanical (one entry in the EVENT_NAME_MAPPING table per event).

Reuses all of the Skill prototype's hardening: strict slug grammar at every entry point, x-instar-stamp distinguishing user-edits from canonical drift, symmetric verify with orphan detection, remediate refuses on user-edit-conflict. Hook-specific additions: leading-comment stamp format (`# x-instar-stamp: <sha256>`), executable-bit on render (chmod +x), settings.json hook-table merge that preserves non-Instar entries, hooks.json hook-array merge with the same property.

Concept spec at `specs/instar-concepts/hook.md` (converged + approved); per-framework specs at `specs/frameworks/claude-code/hooks.md` and `specs/frameworks/codex-cli/hooks.md`.

## What to Tell Your User

- "Hooks (small scripts that fire automatically on lifecycle events like session-start) now have the same canonical-source-and-rendering pattern that skills do. Currently the parity rule covers session-start; the other events follow the same shape and land mechanically."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Hook parity rule (programmatic) | Available via the parity registry — `getParityRule('hook')`. No automatic run yet (sentinel is a separate follow-up). |
