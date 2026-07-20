# Stop-gate authority breaker survives routine restarts

## What Changed

The Unjustified Stop Gate now persists its provider-failure breaker in the existing local Stop-gate database. Routine releases no longer reset a known-slow authority path and manufacture another timeout-feedback budget. Half-open recovery admits one bounded probe, semantic-invalid output advances the same breaker, and stale route rows are pruned after 30 days.

`instar gate status` now shows breaker health and the next automatic probe, while the authenticated `instar gate reset-breaker` action admits an immediate probe after provider repair. The No Unbounded Loops standard and shared self-action ratchet now require restart-survival proof whenever the triggering pressure survives reconstruction.

## What to Tell Your User

When Instar's turn-ending judge is known to be slow or unusable, software updates no longer make it forget and repeat the same timeout feedback. It remembers the cooldown locally, still lets the turn end safely, and automatically checks again after the cooldown.

## Summary of New Capabilities

- Restart-surviving Stop-gate authority breaker with atomic half-open recovery.
- Inspectable and explicitly resettable breaker health.
- Structural restart-survival coverage for recurring autonomous actions.

## Evidence

- 179 live `unjustifiedStopGate.timeout` records established the recurring class.
- 102 focused assertions pass across unit, integration, and E2E tiers.
- Independent second-pass review concurred with no actionable concern.
