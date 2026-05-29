# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Multi-machine: a second machine that can't push to your shared agent repo now
still shows up as online — so work can move to it.** When you run one agent
across two machines, the pool decides which machine is "online" (and therefore
eligible to receive a conversation) from a heartbeat. Until now that heartbeat
travelled through the shared agent git repo: each machine wrote its heartbeat
into the repo and the others read it. A second machine paired over the network
but signed into a *different* GitHub account has no way to push to that repo, so
its heartbeat never arrived — the main machine saw it as permanently offline and
refused to hand any session to it, even though the two machines could reach each
other perfectly over their tunnels.

There's now a direct presence channel that doesn't touch git: each machine
periodically asks every reachable peer "are you there?" over the same signed,
encrypted machine-to-machine channel it already uses for everything else, and
marks a peer online the moment it answers. A credential-less standby therefore
becomes a real, transfer-eligible member of the pool purely over its tunnel.

## What to Tell Your User

If you only run on one machine, nothing changes. If you run across two machines
and the second one is signed into a different GitHub account (or otherwise can't
push to the shared repo), it will now correctly appear **online** on your
Machines tab / `GET /pool` and become eligible to receive conversations — no
extra setup, no git credentials needed on the second machine.

## Summary of New Capabilities

- `PeerPresencePuller` (new core module): a pull-based HTTP presence channel.
  Each mesh machine asks every reachable peer for its self-capacity over the
  signed `session-status` MeshRpc command and records the answer into its local
  `MachinePoolRegistry` — so a peer that can't push a git-synced heartbeat still
  goes online over its tunnel. Symmetric, additive, and idempotent with the
  existing git-synced heartbeat path; inert on a single-machine agent.

## Evidence

- `tests/unit/peer-presence-puller.test.ts` — loop semantics with injected fakes
  (records an answering peer; never polls self; skips a peer with no URL; a
  rejecting fetch neither throws nor records; null is not recorded; clock
  fallback; `listPeers` re-read each pass).
- `tests/unit/peer-presence-wiring.test.ts` — server-boot wiring: a real puller
  is constructed, feeds the signed `session-status` call into
  `machinePoolRegistry.recordHeartbeat`, and is actually started (immediate pass
  + recurring unref-ed timer).
- `tests/integration/peer-presence-roundtrip.test.ts` — full chain over a real
  loopback `/mesh/rpc` with real Ed25519 keys: a peer starts OFFLINE +
  placement-ineligible on the router (no git heartbeat) and, after ONE presence
  pass over the signed channel, is ONLINE + placement-eligible — with an
  unreachable peer never marked online.
- Side-effects: `upgrades/side-effects/http-presence-transport.md`.
