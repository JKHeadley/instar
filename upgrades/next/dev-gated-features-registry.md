## What Changed

Added Slice 2 of the dev-agent dark-gate conformance guard: a
`DEV_GATED_FEATURES` registry (`src/core/devGatedFeatures.ts`) and a both-sides
wiring test that applies the REAL config defaults and asserts each registered
dev-gated feature resolves LIVE under a `developmentAgent: true` config and DARK
under a fleet config. This catches the half of the #1001 bug that Slice 1's lint
can't see — a feature whose shipped default hardcodes `enabled: false` (so
`applyDefaults` injects it) now fails the build, because the feature would be dark
on dev agents. Seven features are registered; two (`mcpProcessReaper`,
`resourceLedger`) are deliberately excluded with documented reasons (intentionally
not dark-on-fleet).

## What to Tell Your User

Nothing user-facing — internal developer/CI tooling (audience: agent-only). No
runtime behavior changes; it only adds a test that guards the dev-gate convention.

## Summary of New Capabilities

- `DEV_GATED_FEATURES` registry + `getConfigByPath` (`src/core/devGatedFeatures.ts`).
- `tests/unit/devGatedFeatures-wiring.test.ts` — both-sides wiring test (+ a teeth
  test proving it catches a planted `enabled: false` regression).
- Honest limit: Slice 3 (spec-intent cross-check) still catches the
  forgot-the-gate-entirely case; tracked as CMT-1253. <!-- tracked: CMT-1253 -->
