---
name: hook_parity_rule
description: Hook parity rule — canonical-source and rendering for lifecycle hooks (v1.0.3+)
metadata:
  type: capability
  version: "1.0.3"
  status: available
---

# Hook Parity Rule (v1.0.3+)

Hooks (small scripts that fire automatically on lifecycle events like session-start) now have the same canonical-source-and-rendering pattern that skills do.

## What This Means

- Hooks can be defined in a canonical location and rendered per-framework
- The parity rule keeps hook definitions in sync across frameworks
- Currently covers `session-start` event (only); other events use the same shape mechanically
- Same hardening as Skill: strict slug grammar, x-instar-stamp marking, orphan detection, edit-conflict remediate

## How to Use

- Programmatically: `getParityRule('hook')` via the parity registry
- Concept spec: `specs/instar-concepts/hook.md`
- Framework specs: `specs/frameworks/claude-code/hooks.md`, `specs/frameworks/codex-cli/hooks.md`

## Key Implementation Details

- Hook scripts render with executable bit (`chmod +x`)
- Leading-comment stamp format: `# x-instar-stamp: <sha256>`
- Settings.json hook-table merge preserves non-Instar entries
- hooks.json hook-array merge with same property preservation

## Status

v0.1 covers session-start only. Remaining events documented but not yet rendered. Extension is mechanical (one entry in EVENT_NAME_MAPPING per event).
