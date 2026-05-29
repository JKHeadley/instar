# Side-effects review — HTTP presence transport (PeerPresencePuller)

## What was happening (real-hardware, 2026-05-29)

The Multi-Machine Session Pool's live-transfer proof (laptop ↔ Mac mini) got all
the way to the edge and surfaced one architectural gap: the mesh **forms** fine
over HTTP (non-interactive code-auth pairing, URLs exchanged, peers reachable at
their tunnels, split-brain clear), but the router would not transfer a session
to the mini because it saw the mini as `online: false`.

Root cause: the pool registry's notion of which peers are ONLINE was fed ONLY by
the **git-synced** `MachineHeartbeat` — each machine writes its heartbeat into
the shared agent repo and peers pull it. The mini is paired into the mesh over
HTTP but is `gh`-authed to a *different* account, so it has no push access to the
shared repo. Its heartbeat never reaches the router → the router marks it offline
→ the placement engine refuses to transfer to an offline machine — even though
the two machines reach each other perfectly over their tunnels.

## The fix

A pull-based HTTP presence channel that does not touch git:

- **`src/core/PeerPresencePuller.ts`** (new) — on a cadence, ask each reachable
  peer for its self-capacity over the signed §L0 `session-status` MeshRpc command
  and feed the answer into the local `MachinePoolRegistry.recordHeartbeat`. A peer
  that answers is by definition reachable + alive, so it goes `online` purely over
  HTTP. Fully injected (peers, fetch, record, clock) and `pullOnce()` NEVER throws
  — an unreachable peer is simply not recorded this pass and ages out of `online`
  via the registry's existing failover threshold.

- **`src/commands/server.ts`** — in the mesh-rpc block (right after the
  SessionRouter is wired, where `meshClient` / `peerUrl` / `machinePoolRegistry`
  are in scope), construct one `PeerPresencePuller` and start it: an immediate
  `pullOnce()` plus a 30 s `unref`-ed interval. `fetchPeerCapacity` issues
  `meshClient.send(peer, { type: 'session-status' }, 0)`; `recordHeartbeat`
  delegates to the real pool registry.

`session-status` is a read-class command (RBAC: any *registered* peer — proven by
`verifyEnvelope`), so the call authenticates off the mutual identity established
at pairing. No router role, no epoch fence, no new route, no new config.

## Blast radius

- **Additive + symmetric.** Every mesh machine runs one puller; each maintains
  its own HTTP-sourced view of peer liveness. It runs in PARALLEL with the
  existing git-synced `refreshPool` path — a credentialed peer that both
  git-syncs AND answers HTTP just refreshes twice. `recordHeartbeat` is the single
  arbiter and the router's-clock liveness rule is unchanged, so a peer can never
  be marked *fresher* than its real `routerReceivedAt`.
- **Inert without a mesh.** A single-machine agent has no peers → `listPeers()` is
  empty → `pullOnce()` is a no-op. Only constructed inside the existing
  mesh-enabled block.
- **No new config / route / schema / hook / skill → no migration.** Server +
  one new core module; existing agents pick it up on the next release (same shape
  as the native-rebuild / wake-socket fleet fix).
- **Does NOT replace the git substrate** for ownership/placement *records* (§L0)
  — only the high-frequency presence signal moves to HTTP.

## Tests

- `tests/unit/peer-presence-puller.test.ts` — loop semantics with injected fakes:
  a peer that answers is recorded (id + loadAvg + selfReportedLastSeen); self is
  never polled; a peer with no URL is skipped; a fetch that REJECTS does not throw
  and does not record (peer ages out); a null result is not recorded; the clock
  fallback fills `selfReportedLastSeen`; `listPeers` is re-read each pass.
- `tests/unit/peer-presence-wiring.test.ts` — pins the server-boot wiring:
  imports + constructs a real puller, feeds the signed `session-status` call into
  `machinePoolRegistry?.recordHeartbeat`, and actually STARTS it (immediate
  `pullOnce()` + recurring `unref`-ed timer) — guards against the
  "constructed-but-inert" failure the Testing Integrity Standard calls out.
- `tests/integration/peer-presence-roundtrip.test.ts` — the full chain over a real
  loopback `/mesh/rpc` with real Ed25519 keys: MINI starts OFFLINE +
  placement-ineligible on the router (no git heartbeat); after ONE presence pass
  over the signed channel it is ONLINE + placement-eligible (loadAvg carried over
  HTTP) — and an unreachable peer is never marked online.
