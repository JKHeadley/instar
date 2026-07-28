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
review-convergence: "2026-07-02T07:40:47.428Z"
review-iterations: 4
review-completed-at: "2026-07-02T07:40:47.428Z"
review-report: "docs/specs/reports/u4-3-breaker-recovery-probe-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 2
approved: true
approved-basis: "Operator preapproval for spec approvals in this session (topic 29836, 2026-07-02): 'Full preapproval granted … spec approvals, server restarts, deployment, and all in-scope reversible decisions.' Recorded transparently, not silently self-granted."
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

**The real starvation mechanism is hedge-winner-abort — and it has TWO arms
(R-r2-1).** `HttpLeaseTransport.hedge()` fires `endpoints[0]` (the healthy
last-known-good rope) immediately and cancels the rest as soon as it confirms inside
`hedgeDelayMs` (1500ms). Arm one: a dead rope sorted behind a healthy one is
**never actually dialed** — its `recordResult` never fires, so the existing
probe-due machinery is permanently starved despite constant traffic. Arm two
(round-2 grounding): when a recovering rope IS dialed as a hedge loser,
`finish()` aborts it via `controller.abort()` and the attempt's catch block
**unconditionally records `recordResult(..., false)`** (HttpLeaseTransport.ts —
the catch does not distinguish an AbortError caused by the winner from a real
dial failure). A recovering rope dialed as a hedge loser therefore gets its
`recoveryStreak` **reset perpetually by its healthy sibling's win**. That is how
a healed Tailscale rope stayed presumed-dead for a week, and it is a "Verify the
State, Not Its Symbol" violation: the dead symbol is never re-verified — and when
it is, the verification is poisoned by the abort.

## 2. Design — ONE health authority; an in-process pinned probe feeds it

**No second state machine.** The probe drives the EXISTING `HealthRecord` through the
EXISTING `recordResult()` — one source of truth, the shipped hysteresis
(`RECOVERY_HYSTERESIS = 3`; round 0's N=2 is DROPPED in favor of the shipped value),
the shipped EWMA demotion. The spec's job is only to guarantee dead ropes actually
get dialed.

- **REQUIRED transport fix — hedge-abort must stop recording failure (R-r2-1).**
  `HttpLeaseTransport`'s attempt catch must distinguish an AbortError caused by
  the hedge winner's `finish()` from a real dial failure: an abort-after-winner
  records **neutrally (or not at all)** — never `recordResult(false)`. Without
  this fix the probe is fighting the transport (every lease tick's winning rope
  re-poisons the loser's streak the probe just built). This fix is a deliverable
  of U4.3 and **also benefits U4.4** (fewer spurious health-window resets in the
  hand-back reconciler's reachability source) **and U4.5** (less classification
  noise in the rope-health monitor).
- **Carrier: the existing lease pull tick** (~5s, jittered, already running on every
  machine). On each tick, the server checks for probe-eligible (peer, kind) records
  (predicate below) whose probe-layer due gate has elapsed and whose kind has **no
  probe already in flight** (single in-flight per (peer, kind) — a CAS on a small
  in-memory set). No new scheduler, no new loop, near-zero marginal cost.
- **Probe-selection is EPISODE-scoped — no limbo, no free-running cadence
  (R-r2-2, corrected by R-r3-1/R-r3-2).** A dead-only selector is inconsistent
  with the close semantics: `recordResult(ok)` clears `consecutiveFailures` to 0
  on the FIRST success, so a dead-only selector stops probing at
  `recoveryStreak = 1 < 3` and starvation resumes. Round 3 then broke the
  round-2 predicate `dead OR (recoveryStreak > 0 && !lastKnownGood)` two ways:
  (a) LIMBO — one probe failure after dead-clear sets `recoveryStreak = 0,
  consecutiveFailures = 1` (< dead threshold), making BOTH branches false: the
  probe stops, the hedge still never dials it, and the rope can never re-die —
  permanent re-strand; (b) CADENCE — a mid-recovery rope has trivially-true
  `isProbeDue` (zero failures), and the P19 floor engages only on FAILURES, so a
  slow-but-alive rope whose EWMA latency blocks `lastKnownGood` reclaim would be
  probed every ~5s tick forever (~17k/day, the 2026-06-05 shape) while every
  probe SUCCEEDS. **The corrected mechanism is a probe EPISODE:** an episode
  OPENS when a rope goes dead; while an episode is open, the rope is
  probe-eligible regardless of the dead flag's momentary state (closing both
  limbo arms — a fail-after-partial-recovery stays in-episode); the episode
  CLOSES when the rope reclaims `lastKnownGood` (traffic takes over) or on the
  explicit exhaustion path. Within an episode the probe layer owns the cadence
  in BOTH health states: `recoveryProbeMidIntervalMs` (default 45s) is the
  mid-recovery due interval (never the resolver's trivially-true 5s), and after
  `recoveryProbeMaxUnreclaimedSuccesses` (default 20) consecutive successful
  probes WITHOUT `lastKnownGood` reclaim (the slow-but-alive case) the episode
  drops to the same `probeFloorMs` floor cadence as the failure path, with the
  same escalate-once item ("rope <kind> to <nickname> answers probes but stays
  demoted — latency above the reclaim bar"). Bounded: per-(peer,kind) in-flight
  CAS + episode-owned cadence + both floors; state space at most peers × kinds.
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
- **Result feeding + close semantics, corrected to match the code (R-r2-3):**
  success → `recordResult(ok)`; failure → `recordResult(fail)` (widening the
  existing backoff). **"Close" = the dead flag clears on the FIRST typed success**
  (`consecutiveFailures` → 0 — that is what the shipped code does; round 1's
  "close at the hysteresis threshold" was wrong). `RECOVERY_HYSTERESIS = 3` gates
  only the `lastKnownGood` reclaim, and the EWMA fail-rate (α = 0.3,
  `FAILRATE_DEMOTE = 0.25`) delays that reclaim further — from failure saturation
  (ewmaFailRate ≈ 1.0) successive successes yield 0.70 → 0.49 → 0.34 → 0.24, so
  `lastKnownGood` typically lands on the **~4th** consecutive success. The spec
  deliberately leaves the `lastKnownGood` reclaim to the shipped hysteresis + EWMA
  (no new thresholds). The `rope-recovered` log breadcrumb **keys on the dead-flag
  clearing** (the close event) — not an alert (U4.5 owns user-facing rope
  messaging). Latency is recorded on every probe success so a slow-but-alive rope
  still demotes via EWMA.
- **Half-recovered flap damping (episode brake):** if a rope recovered by probe goes
  dead again within `recoveryProbeReopenEpisodeWindowMs` (default 10 min), that
  counts as a probe FAILURE for backoff purposes — repeated
  probe-close→traffic-open episodes widen toward the floor instead of cycling hot.
  (Catches the small-probe-passes / big-payload-fails asymmetry.)
- **Probe-layer scheduling state, declared explicitly (R-r2-4).** The probe layer
  keeps its OWN small per-(peer, kind) scheduling state — `lastProbeAt`, the
  reopen-episode marker, and (dry-run only) a shadow recovery-streak — and holds
  **SCHEDULING state ONLY**: health truth lives solely in the resolver's
  `HealthRecord` (the one-health-authority claim survives). Three consequences:
  (a) the due predicate binds on the probe layer's own `lastProbeAt` in **BOTH**
  modes — in dry-run the `HealthRecord` is never mutated, so a predicate built
  only on the resolver's `isProbeDue` would fire a probe on every ~5s tick
  forever; the P19 floor/backoff applies **in dry-run too**, enforced by the
  probe-layer state. (b) The episode brake is probe-layer state that OVERRIDES
  `isProbeDue`: after a probe-close→re-death within
  `recoveryProbeReopenEpisodeWindowMs`, the probe layer's widened backoff wins
  even though the freshly-reset `HealthRecord` would say "due". (c) Dry-run
  would-close logging is computed from the shadow recovery-streak (the real
  record is untouched by design).

**Bounded forever-probing — the Eternal-Sentinel exemption (P19), explicitly
invoked.** A permanently-dead rope must NOT stop being probed (a hard stop would
recreate the healthy-but-presumed-down incident this spec exists to close — the
probe is a critical healer). Instead it declares the constitution's Eternal-Sentinel
exemption and satisfies all four conditions: (1) declared in code as an eternal
sentinel; (2) healer-role justification (restores mesh reachability the lease layer
depends on); (3) a capped floor rate with constant, honestly-stated per-attempt
cost — after `exhaustAttempts` (default 20) consecutive failures the cadence caps
at `probeFloorMs` (default 15 min; ~96 probes/day/rope worst case, one small
signed RPC each). **Receiver-side cost, stated honestly (R-r2-5):** each probe
refusal lands **bounded, rotated receiver-side rows** — one row in the peer's
`mesh-rejections.jsonl` (2MB rotate, `meshRejectionLog.ts`) and the rotated
SecurityLog — plus a TTL'd nonce burn in the peer's nonce store. Bounded and
rotation-capped, but not "no log growth" (round 1's claim corrected); (4)
**escalate ONCE** at the exhaustion
threshold: a single deduped attention item per (peer, kind, episode) — "rope
<kind> to <nickname> has failed N recovery probes; probing continues at floor rate"
— and a `probe-exhausted` marker on the health surface. Re-arming (any success)
clears exhaustion and re-enables the normal backoff.

**Probe dial path — never the router-forward funnel (R-r2-5).** The probe dials
the pinned endpoint via `MeshRpcClient` **directly**, never through the
router-forward `deliverMessage` funnel that live traffic rides — so the peer's
`SenderRejectionNoticer` can never fire a user-facing "message not delivered —
sender not recognized" notice for an expected probe refusal. The refusal stays a
typed, machine-consumed signal; the user never hears about a healthy probe.

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
  never sit silently off. **The entry declares `soakWindowDays` +
  `declaredLoadBearingAt` (R-r2-6)** — the manifest constants that make the
  day-one dev dry-run posture classify `loadBearingSoaking` (a guard graduating
  within its bounded soak window), not an instant `loadBearingGap` alarm on the
  day it ships.

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
  `recoveryProbeReopenEpisodeWindowMs` (default 600000 — renamed from round 1's
  bare `reopenEpisodeWindowMs` for flat-namespace prefix consistency with its
  siblings; R-r2-6), `recoveryProbeMidIntervalMs` (default 45000 — the
  mid-recovery episode cadence, R-r3-2), `recoveryProbeMaxUnreclaimedSuccesses`
  (default 20 — the slow-but-alive success-path bound before floor cadence,
  R-r3-2).
- **Registry entry (explicit build deliverable — R-r2-6):** a `DEV_GATED_FEATURES`
  entry for `multiMachine.meshTransport.recoveryProbeEnabled` with a written
  justification: the probe's only egress is the **deduped escalate-once**
  attention item per (peer, kind, episode) — bounded, episode-keyed user-facing
  output, the same posture as the `degradationLadderNeverSilent` precedent
  already in that registry — so it is safe AND runnable live-on-dev (dry-run)
  rather than an action-bearing `DARK_GATE_EXCLUSIONS` case.
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

Unit: probe-eligibility selection is EPISODE-scoped (opens on dead; stays
eligible through fail-after-partial-recovery — the limbo case `recoveryStreak=0,
consecutiveFailures=1, !lastKnownGood` MUST remain probed; closes only on
`lastKnownGood` reclaim or exhaustion; R-r3-1); mid-recovery cadence owned by the
probe layer (`recoveryProbeMidIntervalMs`, never the resolver's 5s; the
slow-but-alive rope drops to floor cadence after
`recoveryProbeMaxUnreclaimedSuccesses` successes with the escalate-once item —
a simulated day stays under the bound in BOTH the all-fail and
all-succeed-never-reclaim arms; R-r3-2);
single-in-flight CAS; **hedge-abort neutrality** (an AbortError-after-winner does
NOT record failure; a real dial failure still does — both sides, R-r2-1);
typed-contract success classifier — **registered parser with captured
byte-for-byte fixtures** of real MeshRpc responses (typed refusal, untyped 2xx,
malformed, unsigned — Scrape/Parser Fixture Realness); result feeding advances the
REAL `recoveryStreak` (**dead clears on the FIRST typed success; `lastKnownGood`
reclaim at streak 3, and only ~4th success from EWMA fail-rate saturation** —
R-r2-3, replacing round 1's wrong "close at 3, not 2"); the `rope-recovered`
breadcrumb fires on dead-clear; **dry-run scheduling honesty** (with the
HealthRecord never mutated, the probe-layer `lastProbeAt` gate still enforces
backoff + the P19 floor — no every-tick probing; R-r2-4); episode brake widens
backoff and overrides `isProbeDue`; exhaustion → floor cadence + ONE deduped
escalation; re-arm on success. Integration:
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
   machine.** Close semantics match the code (R-r2-3): the dead flag clears on the
   FIRST typed success; the shipped `RECOVERY_HYSTERESIS = 3` gates only the
   `lastKnownGood` reclaim, further delayed by the shipped EWMA (α=0.3,
   `FAILRATE_DEMOTE=0.25` → reclaim ~4th success from saturation). Round 0's N=2
   dropped. Two hysteresis machines on one rope is how flap loops are born. The
   probe layer holds SCHEDULING state only (`lastProbeAt`, episode markers,
   dry-run shadow streak — R-r2-4).
2. **The fix targets hedge starvation — both arms (R-r2-1):** an in-process pinned
   dial on the lease-tick carrier (rope-pinning is a sender-side dial choice — no
   wire change), PLUS the required transport fix so an AbortError-after-winner
   never records failure (also de-noises U4.4's health windows and U4.5's
   classification).
3. **Probe success = the exact typed G4 payload contract** (signed, bogus-uid, typed
   refusal); any-2xx never closes. The agent-home canary SCRIPT is not a dependency —
   the shared piece is the payload contract in the MeshRpc layer. The probe dials
   via `MeshRpcClient` directly, never the router-forward funnel — an expected
   probe refusal can never surface a user-facing sender-rejection notice (R-r2-5).
4. **P19 via the Eternal-Sentinel exemption** (declared; capped floor 15 min;
   escalate-once per episode; constant per-attempt cost — with receiver-side cost
   stated honestly as bounded rotated log rows + TTL'd nonce burn, R-r2-5) — never
   a hard stop, never silent spin. The floor applies in dry-run too (R-r2-4).
5. **Dry-run sends real probes** (harmless by contract) and logs would-close from a
   probe-layer shadow streak without mutating health — real soak signal from day
   one, with the same backoff/floor brakes as live mode (R-r2-4).
6. **Maturation Path compliance:** live-on-dev (dry-run) day one via the dev gate
   (named `DEV_GATED_FEATURES` entry with the deduped escalate-once justification,
   citing the `degradationLadderNeverSilent` precedent — an explicit build
   deliverable, R-r2-6); named graduation criteria; G3 loadBearing registration
   with `soakWindowDays` + `declaredLoadBearingAt` declared (day-one posture =
   `loadBearingSoaking`, R-r2-6) and the playbook as the recorded interim
   fallback.
7. **`/health` rope-health snapshot lands in the AUTHED branch only** — mesh topology
   is never exposed unauthenticated. This snapshot is U4.5's hard dependency; U4.3
   builds first.
8. **In-memory volatility accepted and declared** — restart re-probes from scratch;
   fail direction is more probing.

## Open questions

None.
