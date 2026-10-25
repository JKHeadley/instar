---
title: Trustworthy machine load, a reserved mesh floor, and overload-triggered work movement
status: approved
review-convergence: "2026-10-25T21:16:00Z"
review-iterations: 3
review-reviewers: GPT-6 Astra (codex), Gemini 4 Argon (cross-model), echo (internal)
approved: true
approved-by: Justin
approved-via: "Telegram topic 10000000832 (2026-10-25 14:19 PDT): 'great! Yes please proceed.' in reply to the posted plan and spec link."
eli16-overview: trustworthy-machine-load-and-mesh-floor.eli16.md
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
parent-principle-fit: "One agent across machines must hold an honest view of each machine under degraded conditions: an overloaded peer must not be reported as dead, a restart must not erase what was known, and relayed or saved evidence must carry its real age. P1 makes that view evidence-derived and bounded; P2–P4 keep the agent reachable and move work under the same coherence rules."
author: echo
date: 2026-10-25
issue: docs/issues/stale-machine-claims-and-overload.md
reviews:
  - docs/specs/reports/trustworthy-machine-load-review-r1-astra.md
  - docs/specs/reports/trustworthy-machine-load-review-r1-argon.md
  - docs/specs/reports/trustworthy-machine-load-review-r2-astra.md
  - docs/specs/reports/trustworthy-machine-load-review-r2-argon.md
  - docs/specs/reports/trustworthy-machine-load-review-r3-astra.md
  - docs/specs/reports/trustworthy-machine-load-review-r3-argon.md
---

# Trustworthy machine load, a reserved mesh floor, and overload-triggered work movement

## 1. Problem (the 2026-10-25 incident)

At 13:50 PDT the Mac Studio told Justin the Mama PC had been "offline since Oct 23". The Mama PC
was running and, by Justin's account, overloaded. What the Studio could actually establish was
*impaired reachability*: from 19:42Z to 20:36Z its lease pulls to the Mama PC alternated between
"unconfirmed" replies, timeouts and recoveries, and afterwards TCP connected and was then reset.
Overload is the likely cause; a broken Windows→WSL port forward cannot be excluded from the
Studio's evidence alone. The defects:

1. **No "unknown" state.** `MachinePoolRegistry.assemble()` (`src/core/MachinePoolRegistry.ts:345`)
   sets `online = live && age < failoverThresholdMs`. After the Studio server restarted (~20:38Z)
   it had no in-memory observation of the Mama PC, so `GET /pool` showed `online:false` with no
   time. "Never heard since boot" and "confirmed dead" are indistinguishable. The Mac Mini *had*
   heard from it at 20:35:47Z (load average 11.5); nothing surfaces that.
2. **Receipt time is not evidence time.** The coarse git-heartbeat loop (`server.ts` ~20868)
   re-records each peer's git-synced beat every 30 s, which refreshes `routerReceivedAtMs`.
   A git beat up to an hour old can therefore keep a peer "online"; and "since Oct 23" came from
   the same kind of record (`registry.json` `lastSeen`). The rope-health digest says
   "offline — expected (its heartbeat stopped)" on equally indirect evidence.
3. **The load signal is one raw number, and it flickers.** The self beat records only
   `os.loadavg()[0]`; `PeerPresencePuller` (`:287`) forwards only `loadAvg`. A coarse beat
   *replaces* the stored observation and carries forward posture, coherence and flags, but not
   `loadAvg`, so a peer's load appears and disappears depending on which write was last.
   `memPressure`, `activeSessionCount` and `maxSessions` exist on `MachineCapacity` and are never
   filled. `PlacementExecutor.score()` compares raw load averages across different core counts
   and scores an unknown load as `0` (the best target). Peer `hardware` is null because it only
   arrives through the git-synced registry.
4. **No overload protection or movement.** `RebalancePlanner` is dormant (not wired, and it
   omits the channel when deciding a target, CMT-1568). Nothing reserves capacity on a machine
   so it keeps answering the mesh. Stale-owner release force-claimed about ten Mama PC topics
   at 20:48Z, which is a reasonable outcome, but every notice described the owner as gone.

At the time of writing the Laptop's load average is 64 and its `/pool` did not answer in 15 s.

## 2. Goals and phases

- G1. Never state a machine's state without evidence age and source; "unknown" is a real answer.
- G2. Each machine publishes a load report from several independent signals, so the pool can
  tell busy from overloaded from impaired.
- G3. Each machine keeps headroom so it can keep answering mesh requests and so one recovery
  session can always start.
- G4. A machine that stays overloaded stops accepting new work, and movable work moves off it,
  in bounded, audited steps.

**Phases** (each ships and is verified before the next starts):
- **P1 — honest evidence** (Part A) and the **load report** (Part B1–B2). Reporting only.
- **P2 — admission**: overload closes a machine to new work; reserved headroom (Part C).
- **P3 — movement** (Part D), after failure-mode tests through production wiring.
- **P4 — model assessment** (Part B4), shadow-first, advisory.

Non-goals: new transports; a separate mesh-responder process; changing the stale-owner-release
evidence bar.

## 3. Part A — Honest evidence (P1)

**A1. Three evidence slots per peer, never merged.** `MachinePoolRegistry` keeps, per peer:
- `lastDirectSuccess` — a successful pull/beat *from that machine*: origin time (sender clock),
  receipt time (our clock), boot id + report sequence.
- `lastDirectFailure` — the latest failed attempt and its shape: `timeout`, `partial`
  (unconfirmed), `reset`, `refused`, `no-route`.
- `relayed` — evidence from git-synced beats or the durable store, always shown with its
  *original* age. Re-reading a cache, the disk or git never makes evidence younger.

**A2. A derived `liveness` field** for display, with fixed precedence:
- `live` — `lastDirectSuccess` receipt within `failoverThresholdMs`.
- `unreachable` — attempts are failing and the last success is older than that; the failure
  shape is shown (`struggling` if timeouts/partials are interleaved with successes in the
  window, `refusing` for resets/refusals, `silent` for no route).
- `stale` — only relayed or durable evidence; shown with its age.
- `unknown` — no evidence from any slot.

"Offline" is said only with positive evidence (graceful-shutdown announcement or the sleep
gate). **The existing `online` field and every placement and ownership decision keep their
current semantics in P1.** Moving them onto direct evidence is a separate, measured change in
P2, because coarse beats currently hold some peers "online" and changing that changes routing.

**A3. Durable last direct observation.** Persist `lastDirectSuccess` (with its load report),
following the `GuardPostureStore` pattern, so a restart shows `stale, last direct contact 20:35,
load 11.5` instead of `online:false`.

**A4. Peer-observed evidence, display only.** `PeerPresencePuller`'s `session-status` reply
gains a small `peerSightings` block: for each machine, *how long ago* the sender last had direct
contact (`ageMs`, measured on the sender's own clock), never a wall-clock timestamp, so clock
skew between observers cannot make a sighting look fresh. The pool shows the freshest sighting labelled with its observer
("Mac Mini reached it 3 min ago"). Sightings carry the observer's original times; they are never
re-relayed, never refresh our own slots, and never feed placement.

**A5. Wording.** Dashboard Machines tab, rope-health digest, `/pool/placement` and attention
items use one template: `<liveness>, last evidence <age> ago from <source>`. `registry.json`
`lastSeen` is never used for user-facing state. A unit test pins that no renderer says "offline"
without positive offline evidence.

## 4. Part B — The load report (P1, and P4 for B4)

**B1. One cached report per machine.** A sampler outside the heartbeat path refreshes every
15 s and caches the result; the heartbeat and `session-status` read the cache in O(1). All
sampling is asynchronous (the current `hostMemoryPressure` macOS path uses `spawnSync('vm_stat')`
with a 5 s timeout, which would inflate the very event-loop lag it sits next to; it moves to
async `execFile`). The first sample is taken at boot before the first heartbeat.

| Signal | Source |
|---|---|
| cores, total memory, platform (`darwin`/`linux`/`wsl`) | `os` (sent on every report, so peer `hardware` no longer depends on the git registry) |
| load per core | `os.loadavg()` / cores |
| CPU idle % | `os.cpus()` deltas between samples (what `load-assess.sh` measures) |
| available memory % | `hostMemoryPressure` (async) |
| native memory pressure | macOS `memory_pressure` level; Linux/WSL `/proc/pressure/memory`; absent if unreadable |
| event-loop lag p99 | `WriteAdmission`'s existing `monitorEventLoopDelay` gauge |
| sessions active / max | `SessionManager` (fills the never-populated fields) |
| spawn-cap and test-runner saturation | existing limiter state |

Identity and expiry: every report carries `bootId`, a sequence number and `sampleAgeMs` (how
old the sample is when sent). The receiver's evidence age is `sampleAgeMs` plus transit time.
A report older than 60 s is treated as `unknown`, however recently the machine itself was
contacted: fresh transport contact never renews stale load evidence.

Transport: the report is added to `PeerPresencePuller`'s `SESSION_STATUS_ADVERT_FIELDS`
allowlist and `narrowSessionStatusToPeerCapacity()`, and stored in its own receipt-stamped slot
in `MachinePoolRegistry` (like `posture` and `coherence`), so a coarse beat can never erase it.

A missing measurement is `null`, never a substituted value (the current memory reader falls
back to server RSS on failure; that fallback is removed for this report).

**B2. Verdict — one decision table.** A row matches when at least 2 of the last 3 samples
(45 s) meet it. Rows are evaluated top to bottom: a known critical signal yields `impaired`
even when other signals are missing; `unknown` applies only when no row matched.

| Verdict | Rule |
|---|---|
| `impaired` | event-loop lag p99 > 1000 ms, **or** native memory pressure critical, **or** available memory < 5%. Any one is enough. |
| `saturated` | sessions ≥ max − 1, **or** two of: CPU idle < 10%; load per core > 1.5; event-loop lag p99 > 300 ms; memory pressure warn / available < 15%. |
| `elevated` | any one of the `saturated` pair signals. |
| `ok` | none of the above, with CPU and memory signals present. |
| `unknown` | CPU or memory signals missing. |

A 2-minute grace after boot or wake suppresses `impaired`/`saturated` caused only by lag.
Thresholds are starting values, calibrated in P1 shadow logs before P2 acts on them.

**B3. External view.** The router already logs per-peer pull failures (`lease-wire`). P1 adds
per-peer pull round-trip time to `lastDirectSuccess`. The pool shows both the machine's own
verdict and the outside view (`struggling` from A2); a disagreement is logged, not acted on.

**B4. Model assessment (P4).** When the self verdict and the outside view disagree, or signals
conflict, an efficient model (Jev, falling back to GPT-6 Luna when unsure, per the standing Jev
rule) labels the snapshot asynchronously. It runs in shadow, graded by the decision-quality meter
against what happened next (recovered / timed out / crashed). It informs reports and attention
wording; it never triggers an action.

## 5. Part C — Admission and reserved headroom (P2)

C1 and C2 are best-effort headroom, not a hard resource guarantee: they cannot stop a runaway
outside process or reserve Windows-host resources for WSL.

**C1. Admission closes on overload.** At `saturated` or `impaired` the machine advertises
`acceptingWork:false`. New non-reserved session spawns, test runs and helper spawns are queued
(reusing spawn-denial-preserves-payload), never dropped. It reopens after 5 consecutive
`ok`/`elevated` samples. Placement skips machines with `acceptingWork:false`.

**C2. Host-wide accounting with one recovery slot.** Session admission uses one host-wide
counting semaphore in `~/.instar/`, shared by every agent on the machine (the same mechanism as
the existing host LLM-spawn cap), so co-resident agents cannot each spend the same headroom.
Its capacity is the host session limit; one unit is held back as the recovery slot. Only an
operator-initiated session or the session the operator asks for in Telegram ("check the Mama PC")
may take it. With a limit of 1 the recovery slot is the only slot; with 0, ordinary sessions are disabled
and only the recovery slot exists. This is the "one session that can assess and act" Justin
asked for, without an automatic model session consuming resources during the crisis.

**C3. Scheduling priority.** Sessions, test runners and helper subprocesses spawn at `nice +5`
(macOS, Linux, WSL); the agent server and lifeline stay at normal priority.

**C4. Deterministic self-help.** At `saturated` for 3 samples, run the existing idle-MCP offload,
and raise one deduplicated attention item carrying the top five processes by CPU and memory,
marked agent-owned vs external. No automatic model session.

**C5. Never strand the fleet, never bypass admission.** Among machines that satisfy the
topic's hard constraints (channel, capabilities, pin), placement ranks `live + ok/elevated`
first, then `live + unknown`, then `stale`; it skips `acceptingWork:false` and `unreachable`.
If none qualify, the message is kept in the existing durable inbound queue, the user gets one
fixed holding notice through the deterministic send path ("your message is saved; my machines
are overloaded"), and one attention item is raised. Nothing is placed on a machine that is
refusing work; only explicitly authorized recovery work may use the recovery slot.

## 6. Part D — Overload-triggered movement (P3)

**D1. One mover, no pins.** The live move engine is `OwnershipReconciler`; it performs the
ownership compare-and-swap transfer itself and already has busy-topic, live-autonomous-run and
`ws13MaxMovesPerTick` gates and a deadline-driven `abort-transfer`. Today it acts only on pins.
P3 adds a separate, transient input, `overloadMoves()` (topic → target, episode id, expiry),
processed after pins and at lower precedence: a pinned topic is never overload-moved, and an
overload move is never written to the pin store, so it cannot leave a durable pin or trip the
pin-divergence alarms. An entry is dropped once ownership lands on the target or it expires.
`RebalancePlanner` is wired only as the pure proposer for that input, after CMT-1568 (channel
scope) is fixed and tested. `TransferOrchestrator` is not used (it is never instantiated in
production).

**D2. Source and target rules.** A source is a machine with `acceptingWork:false` for 3 minutes.
A target must be `live` (direct evidence < 2 min), verdict `ok`, serve the topic's channel, and
have a capacity reservation recorded before the move (so two moves cannot land on the same last
slot). Pinned topics and topics with a live autonomous run keep the existing consent gate.

**D3. Bounds.** At most one move per source per tick. The twice-per-hour breaker for a topic is
checked *before* proposing a move. A machine that shed work cannot receive moved work for 30
minutes. Every move goes through `SelfActionGovernor` (class `overload-shed`, observe-only first)
and is logged to `logs/overload-shed.jsonl`.

**D4. Failure recovery.** Recovery reads the current fenced ownership state rather than
rolling back blindly: while the record is still `transferring` and the target has not claimed,
the existing `abort-transfer` returns it to the source after the deadline; once the target has
claimed, the target keeps it and the source's session cleanup is retried until the source
session is confirmed closed. Either way the target's capacity reservation is released, and the
release is checked.

A started move must outlive its proposal. Today the reconciler finds in-flight transfers only
while iterating pins, and `abort-transfer` fires only when the target looks offline. P3 adds:
- Each tick, the reconciler also scans the durable ownership registry for records in
  `transferring` that it is party to, independent of pins and of `overloadMoves()`, so a move
  is still driven to claim or abort after its proposal expired or the server restarted.
- The deadline applies whether or not the target is online: a live target that has not claimed
  by the deadline is aborted the same way.
- If the source is unreachable, the existing stale-owner release path recovers the record.
- Target reservations are stored durably per episode with a TTL, released on claim, abort or
  expiry, so a crash cannot leak reserved capacity. Tests cover concurrent planners, an unreachable source, a
failed target, a restart mid-move and a refused consent, all through production wiring.

**D5. Struggling owners.** Stale-owner release keeps its evidence bar; its notices say
"struggling" or "refusing" when that is the evidence, instead of describing the owner as gone.

## 7. Rollout and tests

- P1 ships live on development agents (reporting only), dark on the fleet until a week of
  shadow logs; P2–P3 are dev-gated and dry-run first. Mixed versions: a peer without a load
  report is `unknown`, never `ok`, and C5 keeps placement working.
- Tests per phase: unit (each verdict row both sides, evidence never younger after re-read,
  liveness precedence, unknown never scores as idle, coarse beat preserves the load report);
  integration (`GET /pool` after restart shows `stale` with age; sightings merge; admission
  queues and reopens); e2e (report present after production init).
- Migration parity: config defaults via `migrateConfig()`; the CLAUDE.md template gains a
  "machine state" entry: always quote liveness with evidence age and source.
- No constitution change: G1 applies "Know Before You Claim"; G3 serves "The Agent Is Always
  Reachable" and "Bounded Blast Radius".

## 8. Changes from review

Round 3: Argon "ready, no blockers"; Astra "ready with changes", one P3 blocker (a started move
must stay discoverable after its proposal expires or a restart; the deadline must cover a live
target that never claims) → added to D4.

Round 2 (Astra, Argon):
- Both: `OwnershipReconciler` acts only on pins and `TransferOrchestrator` is unused → D1
  transient `overloadMoves()` input, D4 built on the existing `abort-transfer`.
- Astra: the router-fallback bypassed admission and hard constraints → C5 queues and notifies.
- Astra: observer timestamps and cached reports could look fresh → `ageMs` sightings, report
  identity and 60 s expiry.
- Astra: per-agent lock did not make admission atomic → C2 host-wide semaphore; limit 0 defined.
- Astra: window and missing-signal rules unclear → B2 "2 of 3" and top-down precedence.
- Astra: blanket rollback after target claim is unsafe → D4 state-based recovery.

Round 1:

- Both reviewers: rebalance path was dormant and channel-unsafe → D1 routes through
  `OwnershipReconciler`, CMT-1568 first.
- Both: `ws44PoolCache` is not a background poller → sightings ride `PeerPresencePuller`.
- Both: two-family rule misses single-resource exhaustion → `impaired` row.
- Both: warden session and model adjudication oversized for v1 → warden cut; reserved slot is
  operator-only; model assessment moved to P4, advisory.
- Astra: evidence freshness could be manufactured → three slots, original age preserved.
- Astra: changing `online` changes routing → P1 leaves `online` unchanged.
- Argon: coarse beats drop load; synchronous `vm_stat` → separate receipt-stamped report slot,
  async sampler.
- Both: unknown-exclusion could strand placement → C5 ranking.
- Both: `MachineLoadBroker` misdescribed → removed from this spec.
