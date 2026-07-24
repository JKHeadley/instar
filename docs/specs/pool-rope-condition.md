---
title: "Pool rows carry live rope-health reachability (offline-test honesty finding)"
slug: "pool-rope-condition"
author: "Echo"
parent-principle: "Verify the State, Not Its Symbol"
status: "approved"
approved: true
approved-by: "Drive 11 pre-approved autonomous session (topic 29723, operator-authorized 2026-07-23); fixes the '/pool online flag lagged ~15 min' finding reported to the operator in the A3 offline-test evidence narrative (2026-07-23 ~20:23 PDT) — reversible, additive, dark-on-fleet by construction per the drive's decision delegation"
review-convergence: "2026-07-24T12:45:00Z"
review-iterations: 1
review-completed-at: "2026-07-24T12:45:00Z"
cross-model-review: "Design reviewed against the live A3 evidence (rope-health honest <1 min vs pool flag ~15 min); both-sides boundary tests; placement-semantics isolation verified by reading MachinePoolRegistry.isPlacementEligible call sites"
eli16-overview: "pool-rope-condition.eli16.md"
single-run-completable: true
---

# Pool Rows Carry Live Rope-Health Reachability

Status: implemented in the same PR (additive observability fix)

## Problem (live evidence, 2026-07-23 A3 offline test)

When the laptop dropped off the network at 19:56 PDT, `GET /mesh/rope-health`
classified it `peer-offline` in under a minute (allDownSince 19:55:57). The
`/pool` row's `online` flag stayed `true` until ~20:11 — a ~15-minute window
in which the Machines view rendered a provably-dark machine as online. The
operator watched this live.

Root cause is not a bug but a semantic conflation: `online` derives from
`(now − routerReceivedAt) < failoverThresholdMs`, deliberately conservative
because it feeds `isPlacementEligible` — placement must not flap on a
5-second network blip. The DISPLAY had no faster signal to render.

## Design

Keep both truths visible without coupling them:

- `online` — untouched. Placement semantics exactly as before.
- Each `/pool` machine row additionally carries the rope-health monitor's
  live per-peer classification when the monitor is running:
  - `ropeCondition`: `ok` | `degraded` | `peer-offline` | `urgent` | `unknown`
  - `ropeAllDownSince`: ISO onset, present only while all transports are down

Implementation: a pure decoration module (`src/server/poolRopeCondition.ts`)
mapping monitor peer rows onto pool rows by machineId; one call in the
`GET /pool` route reading `ctx.ropeHealthMonitor?.status().peers`.

## Non-goals

- No change to placement, failover thresholds, or the registry.
- No dashboard rendering change in this PR (consumers can adopt the fields;
  the Machines tab render is a follow-up <!-- tracked: ACT-965 -->).
- No new config: the fields ride the existing `monitoring.ropeHealth` gate.

## Safety

- Fleet (monitor dark): `ctx.ropeHealthMonitor` is null → decoration is the
  identity → response byte-identical. Dark by construction.
- Self row / untracked machines: pass through as the same object (no
  `undefined`-valued keys).
- Content-scrubbed by construction: condition labels + ISO timestamps only —
  the same surface `/mesh/rope-health` already serves.

## Verification

- Unit: `tests/unit/pool-rope-condition.test.ts` — both sides of every
  boundary (tracked/untracked, all-down/healthy, dark monitor, immutability,
  non-finite onset).
- Integration: `tests/integration/pool-routes.test.ts` — fields present
  while `online` is still `true` (the exact live honesty window); dark
  monitor → shape unchanged.
