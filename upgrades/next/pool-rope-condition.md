---
slug: pool-rope-condition
summary: Surface live rope-health reachability on each GET /pool machine row so a dark machine renders honestly within a minute instead of the ~15-minute placement threshold.
---

# Pool rows carry live rope-health reachability

## What Changed

Each machine row in `GET /pool` now carries the rope-health monitor's live
per-peer classification — `ropeCondition` (ok / degraded / peer-offline /
urgent) and `ropeAllDownSince` (ISO onset when all transports are down) —
when the monitor is running. The registry's `online` flag is untouched: it
feeds placement and stays deliberately flap-resistant. On installs where the
rope-health monitor is dark (the fleet default) the fields are absent and the
response is unchanged.

## What to Tell Your User

When one of your machines goes offline, the Machines view now reflects it
within about a minute instead of showing the machine as online for up to
15 minutes. Nothing to configure.

## Summary of New Capabilities

- `GET /pool` machine rows carry `ropeCondition` + `ropeAllDownSince` when
  rope-health monitoring is active — reachability honesty within one
  evaluation, with placement semantics unchanged.
