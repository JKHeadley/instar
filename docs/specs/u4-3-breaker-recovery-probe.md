---
title: "U4.3 — Traffic-Independent Rope-Health Recovery Probe (drive the real resolver, fix hedge starvation)"
slug: "u4-3-breaker-recovery-probe"
author: "echo"
status: "draft"
parent-principle: "Verify the State, Not Its Symbol"
sibling-principles: "The Agent Is Always Reachable — A Guaranteed Reachability Floor; Runtime End-to-End Proof; No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes (via the Eternal-Sentinel exemption); Maturation Path — Every Feature Ships Enabled on Developer Agents"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; multi-transport-mesh-comms.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "PeerEndpointResolver (src/core/PeerEndpointResolver.ts — the REAL per-(peer,kind) health primitive: consecutiveFailures/unhealthyAfterFailures dead-marking, RECOVERY_HYSTERESIS=3, FAILRATE_DEMOTE EWMA, isProbeDue exponential backoff base 5s capped at maxProbeBackoffMs); HttpLeaseTransport.hedge (src/core/HttpLeaseTransport.ts — the hedge-winner-abort this spec fixes); MeshRpcDispatcher deliverMessage contract (the G4 canary PAYLOAD contract — signed bogus-uid probe answered by a TYPED refusal); MultiMachineCoordinator lease pull loop (the free ~5s carrier); guardManifest (G3 loadBearing classification, PR #1318)"
---

# U4.3 — Traffic-Independent Rope-Health Recovery Probe

## 1. Problem — corrected by round-1 review

**What round 0 believed:** each rope has a circuit breaker that OPENs on failure and
only CLOSEs when chance traffic succeeds; a quiet mesh starves recovery.

**What the code actually does (round-1 grounding):** there is NO breaker object. The
real primitive is `PeerEndpointResolver`'s in-memory per-(peer, transport-kind)
`HealthRecord`: a rope is marked **dead** at `consecutiveFailures >=
unhealthyAfterFailures`, which sinks it in the dial ORDER (it remains dialable);
`isProbeDue` already schedules dead-rope re-attempts on exponential backoff (base 5s,
capped at `maxProbeBackoffMs`); recovery needs `RECOVERY_HYSTERESIS = 3` consecutive
successes plus EWMA latency/fail-rate demotion. And the mesh is **never quiet** — the
lease pull loop dials peers every ~5s regardless of user traffic.

**The real starvation mechanism is hedge-winner-abort.** `HttpLeaseTransport.hedge()`
fires `endpoints[0]` (the healthy last-known-good rope) immediately and cancels the
rest as soon as it confirms inside `hedgeDelayMs` (1500ms). A dead rope sorted behind
a healthy one is therefore **never actually dialed** — its `recordResult` never fires,
so the existing probe-due machinery is permanently starved despite constant traffic.
That is how a healed Tailscale rope stayed presumed-dead for a week, and it is a
"Verify the State, Not Its Symbol" violation: the dead symbol is never re-verified.

## 2. Design — ONE health authority; an in-process pinned probe feeds it

**No second state machine.** The probe drives the EXISTING `HealthRecord` through the
EXISTING `recordResult()` — one source of truth, the shipped hysteresis
(`RECOVERY_HYSTERESIS = 3`; round 0's N=2 is DROPPED in favor of the shipped value),
the shipped EWMA demotion. The spec's job is only to guarantee dead ropes actually
get dialed.

- **Carrier: the existing lease pull tick** (~5s, jittered, already running on every
  machine). On each tick, the server checks for dead-marked (peer, kind) records whose
  `isProbeDue` backoff has elapsed and whose kind has **no probe already in flight**
  (single in-flight per (peer, kind) — a CAS on a small in-memory set). No new
  scheduler, no new loop, near-zero marginal cost.
- **The probe is an in-process pinned dial.** Rope-pinning is a SENDER-SIDE dial
  choice (dial that endpoint's URL directly, bypassing hedge selection) — **no wire
  change, no new envelope field, no version-skew concern**. The probe reuses the G4
  canary **payload contract** (a signed, bogus-uid `deliverMessage`; the peer answers
  a TYPED refusal per its role) but runs **inside the server process** so the result
  can reach the in-memory `HealthRecord` — the out-of-process
  `delivery-canary.mjs` script has no path to it. (The agent-home script is NOT a
  dependency of this feature; the shared piece is the payload contract, which lives
  in the MeshRpc layer both use.)
- **Probe success is the exact typed contract, never any-2xx.** Success = transport
  connect + signed envelope verified + the peer's TYPED response
  (`refused:not-router` / `ack:sender-rejected` per role). A malformed, unsigned, or
  untyped 2xx (captive portal, wrong server) records as FAILURE. A typed refusal here
  is conformant with "A Refusal Stays a Refusal" — it stays typed and expected.
- **Result feeding:** success → `recordResult(ok)` (advancing `recoveryStreak`
  toward the shipped hysteresis; latency recorded so a slow-but-alive rope still
  demotes via EWMA); failure → `recordResult(fail)` (widening the existing backoff).
  Recovery emits a `rope-recovered` log breadcrumb — not an alert (U4.5 owns
  user-facing rope messaging).
- **Half-recovered flap damping (episode brake):** if a rope recovered by probe goes
  dead again within `reopenEpisodeWindowMs` (default 10 min), that counts as a probe
  FAILURE for backoff purposes — repeated probe-close→traffic-open episodes widen
  toward the floor instead of cycling hot. (Catches the small-probe-passes /
  big-payload-fails asymmetry.)

**Bounded forever-probing — the Eternal-Sentinel exemption (P19), explicitly
invoked.** A permanently-dead rope must NOT stop being probed (a hard stop would
recreate the healthy-but-presumed-down incident this spec exists to close — the
probe is a critical healer). Instead it declares the constitution's Eternal-Sentinel
exemption and satisfies all four conditions: (1) declared in code as an eternal
sentinel; (2) healer-role justification (restores mesh reachability the lease layer
depends on); (3) a capped floor rate with constant per-attempt cost — after
`exhaustAttempts` (default 20) consecutive failures the cadence caps at
`probeFloorMs` (default 15 min; ~96 probes/day/rope worst case, one small signed
RPC each, no log growth per attempt); (4) **escalate ONCE** at the exhaustion
threshold: a single deduped attention item per (peer, kind, episode) — "rope
<kind> to <nickname> has failed N recovery probes; probing continues at floor rate"
— and a `probe-exhausted` marker on the health surface. Re-arming (any success)
clears exhaustion and re-enables the normal backoff.

## 3. Observability + surfaces

- **`GET /health` (authed branch ONLY — mesh topology is not for anonymous
  callers):** `multiMachine.syncStatus` gains `ropeHealth`: per (peer, kind) —
  `{ state: healthy|dead|exhausted, consecutiveFailures, recoveryStreak,
  lastResultAt, lastProbeAt, nextProbeDueAt }`, served from a new read seam
  `PeerEndpointResolver.snapshot()` threaded through `MultiMachineCoordinator`
  (new plumbing, named: the resolver instance is currently a closure-local in
  `server.ts` — it gains a registration handle). This surface is also **U4.5's hard
  data dependency**.
- **State volatility, declared:** rope health (and probe/exhaustion counters) are
  in-memory, process-lifetime. A server restart re-probes from scratch; a
  crash-looping server never reaches exhaustion. Accepted — the fail direction is
  more probing, not less.
- **Feature metrics** (Observable Intelligence; key `rope-recovery-probe`): probes
  sent, closes, failures, exhaustion trips, dry-run would-probe/would-close counts.
- **guardManifest (G3):** entry for the flag with `loadBearing: true`,
  `criticalPath: "mesh reachability recovery"` — this is a guard for a live incident
  class, so a dark/stalled state must classify as `loadBearingGap`/`loadBearingSoaking`,
  never sit silently off.

## 4. Multi-machine posture (mandatory)

Per-(local machine, peer, transport); each machine probes its OWN dead ropes from its
OWN side — **machine-local BY DESIGN**, no replication (a probe result is only
meaningful from the machine that sent it). Asymmetric failures are diagnosed by
reading each machine's own authed `/health`. Single-machine install: no peers, no
dead ropes, strict no-op.

## 5. Config, rollout, migration

- **Config (flat keys, matching the existing `multiMachine.meshTransport` flat-knob
  convention):** `multiMachine.meshTransport.recoveryProbeEnabled` (dev-gated:
  OMITTED from shipped config so the developmentAgent gate resolves it — LIVE on dev
  agents in dry-run from day one, dark on the fleet; this is the ratified Maturation
  Path first rung, correcting round 0's dark-everywhere ladder),
  `recoveryProbeDryRun` (default true — dry-run SENDS real probes and logs
  would-close verdicts but never mutates the HealthRecord; sending is harmless by the
  typed-refusal contract and gives real soak signal), `recoveryProbeFloorMs`
  (default 900000), `recoveryProbeExhaustAttempts` (default 20),
  `reopenEpisodeWindowMs` (default 600000).
- **Graduation criteria (named):** ≥7 days on the dev pair with zero false closes
  (a close immediately followed by traffic failure) and ≥1 live verified recovery →
  `dryRun:false` on dev → fleet default per the dev-gate flip convention. Interim
  manual fallback (the captain-flip playbook) is recorded as the operator-accepted
  fallback via the G3 accept mechanism if graduation stalls.
- **Migration parity:** config defaults via `migrateConfig` existence-checks;
  CLAUDE.md template gains the proactive trigger ("why did a dead rope come back by
  itself?" → the recovery probe; read /health ropeHealth) via `migrateClaudeMd`.
- **Rollback:** `recoveryProbeEnabled:false` → no probes; behavior reverts to
  today's hedge-starved ordering. Because the probe only ever feeds
  `recordResult`, rollback leaves no orphan state (the HealthRecord is the same
  store traffic feeds).

## 6. Tests (tiers declared)

Unit: probe-due selection (dead + backoff elapsed + no in-flight); single-in-flight
CAS; typed-contract success classifier — **registered parser with captured
byte-for-byte fixtures** of real MeshRpc responses (typed refusal, untyped 2xx,
malformed, unsigned — Scrape/Parser Fixture Realness); result feeding advances the
REAL `recoveryStreak` (close at 3, not 2); episode brake widens backoff;
exhaustion → floor cadence + ONE deduped escalation; re-arm on success. Integration:
authed `/health` carries `ropeHealth` snapshot through the real HTTP pipeline;
unauthed callers never see it; feature-metrics rows recorded. E2E lifecycle
(feature-alive): production init path with the flag dev-resolved → prober wired and
ticking (`lastProbeAt` advances on a dead rope); dark → fields absent, zero probes.
Wiring-integrity: the prober is constructed and started by the real server boot
(not dead code), and `recordResult` calls reach the same resolver instance the
transport uses. P19 sustained-failure: a permanently-refusing rope for a simulated
day stays under the declared attempt/cost bound. Live two-machine drive (per the
multi-transport live-verify posture, before fleet): kill one rope on the dev pair
(tailscale logout), verify degradation; restore it; verify the probe — not chance
traffic — closes it (assert via `lastProbeAt`/metrics), within the backoff bound.

## Frontloaded Decisions

1. **Drive the EXISTING `HealthRecord` via `recordResult` — no second breaker/state
   machine.** The shipped `RECOVERY_HYSTERESIS = 3` is the close threshold (round 0's
   N=2 dropped). Two hysteresis machines on one rope is how flap loops are born.
2. **The fix targets hedge starvation:** an in-process pinned dial on the lease-tick
   carrier; rope-pinning is a sender-side dial choice — no wire change.
3. **Probe success = the exact typed G4 payload contract** (signed, bogus-uid, typed
   refusal); any-2xx never closes. The agent-home canary SCRIPT is not a dependency —
   the shared piece is the payload contract in the MeshRpc layer.
4. **P19 via the Eternal-Sentinel exemption** (declared; capped floor 15 min;
   escalate-once per episode; constant per-attempt cost) — never a hard stop, never
   silent spin.
5. **Dry-run sends real probes** (harmless by contract) and logs would-close without
   mutating health — real soak signal from day one.
6. **Maturation Path compliance:** live-on-dev (dry-run) day one via the dev gate;
   named graduation criteria; G3 loadBearing registration with the playbook as the
   recorded interim fallback.
7. **`/health` rope-health snapshot lands in the AUTHED branch only** — mesh topology
   is never exposed unauthenticated. This snapshot is U4.5's hard dependency; U4.3
   builds first.
8. **In-memory volatility accepted and declared** — restart re-probes from scratch;
   fail direction is more probing.

## Open questions

None.
