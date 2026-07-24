---
title: "Make standby serving takeover fire on time"
---

## What Changed

When a serving machine stops renewing its signed lease, the standby now wakes
the existing fenced takeover actor on the fast peer-observation cadence. This
removes an unrelated timer-phase delay that could leave a two-machine mesh with
no awake server for almost another two minutes after takeover was already safe.
The preferred standby also keeps the exact fenced takeover epoch alive while the
peer remains offline instead of self-suspending after one lease lifetime.

## What to Tell Your User

If your serving laptop goes offline, its standby can take over shortly after the
configured safety window instead of waiting for a second slow timer. Existing
split-brain fencing and automatic preferred-machine hand-back remain in place.

## Summary of New Capabilities

- Eligible serving failover runs on the roughly five-second lease-pull cadence.
- A preferred standby may renew the exact epoch it acquired through the existing
  expired/dead/non-renewing peer takeover authority.
- The standby still uses the existing signed evidence, monotonic freshness, and
  fenced compare-and-swap authority.
- Returning preferred machines continue through claim-before-release hand-back.

## Evidence

The expanded focused gate passes 151 tests covering takeover, solo renewal, hand-back consent,
zero-holder prevention, contested leases, and self-action convergence. TypeScript
compile, repository lint, production build, and independent review also pass.
