<!-- bump: minor -->
<!-- change_type: feat -->

## What Changed

The apprenticeship program can now SEE when its deepest layer is starving.
`GET /apprenticeship/instances/:id/role-coverage` gains an observe-only
`keystoneBalance` block:

```
keystoneBalance: {
  keystoneAxis: 'mentor-mentee-differential',
  keystoneCycleCount, lastKeystoneAt,
  oversightCycleCount, oversightSinceKeystone,
  starved: boolean, starvationThreshold, reason
}
```

`starved:true` means the deepest layer (the real mentor→mentee drive) is
under-firing relative to ongoing activity — the silent "mentor-heavy /
mentee-light" drift. It generalizes the old narrow `driftWarning` to catch the
common "keystone fired once long ago, then drifted into pure review" case, not
just "never fired." Tune the threshold per call with
`?oversightStarvationThreshold=N` (default 3).

Why: a 2026-06-06 holistic check found the program lopsided — the mentor layer
had run 13 cycles while the mentee layer ran 3, and nothing surfaced it. By
"Observation Needs Structure," a duty to notice is a wish unless the structure
makes it visible.

## What to Tell Your User

Your agent can now answer "is my apprenticeship loop actually exercising its
deepest layer, or has it drifted into just reviewing?" — and flag when the
mentee side is starving, so the imbalance can't silently persist.

## Summary of New Capabilities

- `keystoneBalance` on the role-coverage response — observe-only deepest-layer
  health, with a plain-English `reason`. Tunable via
  `?oversightStarvationThreshold=N`. Never gates.

## Scope (honest)

Observe-only this slice. It surfaces the imbalance; it does NOT yet
auto-correct. The natural phase-2 (a cadence rule that drives the mentee layer
at least once per K mentor cycles) is deliberately deferred so the signal
proves out first — the same ship-the-observation-before-the-law order used for
#856/#864 ahead of the #861 constitution article.

## Evidence

Computed from existing cycle rows (no new storage, no migration). Three test
tiers green: unit (both sides of every boundary incl. shortcut-still-un-driven
and exactly-at-threshold), integration (route surfaces it + honors the tuning
query), e2e (alive through the real AgentServer). Migration-parity + agent-
awareness covered (template line + idempotent PostUpdateMigrator backfill, 4
tests). `tsc --noEmit` clean.
