# Side-Effects Review — Cross-Machine Seamlessness: lease wire transport (§6)

**Spec:** CROSS-MACHINE-SEAMLESSNESS-SPEC.md §6 ("the low-latency authoritative copy of the lease travels over the tunnel"). First piece of the wire-transport increment (live-tail-flush + handoff-ack transport follow).

## What changed
- `src/core/HttpLeaseTransport.ts` (new) — implements LeaseTransport over the
  existing authenticated machine channel (signRequest + machineAuth). broadcast()
  POSTs the signed lease to each peer's /api/lease; observed() returns the
  freshest received lease + per-holder nonce map; isReachable() reflects recent
  broadcast success; recordObserved() ingests a peer lease (highest-epoch wins,
  nonce watermark advances, replays dropped).
- `src/server/machineRoutes.ts` — new auth-verified POST /api/lease receiver
  (lease holder must match the authenticated machine) → ctx.onLeaseReceived.
- `src/server/AgentServer.ts` — new optional `leaseTransport` option; wires
  onLeaseReceived → leaseTransport.recordObserved.
- `src/commands/server.ts` — constructs HttpLeaseTransport, passes it as the
  LeaseCoordinator's `tunnel`, and into AgentServer.

## Over/under-block, safety
- SINGLE-MACHINE SAFE: with no peers, broadcast() is a reachable no-op and
  isReachable() stays true, so the lease behaves EXACTLY as git-only (Echo and
  all single-machine agents are unaffected — no behavior change).
- Multi-machine: the lease now also travels over the wire (RTT-bounded
  acquisition) and renewal requires reaching a medium (tunnel OR git) — the
  spec's split-authority guard. FencedLease.acceptTunnelLease re-verifies the
  Ed25519 signature + git-epoch floor + nonce before trusting a wire lease, so a
  forged/replayed/below-floor broadcast is rejected regardless of the endpoint.

## Signal vs authority / interactions
- The endpoint is signature-gated (machineAuth) AND holder-must-match-auth; the
  transport is a fast COPY, never the authority (git CAS + FencedLease fencing
  remain authoritative; max(tunnel,git) never drops below the git floor).
- recordObserved keeps only the highest-epoch lease + advances the nonce
  watermark → an at-least-once wire redelivery cannot regress the view.

## Rollback cost
- Low. leaseTransport is optional; removing the server.ts wiring reverts the
  LeaseCoordinator to git-only (the prior, tested behavior). The endpoint is
  inert without onLeaseReceived. New module unreferenced if unwired.

## Tests
- tests/unit/HttpLeaseTransport.test.ts (6): broadcast reachability, single-machine
  no-op, observed recording, nonce watermark + replay drop, highest-epoch wins,
  reachability window. LeaseCoordinator + FencedLease suites still green (35 total).
- Live two-machine wire behavior is exercised by the real-hardware gate (the
  over-Telegram test increment).
