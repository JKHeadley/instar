# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Multi-Machine Session Pool — cross-machine routing fix (still dark).** Real
hardware bring-up of a second machine surfaced a wiring gap: the session pool
routes every cross-machine action (deliver / transfer / lease) to a peer by its
`lastKnownUrl` (its tunnel URL), but nothing in the shipped code ever wrote that
field — so every peer was filtered out and no session could be routed or
transferred across machines. A machine now advertises its own tunnel URL into
the mesh registry once the tunnel is up (and re-advertises after a sleep/wake
restart, since a quick tunnel's URL changes), and a joining machine records the
URL it paired through. The whole layer remains gated behind
`multiMachine.sessionPool` (default off / `stage:'dark'`), so single-machine
agents are unaffected.

## What to Tell Your User

Nothing changes yet — this is still off by default. It fixes a foundational gap
so that, when the session pool is enabled, conversations can actually be placed
on and moved between machines.

## Summary of New Capabilities

- `MeshUrlAdvertiser` (`resolveAdvertisedMeshUrl` + `advertiseSelfMeshUrl`):
  populates a machine's `lastKnownUrl` from its tunnel URL on boot + sleep/wake.
- `instar join` now records the awake machine's URL on the joining (standby) side.

## Evidence

- Unit: `tests/unit/mesh-url-advertiser.test.ts` (resolver + advertiser vs a real
  MachineIdentityManager).
- Wiring-integrity: `tests/unit/mesh-url-advertisement-wiring.test.ts` (asserts
  the advertiser is actually invoked — the tier that would have caught the
  original zero-callers gap).
- Side-effects: `upgrades/side-effects/mesh-url-advertisement.md`.
