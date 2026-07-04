---
user_announcement:
  - audience: agent-only
    maturity: stable
    summary: >
      Fixed the "awakeMachineCount: 0" telemetry lie — the /health mesh awake
      count now derives from live lease observations, not a laggy registry symbol.
---

## What Changed

`GET /health → multiMachine.syncStatus.awakeMachineCount` used to be computed by
counting `registry.machines[].role === 'awake'` rows — a git-synced SYMBOL that
lags the authoritative lease. On a healthy two-machine mesh where a peer held the
lease but its registry role hadn't propagated (or the Cloudflare rope was down
while Tailscale/LAN carried the lease), this read **0** even though `leaseHolder`
correctly named the holder — a telemetry lie reproduced live on the Laptop+Mini
pair.

`awakeMachineCount` now derives from LIVE lease observations
(machine-coherence-guard §5b): `(self holds ? 1 : 0)` plus each distinct peer
whose most-recent lease observation is fresh, live (not expired), and a self-claim
(no third-machine hearsay). It ships with a sibling `awakeMachineCountSource`
(`lease-live` | `registry-roles` | `unavailable`) so the basis is always explicit.
A git-only mesh degrades to the registry-role count (honestly tagged); a read
failure yields `null` + `unavailable` — never a silent 0.

`instar doctor` now labels the registry-role check as a possibly-lagging VIEW and,
when the server is running, adds a **Live lease view** line with the authoritative
count + source, naming any registry-vs-live divergence.

**Shape change (agent-only):** `MultiMachineSyncStatus.awakeMachineCount` is now
`number | null` (was `number`) and gains `awakeMachineCountSource`. No dashboard or
external consumer reads the field; the `/pool` and `/health` surfaces carry both.

## What to Tell Your User

If you asked "why does my mesh say zero machines are awake when both are online?"
— that was a telemetry bug: the count read a stale registry symbol instead of the
live lease. It now tracks the same authoritative signal the lease-holder field
uses, so a healthy mesh with one machine in charge reports one machine awake, and
a genuine split-brain reports more than one. Nothing about how the mesh actually
serves you changed — only the honesty of the number.

## Summary of New Capabilities

- `multiMachine.syncStatus.awakeMachineCount` is now lease-live and source-tagged
  (`awakeMachineCountSource`), never a silent 0.
- `instar doctor` prints the live lease view of "who is awake" and flags
  registry-vs-live divergence.
