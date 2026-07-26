# Upgrade Guide — vNEXT
<!-- bump: patch -->

## What Changed

Fixed the guard-posture summary's false all-clear shape. `GET /guards` now returns `summary.loadBearingUninspectableKeys`, listing load-bearing guards whose existing posture is `missing`, `errored`, `on-stale`, or `off-runtime-divergent`. These guards remain excluded from `loadBearingGapKeys`, and `GuardPostureProbe` keeps emitting only their existing anomaly class, so the read surface becomes complete without changing classification or double-alarming.

## What to Tell Your User

The guard-health readout now distinguishes critical protections that are silently off from critical protections whose condition cannot currently be inspected. A clean critical-gap list no longer looks like proof that every critical protection was checked.

## Summary of New Capabilities

- Guard health now names load-bearing protections whose condition is missing, errored, stale, or contradicted by runtime state.

## Evidence

- Refusal-first unit coverage constructs an errored load-bearing guard and requires exclusion from the gap list, inclusion in the uninspectable list, and exactly one existing errored probe anomaly.
- Unit coverage pins all four uninspectable posture classes. Integration and end-to-end lifecycle coverage require the new summary field to survive the real authenticated `GET /guards` route.
