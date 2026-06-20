## What Changed

A live-verify of v1.3.630 on a real two-machine pair found the multi-transport mesh comms feature shipped **inert** — it activated on nothing. Two bugs, both fixed here:

- **Wrong activation predicate.** The mesh advertiser and the new server bind gated on `config.multiMachine.enabled` — a near-dead field a real multi-machine agent never sets. The canonical "am I multi-machine?" signal is `identityManager.hasIdentity()` (the same check `coordinator.start()` uses). Result in 1.3.630: `meshEndpoints` stayed empty and the server never advertised its ropes. Now both gate on `hasIdentity()`, so every genuinely multi-machine agent gets the feature with no config flag.
- **Server bind never flipped.** `loadConfig` ALWAYS defaults `host` to `127.0.0.1` when unset, so the bind's `config.host || … || meshBindDefault` could never reach the `0.0.0.0` mesh default — the server stayed on localhost even when mesh was active, so peers still couldn't reach it on the advertised Tailscale/LAN ropes. Fixed by extracting bind-host resolution into a pure, unit-tested `resolveMeshBindHost()` that treats a LOOPBACK `host` as non-explicit (so the mesh default applies); an explicit NON-loopback `host` still wins, and `meshTransport.bindHost` is the escape hatch to force loopback on a mesh agent.

Net effect: on a multi-machine agent with mesh enabled, the server now actually binds `0.0.0.0` and advertises `[tailscale, lan, cloudflare]` (verified live: `GET /health → meshEndpoints` populated, server listening on the Tailscale/LAN interfaces). A single-machine agent (no identity) is unchanged — still `127.0.0.1`, never newly exposed.

## What to Tell Your User

If you run one agent across more than one machine, the multi-connection failover announced in the previous update wasn't actually switching on — this release makes it work. Your machines now genuinely reach each other over Tailscale and local wifi (not just the Cloudflare tunnel), so a flaky tunnel no longer destabilizes the "who's in charge" election. It's automatic and a no-op on single-machine setups; nothing for you to configure.

## Summary of New Capabilities

- Multi-transport mesh now activates on the canonical multi-machine signal (`hasIdentity()`), not the unused `multiMachine.enabled` flag — so it works on real multi-machine agents with no extra config.
- A multi-machine mesh agent's server reliably binds `0.0.0.0` (reachable on its advertised Tailscale/LAN ropes); single-machine agents stay on `127.0.0.1`. `meshTransport.bindHost` forces loopback if ever wanted; an explicit non-loopback `host` always wins.
- New pure, tested `resolveMeshBindHost()` helper (the bind logic is no longer untestable inline code).

## Evidence

- 7 new regression unit tests in `tests/unit/MeshEndpointAdvertiser.test.ts` covering both sides of the boundary: mesh-active + defaulted/undefined/localhost/::1 host → `0.0.0.0`; single-machine → `127.0.0.1`; explicit non-loopback host wins; `meshTransport.bindHost` escape hatch; explicit host outranks bindHost. 24/24 in that file pass.
- 86 affected-area tests green (PeerEndpointResolver, MeshEndpointAdvertiser, leaseAckAuth, HttpLeaseTransport-mesh, LeaseCoordinator-selfHeal, MultiMachineCoordinator-tickSelfHeal); full lint suite exit 0; `tsc --noEmit` clean.
- LIVE-VERIFIED on the real Mac Mini after deploy: with the fix's predicate, `GET /health → meshEndpoints = [tailscale, lan, cloudflare]` and the server binds `0.0.0.0`; lease epoch stable, split clear.
- Independent second-pass review: CONCUR (no new exposure — route auth unchanged, `init` always mints a token; `hasIdentity()` confirmed canonical; single-machine never newly exposed).
- Rides the already-converged+approved spec `docs/specs/multi-transport-mesh-comms.md` (impl→spec bug fix). Side-effects: `upgrades/side-effects/multi-transport-mesh-bind-predicate-fix.md`.

## ELI16

Last update gave the two-machine setup several "ropes" to talk over (Tailscale, local wifi, the Cloudflare tunnel) so one flaky connection couldn't make the machines panic about who's in charge. But when we actually tested it on the real Mini-and-laptop pair, none of it turned on: the code was looking for an on-switch (`multiMachine.enabled`) that real setups never flip, and even when forced on, the server was still only listening to itself (`127.0.0.1`) because a buried default always set the address to localhost. So the machines advertised ropes nobody could dial. This fix makes the feature switch on by the real signal — "does this machine have a multi-machine identity?" — and makes the server actually listen on the network so peers can reach it. We proved it live: the Mini now advertises all three ropes and listens on `0.0.0.0`. A single-machine agent still stays private on localhost, exactly as before.
