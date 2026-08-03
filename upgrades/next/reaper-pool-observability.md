# Upgrade Guide — Reaper pool observability

<!-- bump: patch -->

## What Changed

The live SessionReaper snapshot, its decision audit, and the reap-log now honor
pool scope. All three reads preserve this machine's answer even when another registered machine
is dark, old, unreachable, unauthorized, or malformed. Peer evidence is tagged
with registry-owned machine identity, and every failed fan-out becomes a
classified `pool.failed` row instead of disappearing or turning the whole read
into an error. Plain reads keep their existing response shape.

## What to Tell Your User

- **Reaper evidence now covers every machine:** “When I inspect why sessions are
  piling up or being reaped, I can read the whole pool from one machine.”
- **A dark peer is visible, not mistaken for no activity:** “If another machine
  cannot answer, the result says which machine failed and why while still
  returning the local evidence.”

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Read live reaper posture across the pool | Add `scope=pool` to the SessionReaper snapshot read |
| Read machine-attributed reaper decisions across the pool | Add `scope=pool` to the decision-audit read; `limit` applies per machine |
| Compare completed and refused shutoffs across machines | Add `scope=pool` to the reap-log read; rows remain chronological and machine-tagged |
| Distinguish empty evidence from failed fan-out | Inspect `pool.failed`, `peersQueried`, and `peersOk` |

## Evidence

Integration tests exercise real peer servers, registry-owned identity despite
spoofed peer fields, live-address precedence, a dark registered machine, an
older peer missing the route, rejected public URLs, bounded chunked responses,
malformed/deep snapshot and evidence bodies, successful empty peers, global
timeline ordering, and preservation of local evidence. End-to-end tests
exercise all three pool reads through real server wiring on a single-machine
install and prove plain-route response compatibility.
