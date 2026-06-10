## What Changed

Added a structural guard for the `developmentAgent` dark-feature gate so a
dev-gated feature can no longer ship dark on development agents by hardcoding
`enabled: false` or hand-rolling the gate (the PR #1001 class of miss). A new
`resolveDevAgentGate` helper is the single funnel for the gate, and a new CI lint
(`scripts/lint-dev-agent-dark-gate.js`, run in the `lint` posture / Repo
Invariants) fails the build on a hand-rolled gate (`!!`/`Boolean(...)`/bracket
forms) outside the funnel, or a hardcoded `enabled: false` under a dev-gate marker
comment in `ConfigDefaults.ts` (brace-matched, so a long comment can't hide the
block). All 11 existing hand-rolled gate sites were migrated to the funnel —
behavior-identical, so no runtime behavior changes.

## What to Tell Your User

Nothing user-facing — this is internal developer/CI tooling (audience:
agent-only). It does not change how any feature behaves at runtime; it only stops
a specific developer mistake from recurring. No action needed.

## Summary of New Capabilities

- `resolveDevAgentGate(explicit, config)` — the canonical dev-agent dark-feature
  gate funnel (`src/core/devAgentGate.ts`).
- `lint-dev-agent-dark-gate` — CI lint enforcing the `standard_development_agent_dark_feature_gate`
  convention (joins the existing `lint-*` family).
- Honest limit: this slice does not catch a feature that omits the gate entirely
  with no marker; that is deferred to a registry + both-sides wiring test and a
  spec-intent cross-check, tracked as CMT-1253. <!-- tracked: CMT-1253 -->
