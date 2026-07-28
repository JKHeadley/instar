# Side-Effects Review: P0 hook-trust core (parse + idempotency)

## Change
New pure-function module `src/core/codexHookTrust.ts` + unit tests — the testable
foundation of P0 (Codex hook auto-arming), per the approved+converged master spec
(`docs/specs/codex-full-parity-fixes.md`, P0 / G2 verdict):

- `parseCodexHookTrust(configTomlBody, hooksJsonPath)` — line-based parse of the
  `[hooks.state]` entries that belong to a specific project hooks.json path (no TOML dep,
  matching instar's deliberate no-TOML-parser stance). Returns per-slot trusted_hash + enabled.
- `codexHooksArmingStatus(...)` — F2 idempotency: which of the agent's project hooks are
  still untrusted vs explicitly disabled (so the arming step is skippable when already armed,
  and never silently re-enables a user-disabled hook — F3).
- `expectedHookSlots(hooks)` — derives `<state_event>:<group>:<idx>` slots from a Codex
  hooks.json config (the shape buildInstarCodexHookGroups produces), with the event→state-key
  lowercase/snake_case map Codex uses.

## Why
P0's G2 verdict (spec §P0): per-agent scoping comes from trust entries being keyed by the
project hooks.json PATH, so instar arms only its own project hooks. This module is the
read/verify half — it lets the arming step be idempotent (skip a TUI spawn when already
trusted) and lets a post-arm readback confirm trust actually took (F2). Pure functions, fully
unit-testable; the fragile spawn/keystroke driver is a separate later module (codexHookArm).

## Scope / blast radius
- Pure, side-effect-free parsing. Not yet wired into any call path (building block). No runtime
  behavior change until the arming driver + wiring land. No migration impact (new code, ships
  with dist).

## Signal vs Authority / Over-block
- N/A — read/verify only; no gating, no authority.

## Rollback
- Delete the module + test. Nothing references it yet.

## Tests
- `tests/unit/codexHookTrust.test.ts`: 8 tests — path-scoped parsing, enabled default-true +
  explicit-false, arming-status (untrusted/disabled/allArmed), fresh-agent = fully untrusted,
  slot derivation. Green. tsc clean. Sample config mirrors the real codey [hooks.state] shape.

## Publish
- Feature branch `echo/codex-parity-audit` (rebased onto JKHeadley/main before PR). Part of the
  P0 bundle, which ships atomic with P1 (spec §7 B2).
