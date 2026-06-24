---
title: "Mesh Endpoint HTTP Propagation"
slug: "mesh-endpoint-http-propagation"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions — a git-less personal mesh must learn peer fast ropes structurally so the lease stays robust when the one flaky rope degrades."
status: draft
author: Echo (autonomous mesh-robustness mission, topic 27515)
date: 2026-06-24
risk-class: safety-adjacent (touches lease reachability); change is purely additive
eli16-overview: "mesh-endpoint-http-propagation.eli16.md"
review-convergence: "2026-06-24T06:57:44.290Z"
approved: true
approved-by: "Justin — blanket pre-approval, topic 27515 24h autonomous mesh mission ('You have my pre-approval for any decisions or specs needed')"
review-iterations: 3
review-completed-at: "2026-06-24T06:57:44.290Z"
review-report: "docs/specs/reports/mesh-endpoint-http-propagation-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
cross-model-review-reason: "codex-cli gpt-5.5 + gemini-cli gemini-2.5-pro ran rounds 1-2; both MINOR, folded"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Mesh Endpoint HTTP Propagation (git-less mesh fast-rope fix)

## Problem (verified on real hardware: Laptop ⇄ Mac Mini, both v1.3.650)

The multi-machine lease repeatedly self-fences on a 2-machine **personal (git-less)** setup. The
self-fence flips `holdsLease` false on the machine that actually holds the lease, which makes the
`AutonomousLivenessReconciler` report `blocked-not-owner` and refuse to revive a reaped session →
the user's autonomous session dies and Telegram inbound dead-ends ("session stopped"). This is the
through-line of a multi-day incident (topic 27515): a 6-hour overnight silence, repeated
"session stopped" bounces, and topic-ownership thrash.

## Root cause (code-confirmed + live-registry evidence)

The rope-aware hedged-failover lease transport ALREADY exists on main and is NOT the gap:
- `HttpLeaseTransport` carries `endpoints: MeshEndpoint[]` and uses `PeerEndpointResolver` to dial
  the best rope (tailscale → lan → cloudflare) with hedged parallel failover.
- Each machine advertises its OWN endpoints into its OWN registry entry via
  `MeshUrlAdvertiser.advertiseSelfMeshEndpoints` (writes `registry.machines[self].endpoints`).
  CONFIRMED live: `.instar/machines/registry.json` Laptop self-entry has
  `endpoints:[{tailscale,100.94.220.125},{lan,192.168.87.60}]`; `/health` →
  `multiMachine.syncStatus.meshEndpoints=['tailscale','lan']` on BOTH machines.

**The gap:** a peer's advertised `endpoints` are meant to reach the other machine only via
`RegistrySyncDebouncer`, which propagates the registry by **git `commitAndPush`**. This personal
setup runs `LocalLeaseStore` ("Lease store: LocalLeaseStore (no git medium — HTTP transport carries
cross-machine lease)" boot log) → there is **no git medium** → registry sync is INERT → peer
`endpoints` NEVER propagate.

The peer's `lastKnownUrl` (its cloudflare tunnel) IS known on each side — but ONLY because it is
recorded once at PAIRING time (`/api/pair` → `advertisedUrl` → `updateMachineUrl`), and a named
tunnel is stable so it never needs updating. The dynamic `endpoints` get no equivalent HTTP path.

**Live evidence (decisive):** `.instar/machines/registry.json` on the Laptop →
`machines[<mini-id>]` has `endpoints: null`, `lastKnownUrl: https://echo-mini.dawn-tunnel.dev`
(cloudflare only). So the Laptop's reachable-rope set for the Mini = `{cloudflare}` only.
`PeerEndpointResolver.resolve(miniId, peer.endpoints=[], peer.url=cloudflare)` → cloudflare-only.
A cloudflare latency spike (measured ~0.36s normally but spikes >30s) makes the lease renewal fail
to confirm the medium → the "renewal-requires-medium" self-fence trips → `holdsLease` false →
death loop. **multi-transport-mesh-comms is effectively INERT on a git-less personal setup — the
exact case it was designed for.**

(Note: a prior shadow-dist hotpatch already fixed a SEPARATE, earlier bug — self-advertise being
gated inside the tunnel-start block — which is why self `meshEndpoints` are populated now. That fix
is necessary but insufficient: self-advertising is useless if the peer never RECEIVES the endpoints.
This spec addresses the peer-propagation gap, which is the remaining keystone.)

## Fix — complete the parent spec's already-mandated signed-body propagation

This is NOT a new design. `multi-transport-mesh-comms` (Layer 0 / Decision 10) already mandated that
each machine's endpoints be published inside the machine-auth-signed lease/heartbeat body. The
IMPLEMENTATION diverged from that mandate: it propagated peer endpoints only via the **git**
registry-sync path (`RegistrySyncDebouncer`), so on a git-less (`LocalLeaseStore`) mesh the
propagation is inert. This spec builds the originally-mandated **signed-body** propagation channel
that the implementation never wired — closing the gap between the parent spec and its code.

### Carrier — the lease RPC, not `/api/heartbeat` (CORRECTED after review)

The reviewable verification (HttpLeaseTransport.ts) shows the actual bidirectional cross-machine HTTP
flow on a git-less mesh is the **lease RPC**, not `/api/heartbeat`:
- `POST /api/lease` — `HttpLeaseTransport.broadcast()`: the holder pushes its fenced lease to every
  peer (holder → standby). Body `{ lease, reqNonce }`, `signRequest`-signed (Ed25519 over a body
  hash). Receiver: `machineRoutes.ts` `/api/lease` handler.
- `POST /api/lease/pull` — the read-side: a standby pulls the holder's lease (standby → holder
  request; holder → standby response `{ lease }`), same signed channel.

Both directions already exist, are machine-auth-signed, and already dial via
`resolver.resolve(peer.machineId, peer.endpoints, peer.url)`. They are the correct carrier; the
earlier `/api/heartbeat` assumption was wrong (that route's cross-machine sender does not run on this
setup). Endpoints ride the **signed lease body**, so the parent's "signed in the body" requirement is
satisfied by construction (the body hash covers the added field).

**Both directions (this is load-bearing — verified against live logs).** On this setup the laptop
PULLS the Mini (`POST /api/lease/pull` → Mini), so the laptop learns the Mini's ropes ONLY if the
Mini's endpoints come back in the **pull RESPONSE**, not just the request. Therefore endpoints
propagate on THREE points, each with its own authority check:
- `POST /api/lease` (broadcast) REQUEST body carries the SENDER's endpoints → the receiver records
  them for `auth.machineId`. The existing holder-match (`lease.holder === auth.machineId`,
  machineRoutes.ts:141-146) already proves the sender is who it claims, so the endpoints are bound to
  the authenticated sender.
- `POST /api/lease/pull` REQUEST body carries the PULLER's endpoints → the holder records them for
  `auth.machineId` (the puller is the authenticated machine on that request).
- `POST /api/lease/pull` RESPONSE body carries the RESPONDER's (holder's) endpoints → the PULLER
  records them for the machine it dialed. **The pull path has NO holder-match guard**
  (machineRoutes.ts:169-186), so the puller-side binding is load-bearing. Required mechanism: the
  response includes the responder's `machineId`; the puller, which knows the `expectedPeerId` it
  dialed from its own request context, records endpoints ONLY when `response.machineId ===
  expectedPeerId` — a mismatch is rejected (logged, not recorded), so a compromised responder can
  never inject a THIRD machine's identity. Where the existing pull accept-ack already cryptographically
  proves responder identity (parent Decision 9), bind to THAT proof rather than a self-asserted body
  field. This response direction is the one that fixes the laptop's empty Mini-endpoints (the live bug).

### Sender

Add an optional `endpoints?: MeshEndpoint[]` field to the lease RPC body (the `{ lease, reqNonce }`
broadcast body and the `/api/lease/pull` request body), populated from this machine's own validated
self-endpoints (`MachineIdentityManager.getMachineEndpoints(selfId)` — already validated at write
time by `MeshUrlAdvertiser`). Absent/old senders simply omit it (fail-safe, no regression). The field
is inside the signed body, so it is cryptographically covered by the existing `signRequest` hash.

### Receiver (the load-bearing change)

In the `/api/lease` and `/api/lease/pull` handlers (`src/server/machineRoutes.ts`), AFTER auth +
holder-match and BEFORE recording, **synchronously validate then conditionally record** the sender's
endpoints:

1. **meshTransport gate:** if `multiMachine.meshTransport.enabled` is false → no-op (skip recording
   entirely; the lease handling is unchanged). A disabled mesh records nothing.
2. **Absence is a no-op (never a wipe):** if `endpoints` is undefined, null, OR an explicitly-sent
   empty array `[]` → do NOT call `updateMachineEndpoints` (leave the prior set intact). An empty
   advertised set is NOT a clear-all signal — a silent or un-upgraded sender must never erase a peer's
   known ropes.
3. **Synchronous per-kind validation BEFORE storage, via a SHARED validator — defense-in-depth, not
   authority** (Signal vs. Authority, P2). Ingest validation gates REGISTRY INTEGRITY (it prevents
   storing garbage); it is NOT the trust authority — the resolver's health-aware re-validation at dial
   time remains the authority on whether an endpoint is actually trusted/reachable. Both validate via
   the SAME function so the two can never diverge; ingest is the first line (no poisoning), resolve is
   the final line (no bypass). The per-kind host rules are ALREADY module-level **exported pure
   functions** in `PeerEndpointResolver.ts:319-389` (`hostOf`, `ipv4ToInt`, `isTailscaleCgnat`,
   `isRfc1918`, `isForbiddenHost`, `isPublicHttps`) — confirmed by the round-3 convergence reviewer —
   so the build COMPOSES them into a shared
   `validateMeshEndpoints(endpoints)` (`src/core/MeshEndpointValidator.ts`, docstring: "defense-in-depth,
   not authority") that the ingest handlers, `resolve()`, AND `updateMachineEndpoints` itself all call
   (fail-closed: a write whose set fails validation does nothing). Validation, in order: (a) require an
   array; if `length > MAX_ENDPOINTS_BATCH = MAX_ENDPOINTS * 2`, reject the whole batch as malformed;
   else clamp the working slice to `MAX_ENDPOINTS + 1` BEFORE the per-element loop (bounds the O(N)
   walk; elements beyond the cap are silently discarded, not an error); (b) each element
   `{ kind ∈ {tailscale,lan,cloudflare}, url:string }`, drop any element whose `url` length >
   `MAX_ENDPOINT_URL_LEN = 2048`; (c) per-kind host: tailscale in `100.64.0.0/10` (CGNAT), lan
   RFC-1918, cloudflare a public `https://` host (http rejected for cloudflare); reject loopback /
   link-local / cloud-metadata (169.254.169.254); (d) cap the kept set to `MAX_ENDPOINTS = 4`. The
   three constants (`MAX_ENDPOINTS=4`, `MAX_ENDPOINTS_BATCH=8`, `MAX_ENDPOINT_URL_LEN=2048`) are
   defined in code and referenced here. Drop malformed ELEMENTS (not the whole batch, except the
   batch-size guard above) and log each violation. Fail-closed: a fully-invalid set records nothing
   (treated as absence → no-op).
4. **Idempotency (normalize before compare):** normalize each kept endpoint's `url` (lower-case host,
   strip a trailing slash, canonical port) BEFORE comparing — otherwise a cosmetically-different but
   semantically-equal advertisement (`…:4042` vs `…:4042/`) defeats the equality check and churns the
   registry. Compare the normalized validated set to the current peer entry with the existing
   `endpointsEqual()` (MeshUrlAdvertiser.ts:236; extend it to normalize, or normalize at the call
   site). Only when CHANGED call `updateMachineEndpoints(senderId, validated)`; that write is the ONLY
   thing that bumps the endpoint `lastSeen`. The round-3 convergence reviewer CONFIRMED
   `updateMachineEndpoints` (MachineIdentity.ts:510-516) DOES unconditionally bump `lastSeen` +
   `saveRegistry`, so the load-bearing no-op guarantee is to **skip the call entirely when unchanged**
   (the primary path) — NOT to gate `lastSeen` inside the writer. When unchanged: skip the write, the `lastSeen` bump, and the registry-dirty mark —
   preventing ~720 no-op registry rewrites/git pushes per day on a stable 2-machine setup.
   **Anti-flap:** because a CHANGED set replaces the peer's whole set and the resolver demotes a
   failing rope by consecutive-failure health, a peer that rapidly ALTERNATES between two valid sets
   could repeatedly reset that health. The whole-set-overwrite + `MAX_ENDPOINTS` cap bound the blast
   radius; if the build observes real alternation, add a minimum re-record interval (hysteresis) per
   peer. Endpoints are expected to change rarely, so this is a guard, not a hot path.
5. **Authority — advisory only:** a peer-advertised endpoint set is recorded ONLY into THAT peer's
   registry entry and is purely advisory to the resolver. It NEVER overrides this machine's own
   self-advertised endpoints, and the resolver always prefers self/last-known-good. Recording a peer
   fact is not authority over a local fact (Signal vs. Authority).

The lease/transfer/deliver paths then automatically benefit — `peers()` already passes
`e.endpoints` through and the resolver prefers the fast rope. No resolver cache is force-invalidated
(see Frontloaded Decision 2); the next `resolve()` picks up the new set, bounded by one lease cycle.

## Safety / additivity / attack surface

- **Additive, but not zero-risk (corrected framing).** It ENRICHES the peer reachable-rope set; the
  cloudflare fallback is never removed and it can NEVER, by itself, cause split-brain — it makes the
  EXISTING anti-split-brain self-fence more ACCURATE (fewer false "no medium" trips). The honest
  failure mode: a valid-looking but STALE/wrong endpoint (e.g. after the peer roams networks) can add
  a failed dial attempt + a hedge delay before the resolver demotes it. That cost is BOUNDED by:
  per-kind validation at ingest, the `MAX_ENDPOINTS` cap, the resolver's health-demotion of a failing
  rope, per-(peer,kind) eviction (Frontloaded Decision 4), and overwrite on the next changed lease
  body. Worst case for a fully-invalid/absent set = today's cloudflare-only behavior.
- **Trust boundary / SSRF.** A peer with forged or compromised machine-auth could attempt to inject
  attacker-chosen URLs into ITS OWN endpoint set. Two layers stop this: (1) the lease RPC requires
  valid `signRequest` machine-auth + holder-match, so only an authenticated peer can advertise at
  all; (2) the load-bearing defense is the per-kind host validator (reused from `PeerEndpointResolver`)
  applied SYNCHRONOUSLY at ingest — tailscale must be CGNAT `100.64/10`, lan must be RFC-1918,
  cloudflare must be a public `https://` host; loopback / link-local / cloud-metadata (169.254.169.254)
  are rejected. The resolver host-validation must NEVER be bypassed; ingest validation is defence in
  depth so the registry itself is never poisoned (a future code path can't trust an unvalidated set).
- **Signed-body trust model (parent Decision 10 satisfied).** Endpoints travel inside the
  `signRequest`-hashed lease body, so they are cryptographically signed by the sender; a registry
  mirror is only ever populated via that signed path. There is no unsigned endpoint-advertisement
  surface.
- **Bootstrap dependency (honest).** The fix needs at least ONE successful lease RPC over the existing
  (cloudflare) channel to exchange endpoints; after that single success the machines learn each
  other's fast ropes and self-remediate. It cannot help a pair that has NEVER once reached each other,
  but that pair is already broken; in practice cloudflare succeeds intermittently, so one success
  arrives quickly and robustness improves from there.
- Rides the existing `multiMachine.meshTransport` gate (receiver recording is a strict no-op when off).

## Cross-machine coherence posture

- The recorded peer `endpoints` live in `MachineRegistryEntry.endpoints` in this machine's
  `registry.json` — **machine-local BY DESIGN**: each machine maintains its OWN view of how to reach
  its peers (durable across restart, unlike the resolver's transient in-memory health records). This
  is correct: reachability is observer-relative (the laptop's route to the Mini is the laptop's fact).
  It is NOT replicated and NOT proxied-on-read; each machine learns peers directly from the signed
  lease body it receives.
- **Topic transfer:** endpoints are machine-IDENTITY facts (network addresses), not topic state, so a
  topic moving between machines neither carries nor strands them — they are re-learned from the next
  lease RPC regardless of which topics live where.

## Known limitations & tracked follow-ups (honest scope — P14, Distrust Temporary Success) <!-- tracked: topic-27515 -->

This spec is **harm-reduction, not root-cause elimination**, and says so plainly:

1. **The deeper flaw is the lease self-fence, not the missing ropes.** The `renewal-requires-medium`
   self-fence (parent `multi-transport-mesh-comms` Layer 3) flips `holdsLease=false` when renewal
   can't confirm over ANY rope. This spec gives the lease the fast ropes it was missing, so the fence
   trips far less often — but a **bootstrap ordering gap remains**: until the FIRST successful lease
   RPC exchanges endpoints (over the only rope known at pairing — cloudflare), the fence can still
   flip on a cloudflare spike. This fix reduces recurrence; it does not make the fence tolerant of
   transient multi-rope failure. **Tracked follow-up (parent spec):** <!-- tracked: topic-27515 --> make the self-fence tolerant of
   the first N renewal cycles / a brief all-rope blip before declaring medium-loss fatal, so a healthy
   holder never self-fences on a transient spike. That is a parent-spec change, deliberately OUT OF
   SCOPE here (a separate, larger, safety-critical lease redesign). Test (this spec): a synthetic
   git-less pair reachable ONLY via LAN acquires + holds the lease via LAN through a cloudflare outage.
2. **Split-brain → Attention is unwired (separate gap, found during this work).** `checkForUnresolvableSplit`
   (LeaseCoordinator.ts:688) is defined but never called, and the `splitBrainDetected`/`splitBrainEscalation`
   events have no listener that raises an Attention item — the promised "unresolvable split-brain
   surfaces as one Attention item" safety net is absent on canonical main. Tracked as its own
   follow-up PR (not this spec's scope, but recorded so it is not lost). <!-- tracked: topic-27515 -->
3. **No explicit "I now have zero ropes" signal.** The receiver treats an empty/absent endpoint set as
   "nothing new" (never a wipe) — a pragmatic SIGNAL-level assumption that un-upgraded/silent senders
   don't advertise empty, NOT a protocol authority that a peer can never legitimately clear its ropes.
   A peer that genuinely loses all ropes (daemon down, interface dropped) cannot currently signal it;
   its stale ropes are corrected on its next non-empty advertisement and demoted by resolver health in
   the meantime. **Tracked follow-up:** <!-- tracked: topic-27515 --> a mixed-version-safe explicit clear signal
   (`clearedEndpoints?: true`) if real deployments need deliberate clears.

## Frontloaded Decisions

All design decisions are resolved here (the building agent has standing pre-authorization for this
mission; none of these touch durable external side-effects, money, identity, or a published
user-visible interface — they are internal mesh-transport wiring, reversible behind the existing
`meshTransport` gate).

1. **Carrier = the lease RPC** (`/api/lease` broadcast + `/api/lease/pull`), NOT `/api/heartbeat`.
   RESOLVED by code verification (HttpLeaseTransport.ts): the lease RPC is the real signed,
   bidirectional cross-machine flow on a git-less `LocalLeaseStore` mesh; the `/api/heartbeat`
   cross-machine sender does not run on this setup. Endpoints ride the signed lease body in both
   directions (broadcast body holder→standby; pull request/response standby↔holder).
2. **Resolver refresh = next-resolve pickup** (no forced `PeerEndpointResolver` cache invalidation).
   Endpoints change rarely (machine network identity is stable across reboots / brief outages); the
   staleness bound is ONE lease cycle, well within lease-renewal tolerance. Documented, not a knob —
   an optional invalidate hook is explicitly out of scope (adds coupling for no real-world gain).
3. **Flag posture = ride the existing `multiMachine.meshTransport` gate** (no new sub-flag). The
   change is additive and meshTransport already governs the whole rope-aware transport; a separate
   flag would fragment the rollout. Receiver recording is a strict no-op when meshTransport is off.
4. **Endpoint eviction = the resolver's existing per-(peer,kind) health-record eviction** plus
   overwrite-on-change. A peer's recorded set is replaced wholesale on the next CHANGED lease body
   (no per-element merge), and the resolver's existing health map demotes/evicts a stale-failing rope
   on its own TTL. We add no new eviction timer; a roamed-away endpoint is corrected on the peer's
   next advertisement and demoted by health in the meantime. (If the build finds the resolver has NO
   eviction at all, add a bounded per-(peer,kind) TTL there — but the current design relies on the
   existing health demotion + whole-set overwrite, which is sufficient.)
5. **Type change = add `endpoints?: MeshEndpoint[]` to the lease RPC body type** (the broadcast +
   pull body), NOT to `HeartbeatManager.Heartbeat` (that interface is not the carrier). Optional +
   absent-on-old-senders = fail-safe, no migration needed for un-upgraded peers (receiver treats
   absent as no-op).

## Decision points touched

This spec introduces NO new block/allow/route gate. It adds a recording side-effect on the EXISTING
authenticated lease RPC routes (`/api/lease` and `/api/lease/pull` — receiver records peer endpoints
after auth + holder-match), guarded by the existing `meshTransport` flag. No decision boundary is
removed or weakened.

## Open questions

*(none)*

> All decisions are frontloaded above; the building agent holds standing pre-authorization for this
> mission and every decision is internal, additive, and reversible behind the meshTransport gate.

## Tests (all three tiers — non-negotiable)

- **Unit — receiver validation:** accept a well-formed per-kind set; DROP a bad-kind element, a
  non-`100.64/10` tailscale, a non-RFC-1918 lan, a non-`https` cloudflare, a loopback/metadata host,
  an oversized url (>2048), and an over-cap array (>`MAX_ENDPOINTS`) — while keeping the valid
  elements; a fully-invalid set records nothing; a non-array / absent / empty set is a no-op that
  leaves the prior set intact.
- **Unit — idempotency:** an unchanged set (per `endpointsEqual`) does NOT call
  `updateMachineEndpoints` (no write, no `lastSeen` bump, no registry-dirty); a changed set does.
- **Unit — authority:** a recorded peer set never mutates THIS machine's own self-endpoints; the
  resolver still prefers self/last-known-good.
- **Unit — sender:** the lease RPC body includes this machine's validated self-endpoints; an
  un-upgraded sender omits the field.
- **Integration — broadcast path:** `POST /api/lease` from a valid authed sender records the sender's
  endpoints into that peer's registry entry; an unauthenticated / holder-mismatch / malformed payload
  records nothing; meshTransport=off → records nothing.
- **Integration — pull request path:** `POST /api/lease/pull` carrying the puller's endpoints records
  them for the authenticated puller.
- **Integration — pull RESPONSE path (the live-bug fix):** a puller that receives the holder's
  endpoints in the pull response records them against the EXPECTED dialed peer; a response naming a
  third machine's endpoints is NOT recorded (puller-side identity binding); an un-upgraded holder
  (no endpoints in the response) leaves the puller's registry untouched (no corruption).
- **Wiring:** after the peer entry gains endpoints, `PeerEndpointResolver.resolve(peerId, endpoints,
  url)` returns tailscale/lan ahead of cloudflare (the lease dial uses the fast rope).
- **Regression:** the git-less-no-propagation bug — a `LocalLeaseStore` setup where, pre-fix, a peer
  entry stays `endpoints:null`; post-fix it gains the peer's ropes after one lease RPC.

## Migration parity

No config default change required (rides existing `meshTransport`). If any default is added, register
it in `PostUpdateMigrator`. Receiver code is additive on an existing route — no migration needed for
existing agents beyond the normal dist update.

## Verification (after deploy)

On the live Laptop ⇄ Mini pair: confirm `.instar/machines/registry.json` Mini entry gains
`endpoints:[tailscale,lan]` after one lease RPC cycle (currently `endpoints:null` — the live evidence
of the bug); watch `logs/server.log` for the lease wire dialing `…/tailscale` or `…/lan` instead of
`…/cloudflare`; confirm `holdsLease` stays true through a cloudflare blip (inject latency or observe a
natural spike). Confirm the idempotency guard: a stable network produces NO repeated registry writes
(the file mtime stops churning every lease cycle).

## Do not duplicate

Existing related work (checked): `multi-transport-mesh-comms` (base feature, on main),
`mm-lease-poll-robustness`, `spec-multimachine-lease-robustness` (#680, on main),
`echo-statesync-peer-advert-fix` (UNMERGED — stateSync, not mesh endpoints; not this). The endpoint
HTTP-propagation specifically is NOT yet built.
