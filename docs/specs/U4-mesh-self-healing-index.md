---
title: "U4 — Mesh Self-Healing: spec index (5 robustness items from the 2026-07-01 postmortem)"
slug: "u4-mesh-self-healing-index"
author: "echo"
status: "draft-index"
parent-spec: "docs/postmortems/2026-07-01-silent-telegram-message-loss.md; MULTI-MACHINE-SESSION-POOL-SPEC; MULTI-MACHINE-SEAMLESSNESS-SPEC; multi-transport-mesh-comms.md"
project: "self-healing-mesh (topic 29836)"
note: "This is the INDEX/planning doc for the U4 track — each item below becomes its own spec that goes through /spec-converge before any /instar-dev build. Drafted per operator preapproval (topic 29836). Implementation is explicitly a stretch beyond this session's completion condition; this doc FILES the designs so the track is durable and reviewable."
---

# U4 — Mesh Self-Healing

The 2026-07-01 incident and the surrounding mesh work exposed a class of gaps: the
mesh recovers from *some* faults automatically but leans on manual intervention (the
"captain-flip playbook") or silent degradation for others. The operator's north star:
*a multi-machine mesh so robust and self-healing that the user simply talks to an
agent and never needs to know which machine it runs on.* Each item below closes a
specific manual-intervention or silent-degradation gap on the path to that.

Grounding facts (verified this session, machine ids: Laptop
`m_cc2ec651a91f03f85abb19bfe5e7e8f7`, Mac Mini `m_4cbc0d4a0c557cf7e221882f9b42518f`):
the awake machine is chosen by a fenced lease; exactly one machine polls Telegram
("captain"); a static `telegramPolling` knob + `pollOverride` currently gate polling;
`pollFollowsLease` (D3) is the automation that makes the poller follow the lease
(graduated to observation this session). Multi-transport mesh comms (Tailscale + LAN +
Cloudflare) is enabled; the single-rope flap was the root of lease instability.

---

## U4.1 — Pin persistence across lease handover

**Problem.** A topic deliberately pinned/moved to a machine (`GET /pool/placement`
reason `pinned`) can silently revert to load-balanced placement after a lease move
or a machine bounce — the pin "evaporates" (observed 2026-07-01; recorded in the
mesh-captain-flip-playbook memory: "pins can evaporate — re-check placement"). The
user who said "run this on the mini" finds it elsewhere after a handoff, with no
notice.

**Design sketch.** Make a pin a DURABLE, replicated intent (not in-memory placement
state): persist `{topicId, pinnedMachineId, pinnedAt, pinnedBy}` in a
coherence-journalled store that survives a lease move; on handover the new captain
REPLAYS outstanding pins before load-balancing; a pin to an OFFLINE machine holds as
`pending-pin` (honest) rather than silently reverting. Read surface:
`GET /pool/placement` already reports `reason: pinned|placed` — extend it with
`pinSource: durable|inferred` and `pinHeldSince`. Safety: a durable pin is operator
intent, so it overrides load-balancing but NOT a quota-block (a pinned machine that
is rate-limited surfaces `pinned-machine-quota-blocked`, as today). Convergence
concern to resolve: pin vs. the autonomous-run consent gate on transfer.

## U4.2 — Stale-owner release path

**Problem.** When the machine that OWNS a topic's session goes dark mid-work, the
topic can be stranded: the owner holds the (now-stale) ownership record, and the
peer won't take over because ownership hasn't been released. This is adjacent to the
"dead but marked active" case the Autonomous Liveness Reconciler handles for runs,
but at the TOPIC-OWNERSHIP layer. The 24h-session-death loop (mesh-lease-tick-wedge
memory) is the acute form: a flaky peer wedges the lease tick → `holdsLease:false`
→ reconciler blocked-not-owner → no revival.

**Design sketch.** A fenced, TTL'd ownership lease per topic (mirroring the serving
lease): an owner heartbeats its topic-ownership; when the heartbeat goes stale past
a bound AND the owner is provably unreachable across ALL mesh transports (not just
one rope — the multi-transport check is the key robustness upgrade), a peer may
CLAIM the topic via an atomic CAS takeover, with the same working-set-handoff pull
that already moves files. Fail-CLOSED on any transport ambiguity (a reachable-on-LAN
owner is NOT stale). Emits ONE attention item only for a genuinely unresolvable
partition (dedup per episode), never per heartbeat. Read: `GET /pool/placement`
gains `ownershipLeaseState: held|stale|releasing|claimed`.

## U4.3 — Traffic-independent rope-health recovery probe

**Problem (corrected by convergence rounds 1-3 — the sketch below is historical).**
There is NO circuit-breaker object; the real primitive is the per-(peer,kind)
HealthRecord, and the real starvation is hedge-winner-abort (a dead rope is never
re-dialed, and a cancelled hedge loser records a false failure). The converged
spec drives the EXISTING HealthRecord from an in-process episode-scoped prober
and fixes the hedge-abort accounting. See the converged spec — it supersedes
this sketch entirely.

**Design sketch.** An active, cadenced half-open probe: when a breaker is open, a
lightweight signed ping (the delivery-canary G4 primitive is the model — zero
injection, bounded) tests the specific transport on a backoff schedule
independent of user traffic; N consecutive successes close the breaker and emit a
`rope-recovered` breadcrumb (not an alert). Bounded (P19) so a persistently-broken
rope gives up probing loudly rather than spinning. Read: `GET /health` mesh section
gains per-transport `breakerState + lastProbeAt + nextProbeAt`.

## U4.4 — Lease hand-back to the preferred captain

**Problem.** After a failover moves the lease off the preferred (stationary) captain
to a standby, the lease does not automatically hand BACK when the preferred captain
recovers — it stays on the standby until the next disruption. On an asymmetric setup
(a always-on Mini + a frequently-asleep Laptop), the mesh drifts to the wrong
long-term holder. The captain-flip playbook documents this as a manual bounce.

**Design sketch.** A preference-weighted, HYSTERESIS-gated hand-back: the lease
records a `preferredHolder`; when the preferred captain has been continuously healthy
for a sustained window (hysteresis — NOT on first recovery, to avoid flap), a
graceful hand-back runs at a clean boundary (no in-flight forwards, mirroring the
lifeline drift-promoter's clean-window logic). Never interrupts active work; never
flaps (the sustained-clear window is the anti-flap guard, same shape as U1's
flapping-proof decay). Opt-in `preferredCaptain` config (defaults to no preference =
today's sticky behavior). Ties into `soloCaptainHold` (multi-transport spec, already
dark).

## U4.5 — Rope-health alerts (honest, deduped)

**Problem.** Transport degradation (a Tailscale key nearing expiry, a rope
persistently down, the Cloudflare flap) is currently visible only if you go looking
(`/health`, `/guards`). The operator should be TOLD once, calmly, before a rope
failure becomes a lease instability — but per the conservative-notification
directive, NOT a stream of per-check alerts.

**Design sketch (HISTORICAL — superseded entirely by the converged spec: an
in-server RopeHealthMonitor owns detection; G1 is a consumer only; there is no
breaker object).** Fold rope-health into the existing G1 coherence-audit digest (the
daily single-message-to-hub-topic path built this session already checks Tailscale
login state + a 14-day key-expiry warning) — extend it to per-transport reachability
+ breaker state + key expiry, as ONE line in the existing digest, never a new topic
or per-event item. An URGENT rope state (ALL transports down to a peer = imminent
partition) is the only case that escalates beyond the digest, and then as ONE
deduped attention item. This is the least new surface: it rides infrastructure that
already exists and already honors the noise directive.

---

## Sequencing (recommended)

1. **U4.3 FIRST** (sequencing INVERTED by convergence — the original "U4.5 first,
   rides G1" plan was overturned: G1 cannot be the vehicle, and U4.5's data source
   IS U4.3's health snapshot, a HARD dependency).
2. **U4.5** — in-server monitor + digest, immediately after (may share U4.3's PR).
3. **U4.2** — stale-owner release; the acute strand-fix (directly addresses the
   24h-session-death loop).
4. **U4.1** — pin persistence; user-facing intent durability.
5. **U4.4** — lease hand-back; the long-horizon correctness polish.

Each ships dark → dry-run → dev-agent → fleet on the graduated-rollout ladder, with
its own /spec-converge pass. All five are machine-coordination (high agent-readiness)
work; none require judgment that stays human.
