# Side-effects analysis — pool-rope-condition

## ELI16 — what this does

When one of your machines drops off the network, the mesh's rope-health
monitor notices within about a minute. But the Machines view (`GET /pool`)
kept saying "online" for ~15 more minutes, because its `online` flag is
deliberately slow — it feeds session placement, and placement must not flap
on a 5-second network blip. During the 2026-07-23 laptop-offline test the
operator watched a provably-dark laptop render as online for a quarter hour.

The fix: each `/pool` machine row now ALSO carries the rope-health monitor's
live classification (`ropeCondition`: ok / degraded / peer-offline / urgent,
plus `ropeAllDownSince` when all transports are down). The slow `online` flag
is untouched — placement semantics are exactly as before. Consumers that
render reachability can now be honest within a minute.

## What could this break?

- **Nothing on the fleet by construction**: the rope-health monitor is
  dev-gated (`monitoring.ropeHealth` dark on fleet installs), so
  `ctx.ropeHealthMonitor` is null there and the decoration is the identity —
  the response is byte-identical to before.
- **Placement**: untouched. `online`, `isPlacementEligible`, and the
  failover threshold are not read or written by this change.
- **Response shape**: additive optional fields only. Existing consumers
  (dashboard Machines tab, pool fan-outs, tests) ignore unknown fields.
- **Self row**: the monitor tracks PEERS only, so the self machine carries no
  rope fields — tested explicitly (untracked rows pass through as the same
  object, no `undefined`-valued keys).
- **Invalid onset values**: a non-finite `allDownSince` is dropped rather
  than rendered as `Invalid Date` — tested.

## Failure modes considered

- Monitor present but `status()` throwing: not newly reachable — `status()`
  is the same call the existing `/mesh/rope-health` route makes on every
  read; no new failure surface is introduced beyond that established path.
- Stale classification: the monitor's own evaluation cadence bounds
  staleness; the field reflects the monitor's last evaluation, which is the
  same contract `/mesh/rope-health` already exposes.

## Content scrubbing

The decoration carries condition labels + ISO timestamps only — the same
content-scrubbed surface `/mesh/rope-health` already serves (rope kinds and
nicknames, never IPs/URLs/tailnet names).

## Test coverage

- `tests/unit/pool-rope-condition.test.ts` — both sides of every boundary:
  tracked vs untracked row, all-down vs healthy, dark monitor (identity),
  input immutability, non-finite onset.
- `tests/integration/pool-routes.test.ts` — the route carries the fields
  while `online` is still true (the exact honesty window), and the
  dark-monitor response is shape-unchanged.
