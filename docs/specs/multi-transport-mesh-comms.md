---
title: "Robust Multi-Transport Mesh Communication"
slug: "multi-transport-mesh-comms"
author: "echo"
eli16-overview: "multi-transport-mesh-comms.eli16.md"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
review-convergence: "2026-06-20T06:29:06.705Z"
review-iterations: 5
review-completed-at: "2026-06-20T06:29:06.705Z"
review-report: "docs/specs/reports/multi-transport-mesh-comms-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "codex-not-installed"
single-run-completable: true
frontloaded-decisions: 16
cheap-to-change-tags: 0
contested-then-cleared: 5
approved: true
approved-by: "Justin Headley (operator, topic 27515, authenticated uid 7812716706)"
approved-at: "2026-06-20T06:45:00Z"
---

# Robust Multi-Transport Mesh Communication

## Problem statement

When this agent runs across more than one machine (the Echo Mini + traveling
Laptop pair), every machine-to-machine HTTP call rides **one rope**: the peer's
single advertised `lastKnownUrl`, which in practice is its **Cloudflare tunnel
hostname**. Cloudflare quick/named tunnels drop intermittently (observed 502 /
530 / 503 on the Echo pair). When that single rope flaps, the fenced-lease
renewal cannot confirm over its medium and the holder heads toward self-suspend,
then re-acquires locally — producing a ~2-minute **epoch-inflation flap**
(observed live 2026-06-20: epoch 12748→12753 in 11 minutes, one re-acquire per
renewal cycle). The acute symptom today is benign only because the peer is in
silent standby and nothing contests the brief gaps; with a contending peer, or a
genuinely-gone sole peer, the same mechanism can strand the stationary machine
(the stationary captain self-suspends because it cannot reach an absent traveler
— see `LeaseCoordinator.renew()`).

The root cause is **single-path fragility**, not the lease logic: the machines
have exactly one way to reach each other, and it is the least reliable one
available. Both machines are, in fact, simultaneously reachable by more robust
paths that are currently unused: they are frequently on the **same LAN** (Mini
observed at `192.168.87.67`), and a **Tailscale** (WireGuard mesh) private
address would follow the Laptop across networks while travelling.

This spec makes mesh communication **multi-rope with health-aware hedged
failover**: each machine advertises every endpoint it is reachable at (Tailscale,
LAN, Cloudflare), peers try them intelligently and only declare a peer
unreachable when **all** ropes fail, and — as an explicit, safe-by-construction
last layer — a preferred stationary captain whose sole peer is
*presumed-gone by liveness-silence* (aged out of the heartbeat window, not merely
unreachable this tick) holds its lease rather than thrashing. (Precisely:
liveness-silence is a *presumption* of absence, not a cryptographic proof — a
sustained targeted jam could silence a live peer; what keeps the hold safe is
that it rides the EXISTING, intact epoch-CAS + signature fence and never advances
the epoch or takes over a peer's lease — see Layer 3.) This is the durable answer
to the operator directive
(2026-06-20, topic 27515): "it shouldn't be unreachable and we should have
extremely robust communication channels between the machines."

## Goals / non-goals

**Goals**
- A peer is "unreachable" only when **every** advertised endpoint to it fails.
- Endpoints are **auto-discovered and advertised** by each machine (no manual
  per-peer URL config): Cloudflare hostname (existing), LAN IPv4 (auto), and the
  Tailscale IPv4 (auto, when `tailscale` is up).
- The fenced-lease broadcast/pull path uses hedged failover, so renewal confirms
  over **any** working rope — eliminating the flap in the common case (a single
  flaky rope) **with no authority change at all**.
- A preferred stationary captain holds its lease only when its peer is
  presumed-gone by liveness-silence (aged out of the heartbeat window), gated so a
  traveling/non-preferred machine never holds solo and a merely-unreachable-but-
  recently-alive peer still forces the conservative self-suspend — with the hold's
  safety resting on the intact epoch-CAS fence, not on the liveness signal being a
  partition oracle.

**Non-goals (this spec)**
- SSH-as-a-transport. Tailscale fills the same niche more robustly. <!-- tracked: CMT-701 (mesh robustness; SSH transport is a future rope only if operator-requested) -->
- Adopting the resolver in the OTHER machine-auth HTTP clients (live-tail,
  handoff, working-set carrier, pool fan-out, `/guards` reads). This spec wires
  the shared resolver and adopts it in the lease path (the acute stranding bug);
  broadening is separate so this stays a complete fix for the bug. <!-- tracked: CMT-705 (generalize PeerEndpointResolver to all machine-auth HTTP clients) -->
- Installing/authing Tailscale itself (an operator action). This spec consumes
  the Tailscale address when present and is a strict no-op when absent.

## Proposed design

### Layer 0 — Endpoint advertisement (each machine publishes its ropes)

Add an **ordered endpoint set** that a machine computes about ITSELF and
publishes **inside the machine-auth-signed heartbeat body** (covered by
`signRequest`'s body-hash — see Decision 10), alongside `lastKnownUrl` (retained
unchanged for back-compat). The registry entry mirror is additive and tolerated
by un-upgraded peers (Decision 11).

```ts
interface MeshEndpoint {
  kind: 'tailscale' | 'lan' | 'cloudflare';
  url: string;          // http://100.x.y.z:PORT | http://192.168.x.y:PORT | https://echo-mini.dawn-tunnel.dev
}
interface MachineRegistryEntry {
  lastKnownUrl?: string | null;   // RETAINED — equals the cloudflare endpoint url (public HTTPS)
  endpoints?: MeshEndpoint[];     // NEW — self-advertised, signed in the heartbeat body
}
```

Discovery (`MeshEndpointAdvertiser`, computed off the heartbeat-write critical
path; the heartbeat reads the last-computed value):
- **cloudflare**: the existing tunnel hostname. Always present when a tunnel is
  configured. (Priority 30 — see Decision 2.)
- **lan**: the machine's **primary** private IPv4 only (first non-internal
  RFC-1818/RFC-1918 IPv4 on the default-route `en*`/`eth*` interface) + the
  server port. (Priority 20.) A machine with no private IPv4 advertises no LAN
  endpoint. Recomputed cheaply each heartbeat (`os.networkInterfaces()`, no exec).
- **tailscale**: `tailscale ip -4` via `execFile(['ip','-4'])` (NEVER a shell
  string), accept only a single well-formed `100.64.0.0/10` CGNAT address, 3s
  bounded, fail-silent. **Cached** (re-exec at most every 10 min OR on a
  network-change signal); intervening heartbeats serve the cached value.
  (Priority 10.) Absent when Tailscale is not installed/up — a strict no-op.

  **Tailscale CLI path:** on macOS the CLI is NOT on `PATH` — it lives at
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (and `tailscale ip -4`
  works there). Detection probes a small ordered list: `PATH` → the macOS
  app-bundle path → `/usr/local/bin/tailscale`. (Found live: 2026-06-20, this
  pair runs the GUI app whose CLI is the app-bundle binary.)

### Layer 0.5 — Server must LISTEN on the mesh interfaces (live-verify finding)

**Discovered during live-verify (2026-06-20), before any failover code was
written:** the instar HTTP server binds to **`127.0.0.1` only**
(`AgentServer.ts:3427`, `host = this.config.host || '127.0.0.1'`; confirmed by
`lsof`: `TCP 127.0.0.1:4042 LISTEN`). Cross-machine traffic today works ONLY
because the Cloudflare tunnel's `cloudflared` connects to `localhost:4042`
locally and exposes it publicly. **So the advertised LAN/Tailscale endpoints
would have nothing to connect to** — `curl http://<mini-tailscale-ip>:4042/health`
returns nothing while `localhost` returns 200. The whole multi-rope design is
inert without this.

Fix: when `multiMachine.meshTransport.enabled`, the server binds to **`0.0.0.0`**
(all interfaces) instead of `127.0.0.1`, so it answers on the Tailscale + LAN
IPs. **This is NOT a new exposure:** the server is ALREADY reachable from the
entire public internet via the Cloudflare tunnel (auth-gated), so adding the
private Tailscale/LAN interfaces is strictly *less* exposure than the existing
public tunnel — and every `/api/*` mesh route stays behind the same
`machineAuthMiddleware`, the dashboard behind its PIN, the rest behind the Bearer
token. The bind is config-gated (Decision 17) so it is reversible to localhost.

### Layer 1 — Health-aware resolver (`PeerEndpointResolver`)

A new, pure/injectable (clock + health map), I/O-free module resolves a registry
entry into an **ordered, capped candidate list** plus a per-`(peer,kind)` health
record. Resolution rules:

1. **Validate each advertised endpoint's URL shape on CONSUME** (Decision 7):
   `tailscale` host must be in `100.64.0.0/10`; `lan` host must be RFC-1918 AND
   (Decision 8) on the **same subnet as one of this machine's own interfaces**;
   `cloudflare` host must match the public-HTTPS tunnel-host shape. Any endpoint
   that is link-local (`169.254/16`), loopback, metadata (`169.254.169.254`),
   `0.0.0.0`, or out-of-shape-for-its-kind is **dropped (never dialed) + logged**.
2. **Cap to `maxEndpoints` (=4)** by priority — truncating any excess a peer
   advertises (the cap is enforced here, NOT trusted from the advertiser).
3. **Order**: last-known-good first (stickiness) → then by priority
   (tailscale<lan<cloudflare). Stickiness is **latency-AND-liveness-aware**
   (Decision 5): a sticky rope whose recent EWMA latency exceeds `timeout/2`, or
   whose recent failure-rate is non-trivial (a fail-2/succeed-1 oscillator), is
   demoted; a recovered rope must be stable for K=3 cycles (hysteresis) before
   reclaiming last-known-good.
4. **Deprioritize-not-drop a dead rope** (≥3 consecutive failures → back of the
   order) but **probe it on exponential backoff** (Decision 5), not every call,
   so a sustained outage costs the healthy rope + an occasional cheap probe.
5. **Health-map keyed by `(peer, kind)`** (3 kinds — bounded); an endpoint URL
   absent from the latest advertised set is **evicted** after a TTL (Decision 4),
   so a roaming laptop's churned LAN IPs do not accumulate.

### Layer 2 — `HttpLeaseTransport` adopts hedged failover + responder-identity

`broadcast()` / `pullPeer()` change from "POST to `peer.url`" to "resolve the
peer's ordered endpoints and confirm over the first that genuinely accepts."
Concretely:

- `LeasePeer` gains `endpoints: MeshEndpoint[]`; the existing `url` stays as the
  cloudflare/`lastKnownUrl` fallback so a peer advertising no `endpoints[]` (an
  un-upgraded machine) resolves to exactly one rope and is **byte-for-byte
  today's behavior** — including its **undivided** per-attempt timeout
  (Decision 6).
- **Hedged request pattern** (Decision 3): try the last-known-good rope first; if
  it has not answered within a short **hedge delay** (default 1.5s), fire the
  remaining (validated, capped) ropes **in parallel**; the first rope that
  returns a **verified accept** wins and the losers are aborted. Common case
  (sticky rope healthy) = **one** request; failover cost = `hedgeDelay + one
  timeout`, never `N × timeout`. The per-attempt abort timeout keeps the existing
  ~30s floor (it is NOT divided by endpoint count — the hedge, not division,
  bounds the sweep; Decision 6 reconciles this with `HttpLeaseTransport`'s
  receiver-stall-envelope rationale).
- **A rope counts as "reached"/last-known-good ONLY on a verified accept**
  (Decision 9): the response must carry a machine-auth signature proving the
  responder is the **expected peer machineId**, AND (accept-ack) carry the
  receiver's resulting observed epoch confirming it actually folded the lease. A
  `2xx` from an unverified/wrong responder (a LAN-collision stranger, a
  captive-portal, a black-hole proxy, a peer mid-restart whose route is mounted
  but coordinator unwired) is treated as a **FAILED** rope — never reachable,
  never sticky. This closes the "200-OK black hole renews forever" and the
  "stranger at the same `192.168.x.x`" vectors.
- The `peers()` wiring (`server.ts:4198`) filter becomes
  `(!!lastKnownUrl || endpoints?.length)` so an endpoints-only (Tailscale/LAN, no
  tunnel) peer is **not dropped** (Decision 12). `MeshEndpointAdvertiser` runs at
  the `MachineIdentity.updateMachineUrl` write-point so `endpoints[]` is
  populated whenever `lastKnownUrl` is.
- `PeerFailureLogGate` keyed per `(peer, kind)` plus a peer-level roll-up so a
  full partition logs once at the peer level, not once per rope.

This layer is **strictly additive** (Cloudflare remains one rope) and ships
**enabled** behind `multiMachine.meshTransport.enabled` (default true).

### Layer 3 — Safe-by-construction solo-captain hold (the partition floor)

Today, when a tunnel medium is configured, `renew()` confirms ONLY via
`tunnel.broadcast()`; a holder that cannot confirm for `> leaseTtlMs`
self-suspends — and on the Echo pair (`LocalLeaseStore`, because the agent home
IS the instar source tree, so `SourceTreeGuard` refuses git sync) the
re-acquire-after-suspend inflates the epoch every cycle. The fix lets the
**preferred stationary captain** keep its lease (same epoch) — but ONLY behind a
**liveness-silence presumption that the peer is gone** (NOT a cryptographic
absence proof — see the safety note below), never the weak signals a partition
makes trivially true:

When `renew()`'s hedged medium-confirm fails across all ropes, the holder
**self-suspends as today UNLESS ALL of the following hold**:
1. **F4-AGREED preferred** (Decision 13) — this machine is the preferred-awake
   machine AND no reachable/recently-seen peer disputes or also-claims the
   preference (consume the existing F4 agreement signal + `preferredIsHealthy`,
   NOT the raw `preferredAwakeMachineId` config field). A both-set-self misconfig
   ⇒ Layer 3 does NOT engage (falls to self-suspend) and raises the existing F4
   disagreement Attention item.
2. **Peer PRESUMED-GONE BY LIVENESS-SILENCE** — every peer is in the EXISTING
   `presumedDeadHolders()` set (`lastSeen > failoverThresholdMs`): aged out of the
   heartbeat window, not merely unreachable on this tick. A peer seen within the
   window (a genuine network partition with a possibly-live peer) does **NOT**
   qualify, so the captain still self-suspends (the conservative, split-brain-safe
   direction). This is the gate that distinguishes "aged-out absent" from
   "unreachable" — the load-bearing correction.
3. **No higher epoch observed** in the last-synced effective view (a real
   takeover always wins).

When all three hold, the holder retains the **same** epoch (no re-acquire, no
inflation) and calls `markRenewOk()`. The **monotonic self-fence stays armed**
whenever (2) is not satisfied — so a merely-unreachable peer can never keep the
captain alive forever; only a liveness-aged-out one can. The local
`store.refresh()` is NOT used as evidence (it is a tautology on `LocalLeaseStore`);
the evidence is the liveness-silence absence presumption. **On any rope recovery**,
the captain
re-checks within one tick and stands down immediately if it then observes a
higher epoch.

**Safety note (what makes this safe-by-construction).** Liveness-silence is a
*presumption*, not a proof: a sustained targeted jam that silences a still-live
peer can satisfy condition (2). The hold is nonetheless safe because Layer 3 only
ever *withholds a self-suspend at the SAME epoch* — it NEVER advances the epoch,
never takes over a peer's lease, and leaves the existing epoch-CAS + signature
fence and `canAcquire()` completely untouched. So even a wrongly-presumed-gone
live peer cannot produce a second writer: to actually hold/take the lease that
peer must still win a CAS over a shared medium, and the captain stands down within
one tick of observing any higher epoch. The safety rests on the intact CAS fence,
not on the liveness signal being a partition oracle — which is why the Layer-3
live-verify (sever the peer, then return it at a higher epoch and assert one-tick
stand-down) is mandatory before enablement.

Ships **dark / opt-in** (`multiMachine.leaseSelfHeal.soloCaptainHold.enabled`,
default false; no-op when no preferred machine is set).

### Why this ordering settles the flap

With Layer 2 enabled and the machines on the same LAN (or Tailscale), the lease
confirms over the LAN/WireGuard rope the instant Cloudflare drops — so `renew()`
keeps the same epoch and the flap disappears with **no authority change**. Layer
3 is the floor for the genuinely-gone-peer case: the stationary captain holds
(rather than thrashing) only when liveness proves the traveler is actually
absent, and any real higher-epoch takeover still moves the lease. The
*epoch* flap disappears; residual renew-latency churn from a flapping rope is
bounded by the hedge delay + hysteresis (it does not inflate the epoch).

## Frontloaded Decisions

1. **Ship posture per layer.** Layers 0–2 ship **enabled** behind
   `multiMachine.meshTransport.enabled` (default true) — strictly additive,
   config-reversible. Layer 3 ships **dark + opt-in** (authority-bearing).
   *Reversible:* config flips; no durable migration.
2. **Endpoint priority.** tailscale(10) < lan(20) < cloudflare(30). Override via
   FLAT config knobs (Decision 14) — `meshTransport.priorityTailscale`, etc.
   *Reversible:* yes.
3. **Hedged, not sequential, not blind-parallel.** Last-known-good first; after a
   `meshTransport.hedgeDelayMs` (default 1500) fire the rest in parallel;
   first-verified-accept wins, losers aborted. Resolves the latency/cost tension:
   one request in the common case, `hedgeDelay+timeout` failover, bounded
   fan-out. *Reversible:* a `hedgeDelayMs: 0` restores blind-parallel; a very
   large value approximates sequential.
4. **`maxEndpoints` = 4**, enforced on RESOLVE by priority-truncation; health-map
   keyed by `(peer,kind)`; endpoints absent from the latest advertised set
   evicted after `meshTransport.endpointEvictionMs` (default 1h). *Reversible:* yes.
5. **Dead-rope handling.** Deprioritize after `unhealthyAfterFailures` (default 3)
   consecutive failures; probe on exponential backoff (cap `maxProbeBackoffMs`,
   default 5min); latency-aware demotion of a slow sticky rope (EWMA latency >
   timeout/2, EWMA smoothing factor α=0.3 over the per-`(peer,kind)` health
   record); a non-trivial recent failure-rate (the same EWMA over success/fail,
   demote above 0.25) also demotes a fail-2/succeed-1 oscillator; K=3-cycle
   recovery hysteresis. *Reversible:* tuneable.
6. **Per-attempt timeout floor preserved.** Per-attempt stays the existing
   `min(ttl/2,30s)` (NOT divided by endpoint count — the hedge bounds the sweep).
   A single-rope (un-upgraded) peer keeps the **undivided** value — no regression.
   The receiver-stall-envelope rationale in `HttpLeaseTransport.ts` is preserved.
   *Reversible:* yes.
7. **Endpoint-URL shape validation on consume.** Per-kind host validation
   (tailscale=`100.64/10`, lan=RFC-1918, cloudflare=public-HTTPS tunnel shape);
   reject link-local/loopback/metadata/`0.0.0.0`/out-of-shape → drop+log.
   *Reversible:* yes.
8. **LAN-subnet gate.** A peer's `lan` endpoint is dialed ONLY when its IP is on
   the same subnet as one of this machine's interfaces (cheap local check) — else
   skipped (avoids stranger-dialing + wasted timeouts on a different LAN).
   *Reversible:* `meshTransport.lanSubnetGate: false` to always try.
9. **Confirmation = verified, FRESHNESS-BOUND accept-ack, not raw 2xx.** A rope
   confirms only when the response is machine-auth-signed by the expected peer AND
   is bound to *this specific request* (not a recorded earlier one). **Wire format
   (pinned — both peers must agree cross-version):**
   - The caller includes a fresh **challenge** `reqNonce` in the request body of
     every `/api/lease` and `/api/lease/pull` — a cryptographically-random
     128-bit value (`crypto.randomBytes(16)`, hex-encoded), the same generator
     family + width as the existing machine-auth nonce (compared only for
     byte-equality, never re-parsed, so a width/encoding skew can never break
     interop — but it is pinned here to match the codebase precedent and set the
     RNG-source security floor).
   - The receiver folds the lease, then responds
     `{ ok, ack: { machineId, reqNonce, observedEpoch }, sig }` where `ack.reqNonce`
     **echoes the caller's challenge** and `sig` is the receiver's signature over
     the ack.
   - The caller treats the rope as confirmed ONLY when: `sig` verifies against the
     expected peer's registered key; `ack.machineId === the expected peer`;
     **`ack.reqNonce === the reqNonce it just sent`** (freshness — defeats replay
     of any recorded ack); and **`ack.observedEpoch === the epoch we sent`**
     (equality, not a `>=` floor — proves the peer folded *our current* lease). An
     `observedEpoch > sent` is NOT a confirmation — it is a higher-epoch takeover
     signal routed to the existing stand-down path.
   - **Domain separation:** request signatures and ack signatures carry distinct
     version-tagged prefixes (`mesh-req-v1|…` vs `mesh-ack-v1|…`) so the two
     signature spaces are provably disjoint and a request sig can never be
     replayed as an ack sig (Ed25519 has no built-in domain separation).
   **Fail-closed:** any response lacking a valid, fresh, epoch-equal `ack`/`sig`
   (an un-upgraded bare-200 receiver, a black-hole proxy, a stranger, a replayed
   ack) is a FAILED rope — a rolling deployment degrades to "rope not confirmed"
   (conservative), never a false confirmation. Stickiness never promotes a rope
   that did not produce a fresh verified accept-ack. *Reversible:* N/A (a
   correctness property, not a knob).
10. **`endpoints[]` is signed in the heartbeat body** (under `signRequest`
    body-hash) — NOT only in the unsigned git-replicated registry entry — so a
    peer cannot spoof another machine's dial-targets. The registry-entry mirror
    is for read convenience and is treated as untrusted unless corroborated by a
    signed heartbeat. *Reversible:* N/A (security property).
11. **Mixed-version registry tolerance.** The registry-entry parser is
    additive-tolerant: an un-upgraded machine receiving a newer entry **preserves
    unknown fields on round-trip** (never strips/re-signs), and a newer machine
    receiving an `endpoints`-less entry resolves to the single `url`. Covered by
    the §Version-skew posture test. *Reversible:* N/A.
12. **`peers()` filter** = `(!!lastKnownUrl || endpoints?.length) && !e.revokedAt`
    so an endpoints-only peer is not dropped while the existing revoked-peer
    exclusion is preserved; advertiser runs at `MachineIdentity.updateMachineUrl`.
    *Reversible:* yes (flag-gated).
13. **Layer 3 gates on F4-AGREED preferred + presumed-dead-by-liveness + no
    higher epoch**, NOT raw config / NOT `store.refresh` / NOT a blind view. The
    monotonic self-fence stays armed unless presumed-dead holds. *Reversible:*
    dark by default.
14. **Config knobs are FLAT** under `multiMachine.meshTransport.*`
    (`enabled`, `hedgeDelayMs`, `priorityTailscale|Lan|Cloudflare`,
    `tailscaleEnabled`, `lanSubnetGate`, `unhealthyAfterFailures`,
    `endpointEvictionMs`, `maxProbeBackoffMs`) to dodge the one-level-deep
    `applyDefaults` merge hazard. Startup validation: priorities distinct
    positive integers, `unhealthyAfterFailures ≥ 1`, `hedgeDelayMs ≥ 0`; a
    nonsensical combination is rejected at startup. *Reversible:* yes.
15. **`/health` shape + auth.** `multiMachine.syncStatus` gains `meshEndpoints`
    (this machine's advertised kinds) + per-peer reachable-rope **kind only** —
    raw private IPs appear ONLY on the Bearer-authed `/health` detail (4042),
    never on the unauthenticated basic `/health`. *Reversible:* additive.
16. **Tailscale detection** = `execFile([<resolved-tailscale-bin>, 'ip','-4'])`,
    single-line `100.64/10` regex, binary resolved from `PATH` → macOS app-bundle
    path → `/usr/local/bin` (`PATH`-trust accepted as equivalent to the agent's
    existing tool-exec trust, documented), cached ≥10min. *Reversible:*
    `tailscaleEnabled:false`.
17. **Server bind (Layer 0.5 — live-verify finding).** When
    `multiMachine.meshTransport.enabled`, `AgentServer` binds `0.0.0.0` instead of
    `127.0.0.1`, so peers can reach it on the Tailscale/LAN IPs. Strictly less
    exposure than the existing always-on public Cloudflare tunnel; all routes keep
    their existing auth (machine-auth on `/api/*`, PIN on dashboard, Bearer
    elsewhere). *Reversible:* `meshTransport.enabled:false` → back to `127.0.0.1`
    (one restart, since the bind host is read at `listen()` time). A config
    `meshTransport.bindHost` override is provided (e.g. pin to the Tailscale IP
    only for a stricter posture).

## Decision points touched

- `LeaseCoordinator.renew()` — adds the Layer-3 hold branch. It is a
  **signal-consumer** (consumes the EXISTING `presumedDeadHolders()` liveness set
  + the EXISTING F4 agreement signal + the EXISTING effective-view epoch signal);
  it adds **no new brittle blocking authority** — it only *withdraws* a
  self-suspend when the peer is provably gone, behind the existing fencing
  (epoch-CAS + signature). Correction from round 1: the prior draft gated on raw
  config + a tautological local-store write; this draft gates on the agreed +
  liveness signals, so it does not invent authority from unverified self-config.
- `HttpLeaseTransport.broadcast/pull` — hedged failover + responder-identity
  verification. A transport detail (which rope carries the same signed payload),
  hardened so a rope is "reached" only on a verified accept.
- **Receiver changes (accept-ack — NET-NEW on the receive side).** Decision 9's
  verified accept-ack is NOT present in today's `/api/lease` receiver, which
  returns a bare `{ ok: true }` and folds the lease ASYNCHRONOUSLY (the 200 is
  sent before the fold is confirmed) — and machine-auth today signs the REQUEST
  only, with no response-signing path. So this change requires, on the receive
  side: (a) fold the lease (an in-memory epoch-CAS + signature verify — cheap)
  synchronously, or compute the resulting effective epoch, BEFORE responding, and
  return it as `ack.observedEpoch` — any DURABLE persistence of the folded lease
  stays OFF the response path (persist async; the response carries the computed
  epoch), so a slow disk write can never block the response under the per-attempt
  timeout; (b) add a response-signing path so the receiver signs the `ack`
  (including the caller's echoed `reqNonce`, Decision 9) with its machine key
  under the `mesh-ack-v1` domain prefix — the inverse of the existing request
  `signRequest`, in a disjoint signature space. Both are net-new and must ship
  WITH the caller-side hedging — but the caller fails closed (Decision 9), so a
  receiver still on the old bare-200 path is treated as an unconfirmed rope during
  a rolling deploy, never a false confirmation.
- Endpoint advertisement — self-asserted, signed in the heartbeat body; no new
  authority (it only changes which address this machine dials). **Single
  advertiser:** `MeshEndpointAdvertiser` EXTENDS the EXISTING `MeshUrlAdvertiser`
  (which already hooks the `MachineIdentity.updateMachineUrl` write-point) — it
  is the SAME advertiser computing the endpoint set alongside `lastKnownUrl`, NOT
  a second module racing the same registry write.

## Multi-machine posture (Cross-Machine Coherence)

- **Endpoint set** — **replicated** (each machine advertises its own endpoints in
  its signed heartbeat; peers read them — the existing `lastKnownUrl`
  replication path, extended additively and signed in-body).
- **Per-endpoint health** — **machine-local BY DESIGN** (this machine's view of
  which rope works; replicating a peer's rope-health would mislead).
- **Solo-captain hold decision** — machine-local trigger reading the EXISTING
  replicated liveness/effective-view (proxied-on-read); its consequence (holding
  the lease) is the already-replicated lease record.
- **Single-machine agent**: Layer 0 advertises only its own (unused) endpoints,
  Layer 1/2 have no peers (no-op), Layer 3 has no peer to be presumed-dead
  (no-op). Strict no-op end to end.

## Version-skew posture

The pair is mixed-version during any staggered rollout. Required behavior +
tests: (a) **new ↔ old** — peer A advertises `endpoints[]`, peer B advertises
only `lastKnownUrl`; A resolves B to the single `url` and the lease confirms both
directions; B preserves A's unknown `endpoints` field on registry round-trip and
never re-signs/strips it. (b) **timeout parity** — a single-rope peer uses the
undivided per-attempt timeout (Decision 6), so an old peer sees no timing change.
A mid-rollout asymmetry must never strand the lease path.

## Security review surface

- **No new trust surface**: every rope authenticates with the same
  `signRequest`/`machineAuthMiddleware`; a LAN/Tailscale rope is not lower-auth.
- **Responder identity** (Decision 9) closes the LAN-collision / black-hole
  vectors: a rope is reachable only on a verified accept from the expected peer.
- **Self-asserted endpoints**: bounded by per-kind URL-shape validation
  (Decision 7) + the `maxEndpoints` cap (Decision 4) + signed-in-body advertise
  (Decision 10); the worst a rogue/compromised peer can do is make this machine
  attempt a bounded, validated connection that fails auth — logged, deprioritized.
- **SSRF**: endpoints are consumed only by the mesh client POSTing a signed body
  to fixed paths (`/api/lease`, `/api/lease/pull`); shape-validation rejects
  metadata/link-local; the cap bounds fan-out. No user-controlled URL.
- **Credential path (accurate restatement)**: `isPeerUrlAllowedForCredentials`
  TODAY returns `ok` for RFC-1918 / loopback hosts over plain `http` (it is
  *already* private-IP-permissive), and does NOT recognize Tailscale `100.64/10`
  as private. The credential-sync peer enumeration is therefore kept **keyed off
  the public-HTTPS cloudflare endpoint only** and the new `endpoints[]` set is
  **excluded from credential enumeration entirely** (not "excluded unless already
  passed"). A private-IP rope carries lease/heartbeat ONLY. The credential
  allowlist is otherwise untouched.

## Test plan (all three tiers)

- **Unit**: resolver ordering (latency+liveness stickiness, priority,
  deprioritize+backoff, hysteresis, eviction, `maxEndpoints` truncation,
  per-kind URL-shape reject, LAN-subnet gate); advertiser discovery (cloudflare
  always, LAN primary-IPv4, Tailscale CGNAT accept/reject + cache, all-absent);
  transport hedged failover (sticky-ok→one-request, hedge-fire→second-wins,
  all-fail→unreachable, verified-accept-required, 2xx-from-wrong-responder→FAILED,
  **replayed-recorded-ack→FAILED** (wrong `reqNonce` — freshness), **higher
  observedEpoch→stand-down-not-confirm**, single-rope undivided-timeout
  back-compat); `renew()` Layer-3 (preferred +
  presumed-dead + no-higher-epoch ⇒ hold same epoch; peer recently-seen ⇒
  self-suspend; both-set-self ⇒ no-engage + Attention; higher-epoch ⇒ stand down;
  flag-off ⇒ byte-for-byte today). **Distinguish a `GitLeaseStore`-backed from a
  `LocalLeaseStore`-backed run — do NOT mock `store.refresh→true`** (the round-1
  tautology); assert Layer 3 never relies on the store write as evidence.
- **Integration (HTTP)**: two-server harness — peer A reaches peer B over rope #2
  after #1 is forced to 502; assert the lease confirms and the epoch does NOT
  advance. A responder-identity case: a third "stranger" server on the same
  advertised IP returns `200 {}` and is rejected as unreached.
- **E2E**: feature-alive — `/health → multiMachine.syncStatus.meshEndpoints` (200,
  resolver active); per-peer reachable-rope KIND on the authed detail only.
- **Live-verify (NON-NEGOTIABLE — deterministic injected fault on the real pair)**:
  - *Layers 0–2*: with Cloudflare still flaky, force/observe the LAN (then
    Tailscale) rope carrying the lease; assert epoch **stable ≥15 min** (no flap),
    evidence = timestamped `/health` from **both** machines.
  - *Layer 3*: **physically sever the Laptop** (kill its instar — a real absence,
    not a throttled rope); assert the Mini holds the SAME epoch solo ≥30 min with
    no self-suspend and no inflation; then **bring the Laptop back at a higher
    epoch** and assert the Mini stands down within one tick. Plus the
    both-set-self divergence live case (Layer 3 does not engage). This honors the
    [[live-verify-multimachine]] standard (synthetic symmetric-state tests give
    false confidence; force the real asymmetry).

## Rollback

- Layers 0–2: `multiMachine.meshTransport.enabled:false` → peers resolve to the
  single `lastKnownUrl` (today's behavior). Read live where practical; else one
  session restart. Previously-advertised `endpoints[]` remain inertly in the
  registry until the next heartbeat overwrites them — never read while off.
- Layer 3: `multiMachine.leaseSelfHeal.soloCaptainHold.enabled:false` (default) → `renew()` is
  byte-for-byte today's self-fence. No state to repair.

## Migration parity

- `multiMachine.meshTransport.*` (FLAT knobs, Decision 14) +
  `leaseSelfHeal.soloCaptainHold` added to `ConfigDefaults`; `applyDefaults`
  add-missing onto existing agents without clobbering operator values; startup
  validation rejects nonsensical combinations.
- `DARK_GATE_EXCLUSIONS` entry verbatim:
  `{ configPath: 'multiMachine.leaseSelfHeal.soloCaptainHold.enabled',
  category: 'action-bearing', reason: 'retains the awake lease (a live authority
  change) when the sole peer is presumed-dead; preferred-awake + liveness gated;
  MUST be live-verified on the real Mini+Laptop pair before enablement.' }`. The
  `meshTransport.enabled:true` default needs no lint entry (the lint targets
  `enabled:false`); stated explicitly. The lint golden-path map is updated by hand.
- **Agent Awareness (required)**: add a `generateClaudeMd()` paragraph + a
  content-sniffed `migrateClaudeMd()` migration covering the new
  `/health → multiMachine.syncStatus.meshEndpoints` read, the proactive trigger
  ("why is my machine unreachable / why does the lease flap?"), and the
  `meshTransport.enabled` kill-switch — so deployed agents can surface it.
- `/health` field is additive (Decision 15); concrete edit site
  `MultiMachineSyncStatus` + `getSyncStatus()`.

## Open questions

*(none)*
