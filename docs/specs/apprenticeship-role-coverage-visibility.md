---
approved: true
review-convergence: "single-author-code-grounded-2026-06-03"
parent-principle: "Observability — you can't tune what you can't see"
---

# Apprenticeship Role Coverage Visibility

## Problem

An apprenticeship instance can appear active while work drifts onto the easier overseer-apprentice
review axis. The mentor-mentee differential loop can stay dormant even though that loop is the point
of the apprenticeship, and the current cycle store does not make that dormancy visible.

The existing `kind` column is not enough by itself: historical rows use the legacy catch-all value
`differential-cycle`, and no prior writer set a role axis. The implementation must not infer an axis
from old data.

## Design

Define a controlled cycle-kind vocabulary:

- `mentor-mentee-differential`
- `overseer-apprentice-devreview`
- `overseer-mentee-direct`
- `unknown`

Map historical `differential-cycle` rows to `unknown`. New cycle writes default to
`mentor-mentee-differential` unless a caller explicitly supplies one of the vocabulary values.
Invalid values fail instead of silently becoming coverage.

Add `ApprenticeshipCycleStore.roleCoverage(instanceId)`, returning:

- `axes`: per-axis `{ fired, cycleCount, lastAt }`
- `unknown`: the same shape for unverifiable historical rows
- `dormantAxes`: axes with no cycles
- `driftWarning`: true when `mentor-mentee-differential` is dormant and
  `overseer-apprentice-devreview` has at least two cycles

Expose it through read-only `GET /apprenticeship/instances/:id/role-coverage`.

## Constraints

This surface is observability-only. It must never gate a lifecycle transition, block a message, close
a cycle, or mutate an apprenticeship instance. Store migration may only backfill legacy cycle rows to
`unknown`, preserving the fact that their axis is not known.

## Verification

Unit tests cover vocabulary/defaulting, legacy mapping, drift true, healthy mix false, and empty
instance false. Integration tests cover auth, 503 when the cycle store is unavailable, drift true,
healthy false, and empty false through the real route. E2E boots `AgentServer` and proves the route
is live. CapabilityIndex tests ensure the route is discoverable and the discoverability lint is run
explicitly.
