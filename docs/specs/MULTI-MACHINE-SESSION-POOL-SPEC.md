---
title: "Multi-Machine Session Pool"
slug: "multi-machine-session-pool"
author: "echo"
eli16-overview: "MULTI-MACHINE-SESSION-POOL-SPEC.eli16.md"
approved: true  # Justin's conversational "go!" on topic 13481, 2026-05-28 — self-applied by Echo per the established conversational-go pattern; flagged to Justin in the same exchange
principal-signoff: signed  # Justin, 2026-05-28, topic 13481 ("go! ... lets get this completely working")
layer: "core-instar-primitive"  # NOT a deployment pattern — ships in core instar src/
topology: |
  This spec defines NEW instar primitives that ship in core instar source (src/),
  not a deployment pattern: MeshRpc (L0), MachineCapacity registry (L2),
  SessionOwnership registry + per-session CAS (L3), Session Router / placement
  engine + TopicPlacement metadata (L4), Transfer/Handoff orchestrator (L5),
  shared machine-level load broker (L6). They REUSE existing primitives —
  FencedLease, LeaseCoordinator, GitLeaseStore, MultiMachineCoordinator,
  MachineIdentity/machineAuth, MessageProcessingLedger, NonceStore — per
  CROSS-MACHINE-SEAMLESSNESS and MULTI-MACHINE-SPEC. The "org-scale" / "EXO 3.0"
  language describes the MOTIVATION (why we build at scale), not the layer:
  every component is instar-layer infrastructure with HTTP/MeshRpc surfaces, unit
  tests, and migration parity — none of it is a deployment recipe. There is no
  deployment-pattern carve-out; if a future operational recipe emerges it goes in
  a separate DEPLOYMENT-PATTERNS catalog cross-referencing these primitives.
deferral-approvals:  # P10 — every recurrence-risking deferral needs explicit principal sign-off. <!-- tracked: router-single-shard-v0.1-scope -->
  # As converged, this spec defers NOTHING that carries recurrence risk: every
  # component named in the Build Plan (incl. L2 shared-load accounting and the L4
  # TopicPlacement update endpoint) is IN SCOPE for v0.1 and has its own track +
  # three test tiers. The Graduated Rollout stages gate ACTIVATION, not delivery —
  # all code ships in v0.1; stages only flip behavior on (see §Rollout). The
  # "Open Design Decisions" are DEFAULT-CHOSEN in the spec body and resolve at
  # approval (a recommendation is not a deferral). <!-- tracked: router-single-shard-v0.1-scope -->
  #
  # The ONE legitimate scope decision is the router horizontal-scaling fork
  # (Open Design Decision #5 + §L1 "Pool-size scope"): v0.1 is scoped to small
  # same-operator pools (≤ routerPoolMaxMachines, default 10 — which covers the
  # real target: one user's laptop + mini + phone). This is NOT a hand-wavy
  # "Phase 2" — the sharded-router design (session-hash / channel-id fenced
  # shards via the RouterShardKey indirection built day-one) is PRE-SPECIFIED in
  # §L1 so it is not retrofit-blocking debt. The single-router scope is recorded
  # here as the lone scope decision requiring Justin's explicit confirmation,
  # because it bounds the supported envelope (it does NOT defer any component —
  # all v0.1 components ship fully built + 3-tier tested).
  approvals:
    - id: "router-single-shard-v0.1-scope"
      decision: >
        v0.1 ships a single fenced router (RouterShardKey indirection always
        maps to shard 0). Supported envelope: ≤ routerPoolMaxMachines (default
        10) same-operator machines, ≤ routerMaxThroughputMsgPerSec (default 500)
        sustained. Multi-shard horizontal scaling is OUT of v0.1 scope (it
        changes Invariants #1/#3 and needs its own exactly-once proof), but the
        sharding design is pre-specified in §L1 so it is not retrofit debt.
      carries-recurrence-risk: false  # nothing is deferred un-built; only the supported envelope is bounded <!-- tracked: router-single-shard-v0.1-scope -->
      requires: "Justin's explicit confirmation at approval (see Open Design Decision #5)"
      approver-signoff: signed  # Justin confirmed the ≤10-machine / 500-msg-sec single-router v0.1 envelope via "go!" (topic 13481, 2026-05-28); multi-shard remains a separate future spec on the RouterShardKey seam
  asserted-no-recurrence-risk-deferrals: true  # the one scope decision above defers no component, only bounds the envelope <!-- tracked: router-single-shard-v0.1-scope -->
  approver: "Justin"            # signs at approval, converting principal-signoff: pending → signed
  approver-signoff: signed  # Justin, 2026-05-28, topic 13481
review-convergence: "2026-05-29T05:45:28.202Z"
review-iterations: 4
review-completed-at: "2026-05-29T05:45:28.202Z"
review-report: "docs/specs/reports/multi-machine-session-pool-convergence.md"
---

# Multi-Machine Session Pool Specification

> One agent identity, many machines, all awake at once. Each conversation runs on the best-fit machine, can move between machines like a session restart, and never drops or doubles a reply. The "who's in charge" role is held by exactly one machine at a time and re-elected on failure.

**Status**: Converged + Approved (Justin "go!", 2026-05-28, topic 13481) — building Tracks A–H
**Author**: Echo (with Justin's direction, topic 13481)
**Builds on** (does NOT replace):
- [`CROSS-MACHINE-SEAMLESSNESS-SPEC.md`](./CROSS-MACHINE-SEAMLESSNESS-SPEC.md) (approved) — established the fenced lease, leader resolution, state sync, and the seamless channel experience for the **active-passive** ("one awake machine") model. This spec **generalizes** that model to **active-active**.
- [`MULTI-MACHINE-SPEC.md`](./MULTI-MACHINE-SPEC.md) (v3, converged) — machine identity, secure pairing, git state sync, encrypted secret sync, distributed coordination foundation.
- [`LEASE-SUBSTRATE-ROBUSTNESS-SPEC.md`](./LEASE-SUBSTRATE-ROBUSTNESS-SPEC.md) (WIP) — durable lease renewal. **Folds into this spec** as the durability floor for the router-leader lease (§L1).
**Companion (read first)**: [`MULTI-MACHINE-SESSION-POOL-SPEC.eli16.md`](./MULTI-MACHINE-SESSION-POOL-SPEC.eli16.md)
**Motivating initiative**: Instar × EXO 3.0 — Pillar 2, cross-machine single-agent at organizational scale.

**Post-approval amendment (2026-05-28, Justin, topic 13481):** Added a **Machines dashboard tab** (every machine the agent is installed on + hardware properties), **auto-assigned, user-editable machine nicknames** (the user-facing handle), and **transfer-by-nickname** (`move this to <nickname>`). The nickname-driven mid-conversation swap is now the headline test-as-self proof. This is additive and consistent with the converged L2/L4/dashboard design — no architectural change, no invariant change; it lands in Track B (registry + nicknames + Machines tab) and Tracks E/F (nickname resolution + transfer), proven in Track H. Folded in during the build under Justin's "make the call yourself" directive; a focused lessons-aware + Dashboard-Standard review runs when those tracks are built.

---

## Table of Contents

1. [Overview & the Shift](#overview--the-shift)
2. [Vision (Justin's words, structured)](#vision)
3. [User Stories](#user-stories)
4. [Architecture: Six Layers](#architecture-six-layers)
   - [L0 — Secure Machine-to-Machine Backbone](#l0--secure-machine-to-machine-backbone)
   - [L1 — Router-Leader Lease](#l1--router-leader-lease)
   - [L2 — Machine-Pool Registry](#l2--machine-pool-registry)
   - [L3 — Per-Session Ownership](#l3--per-session-ownership)
   - [L4 — Session Router / Placement Engine](#l4--session-router--placement-engine)
   - [L5 — Session Transfer / Handoff Orchestrator](#l5--session-transfer--handoff-orchestrator)
   - [L6 — Multi-Agent-Per-Machine](#l6--multi-agent-per-machine)
5. [Invariants & Safety](#invariants--safety)
6. [What Exists vs What We Build](#what-exists-vs-what-we-build)
7. [Rollout (Graduated)](#rollout-graduated)
8. [Testing Strategy](#testing-strategy)
9. [Migration Parity & Agent Awareness](#migration-parity--agent-awareness)
10. [Open Design Decisions (for Justin)](#open-design-decisions-for-justin)
11. [Build Plan (Project Tracks)](#build-plan-project-tracks)

---

## Overview & the Shift

Today Instar's multi-machine model is **active-passive**: a fenced lease elects exactly ONE awake machine for the whole agent; the others stand by and take over on failure (per the approved CROSS-MACHINE-SEAMLESSNESS spec). This is correct and proven, but it wastes the standby machines' capacity and forces the entire agent through one machine.

This spec **generalizes** that to **active-active**: every machine the agent is installed on is awake and working at once. The unit of placement moves DOWN — from "which machine is the awake agent" to "which machine runs THIS conversation." Many conversations spread across many machines, each independently owned and independently movable.

**The single fenced lease does not disappear — it changes what it guards.** It stops guarding "who is the one awake agent" and starts guarding "who is the **router** right now." Exactly one machine holds the router role; it makes placement decisions and owns channel ingress. On router-machine failure, the existing failover machinery re-elects a new router. Per-conversation ownership is a separate, lighter, per-session fencing layer.

**Backward compatibility is a hard requirement.** A single-machine agent must behave exactly as it does today: it is trivially its own router and its own sole worker, with zero added latency or behavior change. The feature ships dark (Graduated Feature Rollout) and activates only when >1 machine is paired.

---

## Vision

(Justin, topic 13481, 2026-05-28 — structured.)

- An **agent** is an identity users interact with — characteristics, responsibilities, jobs, files. Like a person.
- A single agent leverages **any number of machines** to improve robustness AND capacity. More machines ⇒ greater capacity to serve.
- Users interact via a **channel** (Telegram, Slack). Each conversation = a **session**. Users should not have to know which machine a session runs on (most of the time).
- Machines act as a **collective resource pool** (memory + CPU). Most of the time placement doesn't matter because the agent's files and important data sync frequently across all machines. Sometimes it does: a task needs particular hardware; a machine is overloaded; or the user requests a specific machine.
- In all those cases the agent can **transfer** a session machine→machine. The experience equals a session "restart" on a single machine today — the new machine picks up from the channel logs + synced state. The same infra means a machine going offline re-routes its sessions to available machines.
- **Topic metadata** (updates with the topic) describes characteristics that a **session router** uses to decide placement, weighing machine characteristics, task characteristics, and user preferences.
- Any machine can act as a router, but only one **holds the stick** at a time; if it goes down the others coordinate who picks it up.
- Machines have a **super-efficient, super-secure** means of communicating to coordinate and share data/secrets.
- Multiple agents can be installed on a single machine and share its resources.

---

## User Stories

1. **Invisible placement.** Justin messages the agent. A new conversation spins up on the least-loaded capable machine. Justin has no idea — and shouldn't — which machine answered.
2. **Capacity scaling.** Justin installs the agent on a third machine. Without any config, the agent now places new sessions across three machines; throughput rises.
3. **Hardware-aware placement.** A task needs a GPU / a specific local model. The router places (or transfers) that session onto the machine that has it.
4. **Explicit pin / transfer by nickname.** Justin opens the **Machines tab** in the dashboard, sees every machine the agent is on (with friendly auto-assigned nicknames he can edit, plus each machine's hardware), and mid-conversation says "move this to the mini" (or "run this one on the mini"). The conversation transfers to that machine by nickname and continues coherently — same thread, no dropped/doubled message.
5. **Load rebalance.** A machine is saturated with sessions; the next session is placed elsewhere, and optionally a low-priority running session is transferred off it.
6. **Failover.** A machine goes offline. Its in-flight conversations re-route to other machines and resume from channel history — the user sees, at worst, a brief "picking this back up" continuation, never amnesia and never silence.
7. **Router failover.** The machine holding the router stick drops. Another machine is elected router within the failover threshold; ingress resumes; no message is lost or doubled.
8. **Two agents, one machine.** Justin runs Echo and a second agent on the mini; they share its resources without interfering, each with isolated state and fair capacity accounting.

**Acceptance bar (channel-measured, inherited from CROSS-MACHINE-SEAMLESSNESS):** any placement, transfer, or failover is, from the user's seat, *no worse than a compaction pause or a fresh-session catch-up* — and exactly-once: never a dropped reply, never a doubled reply.

---

## Architecture: Six Layers

### L−1 — Coordination Substrate (correctness foundation, MUST read before L1/L3)

Everything below depends on two coordination primitives — the **router lease** (§L1, one point) and **per-session ownership CAS** (§L3, thousands of points). Their correctness is only as strong as the substrate they run on. This section formalizes exactly what that substrate provides, because the rest of the spec's invariants are otherwise unjustified. **Per instar's core design decision (CLAUDE.md: "Everything is JSON files. No database dependency."), there is NO external coordination service in this design — no etcd / Consul / ZooKeeper / Postgres / DynamoDB / Redis. Git is the durable correctness substrate; the fast MeshRpc/tunnel path is a latency optimization, never the correctness backstop.** The spec's job here is to state HONESTLY what git's CAS actually provides and to scope the invariants to match — not to bolt on a stronger store.

**What git's single-ref CAS actually guarantees (the linearization point, when reachable).** A `git push` that advances a single ref (the lease/ownership ref) is accepted by the remote ONLY as a fast-forward over the ref's current value; a non-fast-forward push (the ref already moved past what the pusher saw) is **rejected by the remote, atomically, server-side.** This is a genuine compare-and-set against the remote ref's tip:
- The push carries the expected old-tip implicitly (the local ref the pusher fetched). If another writer advanced the ref first, the remote rejects this push as non-fast-forward; the loser does NOT silently both-win. It must `fetch` (observing the advanced state) and retry against the new tip.
- **The remote ref-update is therefore the linearization point** for any machine that can reach the remote. For two concurrent claims to the same epoch `e`, both push a commit advancing the ref from `e`→`e+1`; the remote accepts exactly ONE (the first to land server-side) and rejects the other as non-fast-forward. Exactly one winner, decided by the remote's atomic ref-update — never application code, never machineId.
- This is the SAME substrate the existing `GitLeaseStore` / `GitSync` state-sync already relies on; we are not adding a mechanism, we are stating its guarantee precisely. Ownership records are stored one-file-per-session (§L3) so concurrent CAS to DIFFERENT sessions advance independent paths and the ref-update serializes them trivially; only same-session CAS contends, resolved by the non-fast-forward rejection above.

**The residual non-linearizability is the PARTITION window ONLY — and it is fenced, not papered over.** Git is not linearizable for a writer that *cannot reach the remote*: such a machine holds a stale local view and could believe it still holds a lease the rest of the pool has moved on from. This — and ONLY this — is the window the design must guard, and the existing fenced-lease pattern (`FencedLease` / `GitLeaseStore`) is exactly the guard:
- **Monotonic epoch + verify-on-read:** every lease/ownership read verifies the epoch is ≥ the floor it last observed; a stale-but-higher epoch from a peer demotes the reader. A partitioned holder that rejoins and pushes a stale-epoch write is rejected as non-fast-forward (the ref already carries a higher epoch) — its writes are *superseded* on rejoin, never accepted.
- **TTL self-fence (the partition safety rule, mandatory):** a lease/ownership holder that fails to RENEW (land a fast-forward push advancing its generation) within `leaseTtlMs` **MUST self-fence** — it stops emitting to the channel and stops acting on that lease/session BEFORE the TTL elapses on its own monotonic clock — *without* waiting to hear from anyone. A partitioned holder cannot distinguish "I'm cut off" from "the remote is down," so it conservatively assumes it has been superseded once it can no longer prove its renewal landed. This is what makes a partition safe: the partitioned side goes quiet on its own; the reachable side re-elects/re-claims via a clean fast-forward CAS once the TTL has provably lapsed.
- **Git remains the durable correctness substrate; MeshRpc/tunnel is a latency optimization only.** The fast path carries lease/ownership broadcasts so peers learn of a transition in milliseconds instead of a git round-trip — but a CONTENDED mutation's *correctness* always rests on the git ref-update CAS, never on a tunnel message. A tunnel message can be lost or reordered; it can make the pool *faster* but never *wrong*, because the durable ref-update is the arbiter. (This is the direct analogue of how `HttpLeaseTransport` already carries the lease fast while `GitLeaseStore` holds the truth.)

**The CAS protocol is exact and ref-update-enforced (not application-arbitrated).** A per-key CAS is: fetch the ref → read `{holder/owner, epoch, leaseGenerationStart, ttlMs, signature}` → if local epoch `== expected`, build a commit advancing it to `expected+1` and push. Push acceptance is the decision:
- For **two concurrent claims to the same epoch** (both read `expected = e`, both try to advance to `e+1`): the remote ref-update serializes them. **Exactly one** push fast-forwards from `e` (it landed first); the other is **rejected non-fast-forward** (the ref now points at `e+1`) — the loser fetches, observes `e+1`, and stands down or retries against the new tip. **The remote does NOT consult machineId.** Both attempts do not "both fail" and do not "both win" — exactly one fast-forwards, deterministically, by the remote's ref-update order.
- The **`lowest-machineId` rule of §L3 is a CLIENT-SIDE retry-ordering optimization, not the CAS arbiter.** It only governs *which loser retries first* after a non-fast-forward rejection, to reduce a second collision round — it is never the thing that decides a winner. The winner is always the push that fast-forwarded the remote ref. (This corrects any reading of §L3 that treated "lowest machineId wins" as the compare condition. The §L3 text is amended to say so explicitly.)
- **Partition behavior is explicit:** if a machine cannot reach the remote, it CANNOT land a fast-forward push and therefore CANNOT acquire or renew the router lease or claim ownership. Per the TTL self-fence above, it self-suspends those mutations and treats any lease it can no longer renew within TTL as lost. It does NOT keep emitting on a stale local view. A machine partitioned from the remote but still reachable by the channel is exactly the "maybe-alive, lease can't move" case that escalates one deduped Attention item (§L1) — the design does not silently pick.

**Wall-clock is removed from the correctness path; expiry is fenced by epoch + monotonic-local self-expiry (CLAUDE.md SleepWakeDetector lesson).** The lease/ownership record carries `{holder, epoch, leaseGenerationStart, ttlMs, signature}`. Liveness/expiry is judged as follows, and the spec states the clock assumption explicitly rather than leaving it implicit:
- **Renewal advances the epoch** (monotonic, ref-update-enforced via the fast-forward CAS). A holder that fails to renew loses authority; the next reader's CAS to claim fast-forwards because the holder never advanced the ref.
- **A holder's own expiry is judged on its MONOTONIC-LOCAL clock, never wall-clock.** The holder measures "have I renewed within `leaseTtlMs`?" against `process.hrtime`/monotonic elapsed since its last successful fast-forward push — NOT against a wall-clock timestamp that an NTP step or a VM-pause could jump. If monotonic-local elapsed exceeds `leaseTtlMs` without a confirmed renewal, the holder self-fences (above). This is the real guard.
- **A reader's expiry judgment of ANOTHER machine's lease is the fenced epoch, not a clock comparison.** A reader never decides "that peer's lease expired because its timestamp is old" — it decides authority by the epoch floor (a higher epoch it has observed, or a clean fast-forward claim it can land). Wall-clock timestamps in the record are ADVISORY (debugging / staleness display) and are never the deciding test, which is what removes the divergent-clock split-brain risk.
- **Why monotonic-local self-expiry is safe under partition AND clock chaos:** the partitioned holder self-fences on its own monotonic clock (it stops on its own); the reachable side cannot steal the lease until it can land a fast-forward CAS, which it can only do once the holder has provably stopped advancing the ref. No two machines can both believe they hold the lease at the top epoch, regardless of how badly their wall-clocks diverge.
- **Explicit clock-sync requirement (REQUIRED, startup-enforced — for the timestamp-using surfaces, NOT for lease correctness):** the §L0 MeshRpc envelope and the §L2 heartbeat still use wall-clock timestamps for replay-rejection and divergence detection. Those surfaces (not lease expiry) need bounded clock error. At startup `instar doctor` / server boot calls `assertClockSyncHealthy()`: define `maxExpectedNtpDriftMs` (the realistic NTP-synced drift budget, default 250 ms) and require (1) `maxObservedClockErrorMs ≤ maxAllowedClockErrorMs` (default 5000 = 5 s, well inside the 30 s mesh tolerance), measured against the configured time source, and (2) **`clockSkewToleranceMs ≥ maxExpectedNtpDriftMs * 2` AND `clockSkewToleranceMs ≥ maxAllowedClockErrorMs`** — a hard error if a tolerance is configured tighter than 2× the expected real NTP drift (so a 5-min tolerance is never paired with a 6-min real drift, and a sub-drift tolerance never silently flaps). If the check fails, the machine refuses to JOIN the pool as a worker/router and raises an Attention item — it does NOT silently join with a bad clock.
- **VM-pause / sleep / NTP-step / CPU-starvation resilience (the SleepWakeDetector lesson, directly answered):** a candidate that was paused (or whose 2 s heartbeat timer starved for 8–29 s under CPU load ≫ cores — the exact 2026-05-2x incident) and woke with a jumped clock CANNOT grab a live lease: its claim must fast-forward the remote ref over the still-current epoch, which it cannot forge, and its own monotonic self-fence already made it go quiet while it was starved. Its stale in-memory "I am router until T" is invalidated by the §L1 verify-on-read (epoch floor) the instant it tries to act. A host whose clock-error budget is blown fails `assertClockSyncHealthy()` on its next heartbeat divergence (§L2) and is quarantined out of placement (§L2 clock-skew quarantine) rather than allowed to (a) win a lease it shouldn't or (b) silently report stale load.

**Tests (Tier-1, substrate):**
- Two clients CAS the same lease/ownership key from `expected=e` concurrently against a shared remote → exactly one push fast-forwards (`{ok:true}`), the other is rejected non-fast-forward and observes `e+1`; assert NEITHER outcome consulted machineId and the winner is the ref-update-first writer. Measure CAS round-trip p99.
- A client whose wall-clock is stepped +10 min attempts to claim a still-renewing lease → claim rejected because it cannot fast-forward the current epoch (NOT because of any timestamp comparison); no acquisition.
- A holder whose monotonic-local elapsed exceeds `leaseTtlMs` without a confirmed renewal self-fences (stops emitting / acting) BEFORE any peer re-claims — assert it goes quiet without waiting on a peer message.
- Partition a client from the remote → it cannot renew/claim, self-fences its lease/sessions within TTL, and does NOT keep emitting on a stale view (assert no channel output past the self-fence deadline); on rejoin its stale-epoch push is rejected non-fast-forward.
- `assertClockSyncHealthy()` with injected 10 s clock error → startup JOIN refused + Attention item; with `clockSkewToleranceMs` configured below `maxExpectedNtpDriftMs * 2` → hard startup error.

### L0 — Secure Machine-to-Machine Backbone

**Goal:** an efficient, secure channel for machines of one agent to coordinate (placement commands, ownership claims, heartbeats) and share data/secrets.

**Reuse (exists):**
- `MachineIdentity` — per-machine Ed25519 (signing) + X25519 (encryption) keys + 128-bit machine ID.
- `machineAuth` (`signRequest` + `machineAuthMiddleware`) — authenticated HTTP between machines.
- `HttpLeaseTransport` pattern — low-latency authenticated tunnel path already used for lease broadcast.
- Encrypted secret sync (MULTI-MACHINE-SPEC Phase 4) — secrets travel X25519-encrypted, never via git.

**Build:**
- **MeshRpc** — a thin, signed request/response layer over the authenticated HTTP channel carrying a small command set: `place(session, machine)`, `claim/release(session, epoch)`, `transfer(session, target)`, `capacity-report`, `session-status`, `secret-share(encrypted blob)`. Every command is Ed25519-signed by the sender, nonce + epoch replay-protected (reuse `NonceStore`).

- **Signed-payload format (recipient-bound — mandatory).** The signature MUST cover BOTH the sending and the receiving machine, so an intercepted command signed for machine-A cannot be replayed to machine-C. The canonical signed envelope is:
  ```
  {
    sender:    MachineId,        // who signed
    recipient: MachineId,        // intended recipient — REQUIRED, part of the signed bytes
    command:   { type, ...args },
    epoch,                       // sender's lease/ownership epoch
    nonce,                       // unique per command (NonceStore)
    timestamp,                   // wall-clock ms; rejected if |now - timestamp| > meshRpcClockToleranceMs (default 30000)
    signature                    // Ed25519 over the canonical serialization of {sender,recipient,command,epoch,nonce,timestamp}
  }
  ```
  On receipt a machine MUST verify, in order: (1) `recipient === this.machineId` — reject `wrong-recipient` otherwise; (2) signature valid for `sender`'s registered Ed25519 key; (3) `sender` is a registered peer of the same agent; (4) nonce unseen in `NonceStore`; (5) timestamp within tolerance. Any failure → reject + `SecurityLog` entry, command NOT honored.

- **Per-command RBAC (authorization gate — mandatory).** A valid signature proves WHO sent the command, not that they MAY issue it. Exactly-one-owner is enforced at CAS, but command-acceptance is independently gated so a registered-but-unauthorized peer cannot even attempt a privileged mutation:
  - `place(session, machine)` — honored ONLY if `sender` currently holds the router lease (receiver reads the router lease, verify-on-read per §L1, before honoring). A non-router peer issuing `place` is rejected `not-router`.
  - `claim(session, epoch)` — honored ONLY if (a) `sender` is the machine named as target in the router's prior `place`/`transfer` for that session, OR (b) `sender` holds the router lease AND the command carries a `failover: true` flag (router re-placing a dead owner's session). Any other `claim` is rejected `claim-unauthorized` — even though the CAS would also fence it, the command is refused at the door.
  - `release(session, epoch)` — honored ONLY if `sender === current ownerMachineId` for that session (or the router during a fenced failover). Otherwise rejected `release-unauthorized`.
  - `transfer(session, target)` — honored ONLY if `sender` holds the router lease.
  - `capacity-report` / `session-status` — any registered peer (read/observe class).
  - `secret-share` — any registered peer; payload is X25519-encrypted end-to-end regardless.
  - Each command handler documents its required role; the role check runs BEFORE any state read/write.

- Transport selection mirrors the lease: tunnel fast-path when reachable; durable git substrate as the correctness/audit backstop for ownership + placement records (NOT for high-frequency heartbeats — those are tunnel/in-memory).

**Invariant:** no m2m command is honored without (a) a valid Ed25519 signature from a registered peer machine of the same agent that is cryptographically bound to THIS recipient, AND (b) the per-command role check above; secrets are only ever transported encrypted end-to-end.

**Tests:** Tier-1 — a command signed for machine-A, replayed verbatim to machine-C, is rejected `wrong-recipient`; an unauthorized (non-router) peer issuing `place`/`claim` (without the placement assignment) is rejected `not-router`/`claim-unauthorized`; a stale-timestamp and a reused-nonce command are both rejected.

### L1 — Router-Leader Lease

**Goal:** exactly one machine is the router at a time; re-elected on failure.

**Reuse (exists, near-complete):** `FencedLease`, `LeaseCoordinator`, `GitLeaseStore` (the CAS authority — git single-ref fast-forward push, see §L−1), `HttpLeaseTransport` (fast carry — latency optimization only, never the correctness backstop), `MultiMachineCoordinator` (`promote`/`demote`/`failover`/`roleChange`). The CROSS-MACHINE-SEAMLESSNESS leader-lease IS this lease — we reinterpret "awake holder" as "router holder." **The CAS authority is `GitLeaseStore`'s single-ref fast-forward push (§L−1): the remote ref-update is the linearization point when reachable; the partition window is fenced by monotonic epoch + verify-on-read + TTL self-fence.** This is NOT the discredited "naive fetch→check→push race" — a non-fast-forward push is rejected server-side, so the loser cannot silently both-win. No external coordination store is introduced (per CLAUDE.md "no database dependency").

**Pool-size scope (v0.1, explicit).** A single router is a deliberate sequential chokepoint that makes exactly-once trivial — and it does NOT horizontally scale. **v0.1 is scoped to a single machine or a small same-operator pool of ≤ `routerPoolMaxMachines` (default 10) machines, NOT viable above 500 sustained msg/sec or > ~10k concurrent sessions.** This is stated as a hard scope boundary, not a soft warning: the org-scale / EXO 3.0 *motivation* is the long arc, but v0.1 deliberately ships the bounded single-router design because it is the only one whose exactly-once and exactly-one-owner invariants are provable with the §L−1 substrate today. **Router sharding is NOT hand-waved away — it is out of scope because it would change Invariants #1 and #3** (per-shard exactly-once + cross-shard ordering is a different correctness model that cannot be retrofitted onto the single-router ledger without a redesign of `MessageProcessingLedger`). To keep v0.1 from creating debt that a future shard model cannot retrofit, the router is built behind a `RouterShardKey` indirection from day one: ingress and placement already key every operation on `shardKey = hash(sessionKey) mod 1` (always shard 0 in v0.1). A future sharded topology raises the modulus and runs one fenced lease + one ledger PER shard, with no caller change — but that future work is its OWN spec with its OWN exactly-once proof, explicitly not promised here. The `RouterShardKey` indirection is the only sharding-related code in v0.1; it has a Tier-1 test asserting all keys map to shard 0 and that the lease/ledger lookup is shard-scoped.

**Fold in:** `LEASE-SUBSTRATE-ROBUSTNESS-SPEC` (WIP) — the durable-renewal fix, re-grounded on §L−1: the router lease's CAS authority is `GitLeaseStore`'s single-ref fast-forward push; a fresh/restarted machine seeds from git, replaying the signed transition log in epoch order, and never treats a live router as expired (it reads the current epoch from the ref tip). Verify-on-read (authority + epoch-floor + monotonic-local-self-expiry + anti-replay) gates every router-lease read.

**Synchronous-durable, ref-authoritative write ordering (mandatory).** Router-lease renewal MUST complete **synchronously against `GitLeaseStore` (a confirmed fast-forward push to the remote ref)** before the router continues to act as router on the strength of that renewal — never fire-and-forget. The guarantee:
- The router does NOT extend its in-memory notion of "I am still router" until the push that advances its lease generation has been ACCEPTED by the remote (fast-forward confirmed). The MeshRpc/tunnel broadcast of the transition is a latency optimization layered on top (async is fine for the *broadcast*; the *ref-update CAS* is synchronous and authoritative).
- Every lease read — cold-start, periodic verify, and failover election — MUST verify all three of: (1) holder's epoch is current (≥ the epoch floor it last saw), (2) the lease is not stale by the holder's own monotonic-local self-expiry (§L−1 — the holder self-fences; a reader judges authority by epoch, never by comparing wall-clocks), (3) signature is valid. A read failing any of these treats the lease as not-held. Wall-clock comparison by the *reading* machine is never the deciding test (§L−1), which is what removes the divergent-clock split-brain risk.
- A machine that holds a lease in **memory** but cannot confirm it via a fresh ref read MUST invalidate the in-memory copy and defer to the ref (the durable ref is authoritative). This closes the race where a router renews, crashes before the push lands, and a fresh reader would otherwise see a stale tunnel mirror as live.
- **Test:** Tier-1 — router crashes after deciding to renew but before the fast-forward push lands; a fresh read rejects the in-memory/tunnel mirror (epoch floor) and a clean election proceeds; the crashed-then-restarted router does not resume as router without a fresh confirmed fast-forward push.

**Router throughput & scaling.** The router holder owns all channel ingress and runs a per-message placement lookup, so it is a deliberate sequential chokepoint (this is what makes exactly-once trivial) — bounded by the v0.1 pool-size scope above. Bound it:
- `routerMaxThroughputMsgPerSec` (default 500) — sustained inbound message rate a single router is specified to handle with ≤ `maxSessions` concurrent sessions. **Above this rate, or above `routerPoolMaxMachines` machines, v0.1 is explicitly out of its supported envelope** (not "degraded gracefully" — out of scope). Within the envelope, ingress applies backpressure (long-poll batch slows) rather than dropping.
- SessionOwnership lookup latency SLA: **p99 < 10 ms** and MUST NOT degrade with machine count — lookups hit the in-memory/tunnel registry (§L2/L3), an O(1) map keyed by sessionKey, never a git ref read on the hot path (the durable git ref is the contended-CAS authority + cold-start/audit mirror only, not the read path).
- If routing queue depth exceeds `routerQueueDepthAlertThreshold` (default 200 pending placements), the router raises a single deduped Attention item and applies ingress backpressure; it does NOT silently grow the queue unbounded. Sustained saturation is the operability signal that the pool has exceeded the single-router envelope; the v0.1 remedy is fewer sessions per router epoch or faster hardware, surfaced via `/pool status` (`router.queueDepth`, `router.msgPerSec`). Crossing the envelope durably is the trigger for the future sharded-router spec — it is NOT auto-sharded in v0.1.
- **Test:** Tier-2 — measure placement lookup latency as #machines grows from 2→10 (the supported envelope); verify p99 stays < 10 ms (no non-linear degradation because lookups are registry-local, not fan-out); assert `RouterShardKey` maps every key to shard 0.

**Router holder responsibilities:**
- Owns **channel ingress** for the agent (e.g. Telegram long-poll) — see Open Decision #1. This makes exactly-once ingress trivially single-owner (reuse `MessageProcessingLedger`).
- Runs the **placement engine** (L4): for each inbound message, decides which machine owns/runs that session and dispatches.
- The router holder MAY also run sessions itself (it is also a worker).

**Failover:** unchanged machinery — `presumedDeadHolders()` → re-election → new router resumes ingress. In-flight placement decisions are idempotent (keyed on message id via the ledger), so a router handoff cannot double-place or drop.

**Failover at scale (election storm control).** The reused FencedLease machinery was tuned for 2–3 machines; at 20 a router death triggers up-to-20 simultaneous lease-CAS attempts (a thundering herd). Bound it:
- **Staggered election backoff:** candidate machine `i` waits `electionTimeoutMs + (stableHash(machineId) mod N) * staggerDitherMs` before attempting the lease CAS, where `N` = current online machine count. The hash-of-machineId stagger is deterministic (not random) so the same machine consistently gets the same slot, avoiding two machines colliding every round. Config: `electionTimeoutMs` (default 2000), `staggerDitherMs` (default 200).
- **Convergence bound:** for `N` machines, expect election to converge in `< electionTimeoutMs + N*staggerDitherMs + one git-CAS round-trip` (e.g. N=20 → ≈ 2000 + 4000 + git ≈ < 7s) with roughly `1` winning lease-write plus a small number of losing CAS attempts that fail fast on epoch (losers do NOT retry-storm — a failed CAS observes the new holder's epoch and stands down for one full TTL).
- **In-flight ingress during election:** inbound channel messages are NOT polled by anyone during the election gap (the old router stopped, the new one hasn't claimed). On the platform side this is the same as a brief outage: Telegram getUpdates with the same offset replays un-acked updates once the new router resumes; the `MessageProcessingLedger` dedupes any that were mid-processing. No message is lost (platform retains them) and none is doubled (ledger). Buffered output already in `LiveTailBuffer`/`ReplyMarkerTransport` is recovered by the resuming router.
- **Split-brain:** resolved by epoch (lower-epoch self-suspends, per existing FencedLease). Unresolvable partition (router unreachable but maybe-alive, so the lease cannot move) → existing single deduped Attention-queue escalation (one item per partition episode, not per heartbeat).
- **Test:** Tier-3 — kill the router on a 10-machine pool mid-placement; measure election convergence time (assert under bound), verify exactly one new router emerges, and verify no message is lost or doubled across the gap (real-Telegram exactly-once check).

### L2 — Machine-Pool Registry

**Goal:** a live view of which machines are online, how loaded they are, and what each can do — the input to placement.

**Reuse (exists):** `MachineIdentity` registry (`.instar/machines/`), `HeartbeatManager`, the heartbeat HTTP path.

**Build:**
- **MachineCapacity record** (per machine, refreshed on heartbeat): `{ machineId, nickname, online, selfReportedLastSeen, routerReceivedAt, loadAvg, memPressure, activeSessionCount, maxSessions, capabilities[] (e.g. "gpu", "local-model:llama3", "fast-cpu"), modelsAvailable[], agentsResident[], hardware }`. `loadAvg`/`memPressure` reuse `SessionManager.getDiagnostics()`. The machine populates `loadAvg` from a real OS read (`os.loadavg()`), not an agent self-estimate (addresses the [[SleepWakeDetector]] CPU-starvation lesson — capacity must reflect real load).
  - **`hardware` (static machine properties, captured at join + refreshed on version change):** `{ platform (e.g. "darwin"), arch (e.g. "arm64"), cpuModel (os.cpus()[0].model), cpuCores (os.cpus().length), totalMemBytes (os.totalmem()), hostname, instarVersion }`. Read once from `os` at registration (cheap, stable) and surfaced for the dashboard Machines tab + as placement signal (a capability like "fast-cpu"/"gpu" is derived from hardware where detectable). These are reported by the machine itself but, like all self-reported fields, are advisory for display — never an authority for the lease/ownership decisions.
- Published to a fast in-memory/tunnel registry the router reads on every placement (O(1) lookup keyed by machineId), with a slower durable mirror for cold-start. Liveness keys on heartbeat staleness (> failoverThreshold ⇒ offline).

- **Credential-less HTTP presence transport (`PeerPresencePuller`) — REQUIRED for any standby that cannot push to the shared agent repo.** The original presence feed was push-only over the **git-synced** `MachineHeartbeat`: each machine writes its heartbeat into the shared agent repo and peers pull it. That silently excludes a machine that is paired into the mesh over HTTP but lacks push access to that repo (the common real-hardware case: a second machine `gh`-authed to a *different* account). Its heartbeat never reaches the router, so the router marks it `offline` and the placement engine refuses to transfer to it — even though the two machines reach each other perfectly over their tunnels. `PeerPresencePuller` closes this with a **pull-based** channel: on the §L4 router heartbeat cadence (30 s), each machine asks every reachable peer for its self-capacity over the signed §L0 `session-status` MeshRpc command (a read-class command any *registered* peer may issue — it authenticates off the mutual identity established at pairing, no router role or epoch fence required) and feeds the answer into its own `MachinePoolRegistry.recordHeartbeat`. A peer that answers is by definition reachable + alive, so it goes `online` purely over HTTP. Symmetric (every mesh machine runs one) and idempotent with the git path — a credentialed peer that both git-syncs AND answers HTTP simply refreshes twice; `recordHeartbeat` is the single arbiter and the router's-clock liveness rule (below) is unchanged. This is the durable answer to the credential-less-standby gap surfaced by the live-transfer proof; it does NOT replace the git substrate for ownership/placement *records* (§L0), only for the high-frequency presence signal.

- **Clock-skew handling (liveness uses the router's clock, not the machine's).** A machine with a fast clock must not appear fresher than it is. Therefore:
  - The router records `routerReceivedAt` using ITS OWN clock at the moment a heartbeat arrives. `selfReportedLastSeen` (the machine's own timestamp) is retained for debugging only.
  - **Liveness is computed as `now(router) − routerReceivedAt < failoverThreshold`** — never from the machine's self-reported timestamp. Placement freshness/priority likewise uses `routerReceivedAt`.
  - Divergence detection: if `|selfReportedLastSeen − routerReceivedAt|` exceeds `clockSkewToleranceMs` (default 300000), it is NOT merely logged. The tolerance is validated at startup against the clock-sync budget by §L−1's `assertClockSyncHealthy()` — the authoritative rule there requires **`clockSkewToleranceMs ≥ maxExpectedNtpDriftMs * 2` AND `clockSkewToleranceMs ≥ maxAllowedClockErrorMs`**, with a hard error at boot if violated, so a tolerance is never set tighter than 2× the realistic NTP drift and never paired with a larger real clock-error budget.
  - **Quarantine state machine (explicit — not just an outcome).** `MachineCapacity` carries a `clockSkewStatus` field with a three-value enum and an explicit transition table, so every implementation and recovery path is identical (no divergence):
    - **States:** `ok` | `divergence-detected-once` | `suspect-clock-removed`.
    - **`removed-clean-count`** (internal counter): consecutive in-tolerance heartbeats observed since entering `suspect-clock-removed`, used only for re-admission.
    - **Transitions (evaluated by the router on each heartbeat, using `|selfReportedLastSeen − routerReceivedAt|` vs `clockSkewToleranceMs`):**

      | Current state | This heartbeat | → Next state | Side effect |
      |---|---|---|---|
      | `ok` | in tolerance | `ok` | — |
      | `ok` | divergent (1st) | `divergence-detected-once` | logged only — NOT removed |
      | `divergence-detected-once` | divergent (2nd consecutive) | `suspect-clock-removed` | **removed from placement** + 1 deduped Attention item |
      | `divergence-detected-once` | in tolerance | `ok` | reset counter (one divergent beat is forgiven) |
      | `suspect-clock-removed` | divergent | `suspect-clock-removed` | stays removed; `removed-clean-count` reset to 0 |
      | `suspect-clock-removed` | in tolerance (1st) | `suspect-clock-removed` | `removed-clean-count = 1` (NOT yet re-admitted) |
      | `suspect-clock-removed` | in tolerance (2nd consecutive) | `ok` | **re-admitted to placement** (`removed-clean-count` reached 2) |

    - **Semantics:** a SINGLE divergent beat never removes a machine (it only arms `divergence-detected-once`); removal requires 2 consecutive divergent beats; re-admission requires 2 consecutive in-tolerance beats. While `suspect-clock-removed`, the machine is not preferred, not assigned new sessions, and its running sessions are eligible for rebalance off it. A sustained-skew machine therefore CANNOT remain in the pool slowly degrading placement quality or emitting stale load reports — quarantine is the safety boundary. This is the placement-side companion to §L−1's `assertClockSyncHealthy()` JOIN refusal: a machine whose clock goes bad *after* joining is quarantined on the next divergence rather than allowed to linger. `clockSkewStatus` is exposed verbatim via `/pool` status so every transition is observable.
  - **Test:** Tier-1 — a machine reporting a far-future `selfReportedLastSeen` is not preferred in placement and is marked offline on `routerReceivedAt` staleness; the skew warning is logged. Tier-2 — drive the full state machine on a pool machine: 1 divergent beat then 1 clean beat → flagged `divergence-detected-once` then back to `ok`, NOT removed; 2 consecutive divergent beats → `suspect-clock-removed` + removed from placement + Attention item; then 2 consecutive in-tolerance beats → re-admitted (`ok`); assert each `clockSkewStatus` transition is visible via `/pool` and `clockSkewToleranceMs ≥ maxExpectedNtpDriftMs * 2` is enforced at startup.

- **Registry lifecycle & memory management.** MachineCapacity is small (one record per machine, bounded by pool size). SessionOwnership (§L3) is the one that grows with session count and needs an explicit budget — specified there. The MachineCapacity registry evicts a machine record only when it has been offline (`routerReceivedAt` stale) longer than `machineRecordEvictionMs` (default 86400000 = 24h), so a briefly-offline machine keeps its capabilities/history for fast re-placement.

#### Machine Nicknames (auto-assigned, user-editable, the user-facing handle)

Users should never have to type a raw `machineId` (`m_a3f9…`). Every machine carries a friendly **`nickname`** that is the user-facing way to name it — for the Machines dashboard tab and for "run this on `<nickname>`" / "move this to `<nickname>`" placement & transfer commands (§L4).

- **Auto-assignment at join (deterministic, collision-free).** When a machine first registers (`MachineIdentityManager.registerMachine`), if it has no nickname the agent assigns one derived from the machine's own properties — preferring a sanitized `hostname` (e.g. `Justins-MacBook-Pro.local` → `"MacBook Pro"`), falling back to a `"<platform>-<arch>"` label (`"mac-mini"`, `"linux-x64"`), and disambiguating collisions with a numeric suffix (`"mac-mini 2"`). Assignment is performed once and persisted in the machine registry; it is **idempotent** (a machine that already has a nickname keeps it). A `NicknameAssigner` pure helper owns the derivation so it is unit-testable (same inputs → same nickname) and the collision rule is deterministic across machines reading the same registry.
- **User-editable.** The nickname is mutated ONLY through an authenticated surface: `PATCH /pool/machines/{machineId}` `{ nickname }` (Bearer-auth, like all instar routes) or the Machines dashboard tab's inline edit. A rename validates the new value (`^[\w][\w \-]{0,40}$`, non-empty, unique within the pool — a collision is rejected, not silently suffixed, so the user sees the conflict) and writes it to the durable machine registry; the change syncs to peers via the existing registry sync. The nickname is metadata only — renaming a machine NEVER moves a session or changes ownership/lease state.
- **Nickname → machineId resolution** is a registry lookup used by the placement/transfer commands (§L4 "Topic Placement Updates"): a `"<nickname>"` in a pin/transfer request resolves to its `machineId` (case-insensitive, exact match after trim); an unknown or ambiguous nickname is rejected with a clear error (`unknown-machine-nickname`) listing the valid nicknames — never a silent mis-route.

#### Machines Dashboard Tab (the user-facing pool view)

A new **"Machines" dashboard tab** (per **THE Dashboard Standard** — plain-language ELI16 copy, no jargon, expandable items, fixed status vocabulary) shows every machine the agent is installed on:
- **Per machine:** the editable **nickname** (inline-edit, save on enter), an **online/offline** status dot (fixed vocabulary), the **hardware** properties (CPU model + cores, total RAM, platform/arch — rendered in human terms, e.g. "Apple M2 · 8 cores · 16 GB"), live **load** (busy/idle in plain words, derived from `loadAvg`/`memPressure`), **how many conversations** it is currently running (`activeSessionCount` / `maxSessions`), and its **capabilities** (e.g. "GPU", "local model: llama3"). A `suspect-clock` machine shows a calm "clock out of sync — paused for new conversations" note (not an error).
- **Backed by** `GET /pool` (existing route, extended with `nickname` + `hardware` per machine) and `PATCH /pool/machines/{machineId}` for rename. No new auth model — Bearer-token + dashboard PIN as with every other tab.
- This tab is also where the user learns the nicknames they can use in "move this to `<nickname>`" — it is the discovery surface for the transfer-by-nickname command.

### L3 — Per-Session Ownership

**Goal:** exactly one machine runs a given session at any instant; ownership is movable and fenced.

**Build:**
- **SessionOwnership record** (keyed by conversation unit — see Open Decision #4, default = topic id): `{ sessionKey, ownerMachineId, ownershipEpoch, status: 'placing'|'active'|'transferring'|'released', nonce, timestamp, updatedAt, signature }`. The record is Ed25519-signed by the writer (mesh-signed CAS, not a full lease ceremony) so the registry is tamper-evident.
- **Distributed Session Registry** — answers "which machine holds session X." Durable (git) for correctness + tunnel mirror for speed. The router is the single writer in steady state (it assigns), but ownership changes during transfer use **CAS at ownershipEpoch+1** (reuse the FencedLease CAS discipline at per-session granularity) so a transfer can never split ownership even if the router changes mid-transfer.
- **Exactly-one-owner invariant** enforced structurally: a worker refuses to run a session it does not own at the current epoch+status; `claim` only succeeds via CAS at `epoch+1`. The state machine (NOT a release-before-claim ordering — see "Handoff ordering" below) is the sole authority on who may run.

This is the per-session generalization of the single agent lease. It is intentionally lighter than the router lease (no full Ed25519-signed-lease ceremony per message — a signed CAS record on the authenticated mesh suffices), because the router lease already gates who may write ownership.

#### CAS Contention & Replay Protection

Unlike the router lease (ONE lease point), SessionOwnership has thousands of independent per-session CAS points, so contention and replay must be specified per-session:
- **Anti-replay:** every CAS attempt carries a `nonce` (unique per attempt, checked against `NonceStore` before the write is accepted — a replayed CAS record is rejected) and a `timestamp` (must be within `ownershipCasClockToleranceMs`, default 30000, of the receiver's clock). The `NonceStore` for ownership CAS is durable across restarts (persisted alongside the registry) so a restart cannot re-open a replay window.
- **NonceStore is scoped PER-SESSION (explicit — not a global nonce space).** The nonce-uniqueness key is the tuple `{ sessionKey, sender, ownershipEpoch }`, NOT a global nonce namespace. A nonce consumed by a session-A ownership CAS therefore CANNOT collide with the same nonce value used in a session-B ownership CAS — the store key includes `sessionKey`, so the two live in independent nonce spaces. This is the correct model precisely because per-session CAS points are independent (one-file-per-session — see "Write Amplification"): a replay window must be reasoned about within a single session's CAS sequence, and a global nonce space would let unrelated session-B traffic spuriously reject a legitimate session-A retry. (Nonces are UUID-based, so accidental cross-session collision was already negligible; scoping the key per-session removes even the theoretical interference and matches the per-session ref independence.)
- **Test (nonce isolation):** Tier-1 — session-A and session-B each CAS with the SAME nonce value `N1`; verify BOTH succeed (independent per-session nonce spaces — the `{sessionKey,…}` key disambiguates them), and that replaying `N1` WITHIN session-A is rejected (replay protection holds inside each session's space).
- **The ref-update decides the winner; `machineId` only orders retries (corrected).** Per-session CAS resolves against the **single-ref fast-forward push** of §L−1, NOT a "naive fetch→check→push race" (a non-fast-forward push is rejected server-side, so the loser cannot silently both-win) and NOT any external store. When two machines attempt CAS to `ownershipEpoch+1` for the same session simultaneously, **the remote ref-update decides** — exactly one push fast-forwards the session's ownership ref from `e`→`e+1` (the one that landed first server-side); the other is rejected non-fast-forward, fetches, observes `e+1`, and runs nothing. **The remote does NOT consult `machineId`.** The **lowest-`machineId`** rule is purely a CLIENT-SIDE retry-ordering hint: after a rejection, the loser computes a retry delay biased so the lowest-`machineId` contender retries first, reducing a second collision round. It is NEVER the compare condition and never the arbiter of the first round. (This withdraws any prior reading that "lowest machineId wins" was the CAS semantics — see §L−1.) Every observer agrees on the winner because they all read the same durable ownership ref tip, not because they compute the same machineId comparison. (Same-session contention is the only contention: ownership records are one-file-per-session — §"Write Amplification" — so distinct sessions never touch the same ref path.)
- **Loser behavior:** the loser does NOT retry-storm. It backs off with exponential jitter (`ownershipCasRetryBackoffMs` 50→500ms) up to `ownershipCasMaxRetries` (default 5); on exhaustion it escalates to the router (the contention is pathological — e.g. a rebalance storm) rather than spinning. A session never lands in limbo: if the winner subsequently fails to reach `active`, the router's heartbeat re-evaluation (§L4) re-places it.
- **CAS-failure metrics** (`/pool status`: `ownership.casConflicts`, `ownership.casRetryExhaustions`) let the router detect pathological contention and throttle rebalancing.
- **Test:** Tier-1 — two machines CAS the same session at `epoch+1` simultaneously, verify exactly one owner emerges **via the remote ref-update (the fast-forward push that landed first)** (assert the winner is the ref-update-first writer, NOT chosen by machineId comparison) and the loser is rejected non-fast-forward, observes `e+1`, and fails cleanly; a replayed CAS record (reused nonce) is rejected; measure CAS round-trip p99; Tier-2 — 100 concurrent CAS attempts on one session, verify exactly one owner and measure p99 latency.

#### Handoff Ordering (authoritative — resolves the release/claim sequencing)

Ownership handoff is **claim-before-release, gated by a state machine** — NOT "release before claim." The single authoritative ordered sequence for a planned transfer of session `K` from source `S` to target `T` is:

```
active(owner=S, epoch=e)
  → transferring(from=S, to=T, epoch=e+1)   // CAS by router/source; S stops accepting new turns
  → active(owner=T, epoch=e+2)              // T claims via CAS once state is synced + ledger flushed
  → S releases (tears down its local session)  // release is the LAST step, after T is active
```

A worker obeys the `status`+`epoch` fence: `S` runs only while it observes `active(owner=S)` at its epoch; the moment the record advances to `transferring`, `S` stops accepting new turns (it may finish a draining reply — §L5). `T` runs only once it has CAS'd itself to `active(owner=T, epoch=e+2)`. Because the fence is the status+epoch (not the physical release), there is **no double-run** (only one machine ever sees itself as `active` owner at the top epoch) and **no no-owner gap** (the record always names a current owner — `transferring` still names `S` as the draining owner until `T` is active). `release` is a cleanup step, not a precondition for `T`'s claim.

**Mutual exclusion on user-facing OUTPUT (distinct from the run-fence).** The status+epoch fence guarantees only one machine *runs* the agent at the top epoch — but `transferring(S)` and the subsequent `active(T)` overlap in time while `S` drains, so without an explicit rule both `S` (finishing its drain) and `T` (emitting CONTINUATION) could write to the user channel and the platform would show interleaved/duplicate output. The spec therefore adds an explicit output-exclusion contract on top of the run-fence:
- The instant `S` writes `transferring`, it starts a **bounded drain window** `transferOutputCutoffMs` (default 1000). `S` MAY emit the tail of an already-in-flight reply during this window, but MUST emit **no NEW** channel output, and MUST stop ALL channel emission when the window elapses — any still-in-flight output past the cutoff is abandoned (best-effort), not sent.
- `T` MUST NOT emit ANY user-facing channel output until its CAS to `active(owner=T, epoch=e+2)` has returned `{ok:true}` AND it has confirmed (via the §L5 ledger-flush ACK) that `S`'s drain window has closed or `S` is gone. In the planned-transfer path `T` deliberately holds its CONTINUATION until `transferOutputCutoffMs` has elapsed since the `transferring` write (a value the router stamps and shares), so the two emission windows are disjoint by construction.
- **Residual-overlap honesty:** if a redelivered/late `S` reply nonetheless reaches the platform after `T`'s CONTINUATION (network reorder beyond the cutoff), the `MessageProcessingLedger` + `ReplyMarkerTransport` dedupe the *reply marker* so the user is not shown two answers to the same turn; in the rare case the platform itself surfaces both before dedupe, the CONTINUATION text already frames it ("picking this up over here") so the user is never silently confused. The exactly-once guarantee (Invariant #3) is on *replies*, not on raw platform frames — see the restated invariant.
- **Test:** Tier-2 — inject an in-flight `S` reply, advance to `transferring`, have `T` claim and stand ready; verify (a) `S` emits no new output after `transferOutputCutoffMs`, (b) `T` emits its CONTINUATION only after the cutoff window, (c) the channel shows exactly one continuation for the turn (no double-send, measured by reply-marker dedupe count, not instar's owner-fence alone).

This corrects the earlier "release is required before the new owner's claim is honored" wording — that phrasing is withdrawn; the guarded state transitions above are the sole protocol (and Invariant #2 is restated to match).

**Test:** Tier-1 — drive the state machine through `active(S)→transferring→active(T)→S-release`; assert no intermediate state allows two `active` owners and no state has zero owner; assert a `claim` attempt out of sequence (e.g. `T` claims before `transferring`) is rejected.

#### Write Amplification & Optimization (git, at scale)

Each ownership change CASes the durable (git) registry. At org-scale (e.g. 1000 sessions × 50 machines) a single worker going offline could trigger up to N ownership re-placements (one per session it owned), each a git write. To keep this from becoming a write storm / repo-bloat / merge-conflict problem:
- **Worst-case bound documented:** single-worker-offline with `N` sessions on that worker ⇒ up to `N` re-placement CAS writes (one per orphaned session) + ledger updates.
- **Batching does NOT weaken per-session CAS independence (explicit — the linearization point stays per-session).** Each per-session ownership CAS is its OWN logical operation with its OWN linearization point: advancing THAT session's ref-file from `e`→`e+1` via a fast-forward push (§L−1). Batching is purely a durable-write *efficiency* layer on top and never shares a fast-forward decision across sessions:
  - Successful, already-decided per-session CAS *results* (each having independently won or lost its own fast-forward) produced within `sessionOwnershipBatchWindowMs` (default 100) are folded into ONE git commit for push efficiency (many record-file updates, one commit/push). The in-memory/tunnel mirror still updates per-record immediately for hot-path lookups; only the durable push batches. This bounds git push frequency to ≤ 10/sec under churn regardless of session count.
  - **Crucially, the fast-forward decision is per-session-ref, not per-batch-commit.** Because each session is a distinct ref-file (one-file-per-session, below), a CAS contends ONLY with another CAS to the SAME session's ref. If session-K's CAS loses (non-fast-forward on K's ref), **only session-K retries** — the unrelated sessions folded into the same batch commit are unaffected (their ref-files advanced cleanly). A batch is never re-tried wholesale; a contended session is re-tried alone. (Formally: there is no shared ref tip across sessions in a batch — the batch commit touches N independent ref-files, each of which fast-forwarded on its own; a later contender for one of them collides only with that one file.)
- **Merge-conflict avoidance:** ownership records are stored one-file-per-session (or a sharded layout) so concurrent CAS to DIFFERENT sessions never touch the same file — git merges them trivially; only same-session CAS contends, and that is resolved by the §L−1 single-ref fast-forward push (the remote ref-update decides; the deterministic lowest-`machineId` rule only orders retries), not by git merge.
- **Test (per-session CAS independence under batching):** Tier-2 — drive 100 concurrent CAS attempts across 100 DISTINCT sessions, with exactly one session contended by a second writer; assert the 99 uncontended sessions each commit cleanly within the batch and the ONE contended session retries ALONE (verify retry count is per-session, not per-batch — the batch is not re-tried wholesale).
- **Repo-bloat control:** `released` records are soft-deleted and GC'd per the registry memory policy below; the git history of ownership churn is periodically squashed by the existing GitSync compaction path so the registry tree does not grow unbounded.
- **Interop with existing git-state-sync:** ownership-registry writes go through the same `GitSync` funnel the agent already uses for state, on a dedicated path/branch namespace, so multi-machine ownership Gitops never races the agent's content state-sync (verified by a Tier-2 test that runs ownership churn concurrently with a content sync and asserts neither corrupts the other).
- **Test:** Tier-2 — N concurrent CAS attempts across N distinct sessions, measure git-write p99 latency and assert batching holds push frequency under the cap; assert ownership Gitops does not conflict with a simultaneous content state-sync.

#### Registry Lifecycle & Memory Management

SessionOwnership grows with live session count (e.g. 1000 sessions × 20 machines = 20k ownership records). Bound the in-memory registry:
- **Per-session metadata size estimate:** ≈ 200 bytes; 50k sessions ≈ 10 MB — small, but bounded explicitly so it can never grow without limit.
- **Budget + eviction:** `maxOwnershipRegistryBytes` (default 104857600 = 100 MB). When exceeded, evict by LRU on `lastSeen` for records whose `status === 'released'` AND `lastSeen` older than `evictionPolicyLru.lastSeenAgeMs` (default 86400000 = 24h). `active`/`transferring`/`placing` records are NEVER evicted (a live session must always have an owner record). If the budget is hit with no evictable (`released`/stale) records, raise an Attention alert (genuine capacity pressure) rather than evicting a live owner.
- **GC frequency:** released-record sweep runs on the router heartbeat interval; impact is a bounded map scan.
- **Cold-start recovery:** on router restart the in-memory registry is rebuilt from the git mirror. Recovery time is bounded and instrumented; **Test:** Tier-2 — kill the router with a full (e.g. 20k-record) registry, restart, measure rebuild time and assert it completes within `coldStartRebuildBudgetMs` (default 5000).
- **Instrumentation:** `/pool status` exposes `registry.bytes`, `registry.sessionCount`, and a `registry.memoryPressure` flag.

### L4 — Session Router / Placement Engine

**Goal:** the core new capability — place each conversation on the best-fit machine and dispatch.

**Build (runs on the router holder):**
- On inbound message for session key `K`:
  1. Look up `SessionOwnership(K)`.
  2. **Owned + owner alive** → forward the message to the owner over MeshRpc via the `deliverMessage` command (or handle locally if router == owner — no MeshRpc hop). Owner resumes/continues the session (existing `--resume` / TopicResumeMap path). The full delivery contract — signature, idempotency, ACK ordering, timeout/retry, fallback — is specified in "Message Routing to Owner" below.
  3. **Unowned (new conversation)** → run **placement policy** (`PlacementExecutor.decide()`) → **synchronous CAS-claim** ownership for the chosen machine (see "Ownership CAS at Dispatch" below) → instruct it to spawn (existing `SessionManager.spawnSession`).
  4. **Owner dead** → re-place via policy → instruct new owner to **spawn-resume from channel history** (failover; existing CONTINUATION path).

#### PlacementExecutor (the canonical placement component — architecturally grounded)

Per the P1 "Structure > Willpower" principle, placement is NOT pluggable code that each agent could implement differently. ALL placement decisions route through a single canonical component:
- **Lives at `src/core/PlacementExecutor.ts`** (core instar, NOT a per-agent hook). It is dependency-injected into the router/message-dispatch path; the router never inlines its own placement logic.
- **Contract (typed input → typed output):**
  ```
  decide(req: PlacementRequest): PlacementDecision
    PlacementRequest  = { sessionKey, topicMetadata: TopicPlacement, machineRegistry: MachineCapacity[], currentOwner?: MachineId, reason: 'new'|'failover'|'rebalance'|'pin' }
    PlacementDecision = { chosenMachine: MachineId | null, score: number, reason: string, outcome: 'placed'|'queued'|'placement-blocked', escalationReason?: string }
  ```
  `decide()` is **pure** over its inputs (no I/O, no clock read beyond the registry's `routerReceivedAt` freshness already on each record) so it is deterministic and unit-testable; the CALLER (router) performs the CAS and the side effects (spawn/transfer/queue) based on the returned `PlacementDecision`.
- **Integration with dispatch:** the router calls `PlacementExecutor.decide()` **synchronously** in the inbound-message path (step 3/4 above) BEFORE the ownership CAS; the returned `chosenMachine` is the CAS target. It is wired (not mocked) in the router tests.
- **Policy is structured DATA (JSON), not code.** The executor consumes the policy as a JSON object validated against a fixed schema — `PlacementPolicy = { weights: { loadAvg, activeSessionRatio, memPressure }, thresholds: { rebalanceThresholdPercent, placementHysteresisDelta }, capabilityWhitelist: string[], ordering: ('hard-constraint'|'pin'|'sticky'|'least-loaded')[] }`. A custom policy is expressible ONLY as config (weights, thresholds, ordering) within this schema; introducing genuinely new decision LOGIC requires an explicit feature-flag + its own test coverage, never an ad-hoc per-agent override. The policy JSON is **schema-validated at startup**: an invalid policy (unknown weight key, non-numeric threshold, capability token outside the whitelist vocabulary) is a hard startup error (the machine refuses to act as router with a malformed policy), never silently defaulted. This guarantees every agent in a pool makes consistent placement decisions. (Documented here so a reviewer can't read "pluggable" as "diverge freely" — it is data-driven and centralized.)
- **Test:** Tier-1 — `PlacementExecutor` is wired (not mocked) in router tests; a real `PlacementPolicy` JSON parses and produces the expected `PlacementDecision` for each boundary (capable/incapable, pinned/unpinned, loaded/free); an invalid policy JSON (bad weight key / unknown capability) is rejected at startup with a hard error; `decide()` is asserted pure (same inputs → same output, no I/O).

#### Message Routing to Owner (the L4 core dispatch path — fully specified)

When `SessionOwnership(K)` resolves to an alive owner that is NOT the router itself, the router forwards the inbound message over MeshRpc. This is the core new dispatch logic; its contract is exact:
- **MeshRpc command signature:** `deliverMessage(sessionKey, messageId, payload, ownershipEpoch)` — carried inside the §L0 signed, recipient-bound envelope (so it is Ed25519-signed for the specific owner machine, nonce + timestamp replay-protected, and refused if the recipient is wrong). `ownershipEpoch` is the router's view of the owner's epoch at dispatch; the owner rejects the delivery (`stale-ownership`) if its own epoch has advanced past it (the session moved), prompting the router to re-resolve ownership.
- **Idempotency key = `messageId` (the platform event id).** The owner records `messageId` in its `MessageProcessingLedger` before processing; a redelivered `deliverMessage` with a `messageId` already marked processed/replied is **dropped (ACKed as `duplicate`)** and NOT re-processed. This is the same dedupe key the ledger already uses for direct ingress — so a router handoff that redelivers a message in flight cannot double-process it.
- **ACK protocol (router ACKs the platform only after the owner ACKs receipt — NOT after the reply).** The owner returns `deliverMessageAck = { messageId, accepted: 'queued'|'duplicate'|'stale-ownership' }` confirming it has DURABLY recorded the message (ledger entry written) before the router treats the platform update as handled (advances the Telegram `getUpdates` offset). The ACK confirms *receipt into the owner's ledger*, not reply completion — replies stream back over the channel via the owner's own egress (the owner owns its channel output for that session within the §L3 output-exclusion rule). This keeps ingress exactly-once (offset only advances after durable receipt) without coupling it to reply latency.
- **Timeout + retry:** `deliverMessageTimeoutMs` (default 5000) per attempt; on timeout or transport error the router retries with exponential backoff (`deliverMessageRetryBackoffMs` 250→2000) up to `deliverMessageMaxRetries` (default 3). Retries carry the SAME `messageId` (idempotency key), so a retry after a delivered-but-lost-ACK is deduped by the owner's ledger — a retry can never double-process.
- **Fallback if owner unreachable (after retry exhaustion):** the router does NOT silently drop the message. It (a) marks the owner suspect (heartbeat-corroborated — if §L2 also shows the owner stale, it is treated as dead), (b) re-resolves via the **owner-dead** path (step 4: re-place + spawn-resume-from-channel-history), and (c) the platform-side message is NOT acked until the new owner ACKs `deliverMessage` — so the inbound is never lost (Telegram replays the un-acked update). If no capable machine is available, the message is queued (§"Queued Session Lifecycle") and an Attention item is raised.
- **Ordering guarantee (per session):** the router dispatches `deliverMessage` for a given `sessionKey` strictly in inbound order and does NOT dispatch the next message for that session until the prior one is ACKed (`queued`/`duplicate`) — in-order, at-most-one-in-flight per session. (Different sessions are independent and dispatched concurrently.) This preserves conversational turn order through the owner; it is bounded by the single-router sequential-ingress design (§L1).
- **Test:** Tier-2 — send a message → router → machine-B (owner) via `deliverMessage` → machine-B writes the ledger entry, ACKs `queued`, processes, and the reply routes back over the channel; assert the router advances the platform offset only after the `queued` ACK. Redeliver the SAME `messageId` (simulate a retry after a lost ACK) → machine-B ACKs `duplicate` and does NOT re-process (verify ledger dedupe). Kill machine-B mid-dispatch → router exhausts retries, falls back to owner-dead re-placement, and the inbound is NOT lost (replayed to the new owner, processed exactly once).

#### Ownership CAS at Dispatch (synchronous, contention-handled — exactly-one-owner at dispatch time)

Step 3/4's "CAS-claim ownership" is **synchronous and blocking**, never fire-and-forget — this is what enforces Invariant #2 (exactly-one-owner) at the dispatch point rather than racing it:
- **The router runs `PlacementExecutor.decide()` → then performs the ownership CAS SYNCHRONOUSLY** (the per-session single-ref fast-forward push of §L−1/§L3) before the message is routed. The message dispatch BLOCKS on the CAS result; the owner is not instructed to spawn/resume until the CAS returns `{ok:true}`.
- **If the CAS fails (non-fast-forward — another router or a failover race claimed the session first):** the router does NOT route the message to an unconfirmed owner. It re-reads `SessionOwnership(K)` (the CAS rejection means the ref already advanced); if the session is now owned by a live machine, the router forwards via `deliverMessage` to THAT owner (the contention resolved to a valid owner — route there). If the session is in a transient state (`placing`/`transferring`) it queues the message with `queueReason: 'ownership-contention'`.
- **Retry ownership of a contended/transient session:** the router re-evaluates ownership-contention-queued messages on the next heartbeat (and on any ownership-change MeshRpc broadcast for that session), retrying the CAS via the §L3 `ExponentialBackoff` (`ownershipCasRetryBackoffMs` 50→500, up to `ownershipCasMaxRetries`). The ROUTER (not the PlacementExecutor, which is pure) owns the retry loop.
- **On CAS retry exhaustion:** escalate — a message that cannot find a stable owner after `ownershipCasMaxRetries` raises a single deduped Attention item (`reason: 'ownership-unresolved'`) and the message stays queued (never dropped — a queued-indefinitely message is an operability signal, not data loss).
- **Test:** Tier-2 — inject two routers CAS-claiming the SAME unowned session concurrently (a failover race): verify exactly one CAS fast-forwards (the winner per §L−1, not by machineId), the loser re-reads ownership and forwards the message to the winning owner (or queues if transient), and the message is processed exactly once (not dropped, not doubled).
- **Placement policy (the canonical executor's default ruleset):**
  - Hard constraints first: required `capabilities` from topic metadata (e.g. needs gpu / a local model) and an explicit user **pin** (`preferredMachine`). A pin or unmet hard constraint with no capable online machine → queue + escalate (never silently mis-place). Pinned-vs-failover semantics and the queue lifecycle are specified below.
  - Among capable machines: **sticky-by-default** (Open Decision #3) — keep a session where it is; for a NEW session, pick the least-loaded capable machine (`loadAvg`, `activeSessionCount` vs `maxSessions`).
  - User preferences (per-topic + global) override the load heuristic within the capable set.

- **Placement stability & hysteresis (anti-thrash).** Sticky-by-default is not enough on its own; aggressive rebalancing could oscillate a session between two near-balanced machines. The executor applies:
  - **Hysteresis:** re-place a RUNNING session only if the best alternative machine is better than the current one by at least `placementHysteresisDelta` (default 0.15 = 15%) on the load score. Within the hysteresis band, the current machine wins.
  - **Cool-down:** on transfer, stamp `lastTransferredAt`; the session is NOT considered for re-placement again for `placementCooldownMs` (default 300000 = 5 min). A hard user-pin bypasses cool-down (explicit intent always wins).
  - **Locality affinity:** when load is within the hysteresis band, prefer the session's current machine as tie-breaker (`affinityEnabled`, default true).
  - **Test:** Tier-1 — a session offered two machines whose loads stay within the hysteresis band settles on one and does not thrash across heartbeats.

- **Load-rebalance trigger conditions.** Rebalance must not starve new-session placement or cascade:
  - Rebalance is evaluated ONLY on the heartbeat interval (`rebalanceIntervalMs`, default 30000) — NEVER per inbound message, so a message never triggers a cascade of transfers.
  - A machine is a rebalance source only if its load exceeds `rebalanceThresholdPercent` (default 0.85 of `maxSessions`/load ceiling).
  - Rebalance moves only low-priority/low-resource sessions (`rebalanceLowPriority`, default true); critical or hard-pinned sessions are never proactively rebalanced.
  - New-session placement always takes priority over rebalance within a heartbeat tick (place arrivals first, then rebalance with leftover headroom), so rebalancing can never indefinitely starve arrivals.
  - **Test:** Tier-2 — spike one machine's load; verify rebalance fires once on the heartbeat (not on every subsequent message) and does not cascade.

- **Placement decision durability (idempotency across router crash) — with an explicit staleness + liveness gate.** Placement decisions are load-dependent, so re-evaluating after a crash could pick a different machine and violate the message-id idempotency promise. But blindly re-using a memo from a crashed router can pin a session onto a machine that died during the same outage. The recovering router therefore applies an explicit freshness AND liveness check before honoring a memo:
  - When the router decides a placement for `messageId`, it memoizes the decision (`PlacementMemo = { messageId, sessionKey, chosenMachine, decidedAtMonotonic, loadSnapshotTs }`) to a durable cache BEFORE issuing the CAS.
  - **Memo reuse is gated by an explicit staleness check in the recovering router:** the recovering (or newly-elected) router discards a memo older than `placementMemoStaleThresholdMs` (default 30000 = 30 s, deliberately half the lease TTL so a memo can never outlive a router generation) — measured against monotonic-local elapsed where available, falling back to `decidedAtMonotonic`/`loadSnapshotTs` comparison. A discarded-as-stale memo means the router re-evaluates fresh (the original load snapshot is too old to trust).
  - **AND it verifies the memoized target is still online** (present + live in the §L2 registry by `routerReceivedAt` freshness) before reuse. If the memoized `chosenMachine` is offline/quarantined, the memo is invalidated and the router re-evaluates against the current pool (this is the failover-during-router-crash case — the memo must not pin a dead target).
  - Only a memo that is BOTH fresh (within the staleness threshold) AND points at a still-online machine is reused verbatim; this is the idempotency/freshness trade-off, documented explicitly: fresh+live ⇒ honor the prior decision (idempotency wins); stale OR dead-target ⇒ re-evaluate (correctness wins). The memo is soft-deleted once the CAS succeeds (or after `placementMemoTtlMs`, default 60000, if the message was never finalized).
  - **Test:** Tier-2 — (a) router decides a placement, crashes before CAS, recovers within the staleness threshold with the target still online → recovering router places on the memoized machine, not a fresh evaluation; (b) the memo is older than `placementMemoStaleThresholdMs` → it is discarded and the router re-evaluates fresh; (c) the memoized target went offline during the crash → the memo is invalidated and the session is re-placed on a live machine (not pinned to the dead target).

- **Topic metadata** — extend the per-topic store (sibling of `TopicFrameworksStore`): `TopicPlacement = { preferredMachine?, requiredCapabilities?[], pinned?: boolean, lastTransferredAt?, queueReason? }`. Updates with the topic. The update surface is an explicit, validated, rate-limited route — NOT free-form text inference (see "Topic Placement Updates" below).

#### Topic Placement Updates (mutability surface)

"Mutable conversationally" does NOT mean parsing any message text. A session transfer is a high-impact action, so updates are gated:
- **Whitelisted command grammar only.** `TopicPlacement` mutates ONLY from a small set of recognized structured commands — `run this on <nickname>`, `move this to <nickname>`, `/pin <nickname>`, `/unpin` — parsed by a dedicated command recognizer. Arbitrary free-form message text, captions, or stickers that merely contain a phrase like "run this on the mini" mid-sentence do NOT mutate placement. (The recognizer matches a command shape at the start of an intentional command, not substring presence.)
  - **`<nickname>` is the user-facing machine handle** (§L2 "Machine Nicknames") — the user names a machine by its friendly nickname ("mini", "MacBook Pro"), never a raw `machineId`. The recognizer resolves `<nickname>` → `machineId` via the §L2 case-insensitive registry lookup. An unknown/ambiguous nickname is rejected with the valid-nickname list (no mutation, no silent mis-route — `unknown-machine-nickname`).
  - **`run this on <nickname>` / `/pin <nickname>`** set `preferredMachine` + `pinned: true` (a hard pin) and trigger a transfer if the session is not already on that machine. **`move this to <nickname>`** is the explicit-transfer phrasing: it transfers the session to `<nickname>` for THIS conversation (sets `preferredMachine`, `pinned: true`) — the mid-conversation swap-by-nickname that is the headline test-as-self proof (§Testing Strategy). `/unpin` clears the pin (the session reverts to normal placement, staying put until real pressure).
- **Validation on parse** (see "Topic Placement Validation" below) — an unknown/offline machine name returns an error to the user immediately, never a silent mis-place.
- **User confirmation required** when the requested `preferredMachine` is not currently online, or differs from the current owner AND the session is mid-reply — the agent confirms ("move this to <machine>? it'll be like a fresh-session catch-up") before triggering the transfer.
- **Rate-limited:** at most one placement update per topic per `topicPlacementUpdateMinIntervalMs` (default 10000 = 10s); excess updates are rejected with a "give it a moment" reply, defeating accidental rapid-fire transfers.
- **Audited:** every update is logged to the audit trail with the source message id + timestamp + before/after.
- **Test:** Tier-1 — a free-form message whose body merely CONTAINS "run this on mini" (not as a command) does NOT mutate `TopicPlacement`; a second `/pin` within the rate-limit window is rejected.

#### Topic Placement Validation (no silent mis-placement)

Validation runs at THREE points so an invalid pin can never silently default to the wrong machine:
- **Schema-validate-on-read (the corruption gate — block + escalate, NEVER infer/sanitize).** The stored `TopicPlacement` record is read on every placement; before it is used it is STRICTLY schema-validated against a fixed schema, and a malformed record is treated as a hard fault, not coerced:
  - `preferredMachine` — `null` OR a string matching `^[a-z0-9][a-z0-9-]{0,62}$` (the machine-name regex). Any other shape (number, object, garbage string with disallowed chars) → invalid.
  - `requiredCapabilities` — `undefined`/`null` OR an array of strings drawn ONLY from the recognized-capability whitelist (`gpu`, `fast-cpu`, `local-model:*`, … — the same vocabulary `MachineCapacity.capabilities` advertises). An unknown capability token, a non-array, or a non-string element → invalid.
  - `pinned` — strictly a boolean (`true`/`false`). A string `"true"`, a number, `null` where a boolean is required → invalid.
  - On **any** schema violation the placement engine does NOT guess, default, or sanitize the field. The session is marked `status: 'placement-blocked'` with `escalationReason: 'topic-metadata-invalid'`, a single deduped Attention item is raised (citing the exact offending field + value), and the session is queued (it does not run on an arbitrary machine). The corrupt record is left untouched (not auto-rewritten) so the operator can see what was wrong; clearing it requires an explicit valid `/pin`/`/unpin` command.
- **On command parse:** `run this on X` / `/pin X` immediately validates that `X` exists in the current pool. Unknown name → error reply to the user ("I don't have a machine called X; I'm on: <list>"), no mutation.
- **Pre-flight on EVERY placement:** if `preferredMachine` is set (and schema-valid), verify it exists AND is online; if `requiredCapabilities` is set, verify ≥1 online machine satisfies ALL of them. Failure → the session goes to the queue (below) and a single Attention item is raised ("machine X offline" / "no machine has capability Y").
- **De-duplicated escalations:** the same invalid pin/constraint/corrupt-record does NOT re-escalate on each subsequent message for that topic (one Attention item per distinct unsatisfiable/invalid episode).
- **Test:** Tier-1 — a corrupt `TopicPlacement` record (`pinned: "yes"`, or `preferredMachine: 42`, or `requiredCapabilities: "gpu"` as a bare string, or an unknown capability token) → session marked `placement-blocked` with `escalationReason: 'topic-metadata-invalid'` + Attention item, NO inference/sanitize, NO placement on a default machine; `preferredMachine` set to a (schema-valid but) non-existent machine → escalation, no placement; `requiredCapabilities` unsatisfiable → escalation, no placement.

#### Pinned-Machine vs Failover Semantics

The "queue + escalate" rule (hard pin) and the "re-route on offline" rule (failover) only appear to conflict; they apply to DIFFERENT placement kinds:
- **Hard pin** (`pinned: true` + `preferredMachine`): the session MUST run on the named machine. If that machine is offline/dead, the session **queues + escalates** — it is NOT silently re-routed (the user explicitly demanded that machine, e.g. it has the only local model/GPU). It stays queued until the machine returns OR the queue timeout fires (below).
- **Preference** (`preferredMachine` without `pinned`, or capability-preference): the session PREFERS a machine but MAY degrade to a capable fallback. If the preferred machine is dead, it **re-routes** to the next-best capable machine (this is the failover re-route in §L5).
- **Failover of a hard-pinned session whose machine dies:** queue + escalate (NOT re-route), with `hardPinFailoverQueueTimeoutMs` (default 7200000 = 2h); on timeout, escalate again to the user asking whether to relax the pin.
- **Test:** Tier-2 — hard-pin to a machine that dies → escalation + queued (no re-route); preference-pin to a machine that dies → re-route to a capable fallback.

#### Queued Session Lifecycle (no indefinite silent block)

When a hard constraint cannot be met, the session is queued — but never silently blocked forever:
- Queued session has `status: 'queued'` + `queueReason` (e.g. "waiting for machine mini" / "no machine has capability gpu"). The queue is **persisted** to the durable registry so it survives a router restart.
- The router re-evaluates queued sessions on each heartbeat; the moment a capable machine appears, it places immediately.
- **User notification:** a CONTINUATION-style message ("holding this for <reason>; I'll pick it back up the moment <machine/capability> is available") so the user is never left wondering — responsive escalation, not silent block.
- **Timeout:** if queued longer than `queueTimeoutMs` (default 7200000 = 2h), escalate to the user ("that constraint still can't be met — want me to run it on the next available machine instead?"); if no response within the escalation window, place on the least-loaded capable available machine (degrade) and disclose the fallback. A hard pin's degrade requires the explicit user "yes" — it does not auto-degrade silently.
- **Test:** Tier-2 — queue a session needing an offline machine; bring the machine online → immediate placement; let it time out → escalation (+ disclosed fallback for preference, explicit-confirm for hard pin).

### L5 — Session Transfer / Handoff Orchestrator

**Goal:** move a running session machine→machine such that it feels like a session restart, with no drop/double.

**Reuse (exists / partial):** `SessionMigrator` (halt/account-switch/restart orchestration — adapt for machine target), `TopicResumeMap` (resume UUID), `LiveTailBuffer` + `ReplyMarkerTransport` (in-flight output continuity during handoff), `MessageProcessingLedger.applyRemoteReplyMarker()` (exactly-once across the handoff window), `ResumeValidator` (post-resume coherence).

**Build — the transfer state machine** (ordered per the §L3 "Handoff Ordering" sequence: `active(S)→transferring→active(T)→S-release` — claim-before-release, fenced by status+epoch):
1. **Quiesce** on source: stop accepting new turns (record advances to `transferring`); drain the in-flight reply (Open Decision #2 default = finish current reply, then transfer), capture resume UUID, flush live-tail. **Drain bound:** if draining exceeds `transferDrainTimeoutMs` (default 30000), the source cancels the in-flight operation and proceeds with the transfer anyway — a long-running tool call or LLM reply must NOT block a transfer (including a load-rebalance or a user pin) indefinitely. Config: `transferDrainTimeoutMs`.
   - **What "cancel" means operationally (no ambiguity):** on drain timeout the source (a) marks the in-flight reply `cancelled` in `LiveTailBuffer` and **abandons the partial output — it is NOT emitted to the channel** (the partial tokens are dropped, not sent half-finished); (b) signals any running tool call to stop via the session's cancellation token / `process.kill` on the spawned turn — best-effort, because an external side effect already issued (an email already sent, a git push already landed) cannot be un-done (this is exactly the best-effort-once boundary of Invariant #3); (c) records the cancelled turn's `messageId` + `cancelled-at-drain` in the ledger so the redelivery path knows a turn was interrupted.
   - **Honest disclosure on the target side:** the target's CONTINUATION explicitly states the interruption — *"I interrupted my previous message to move this over here; tell me if you'd like me to pick that back up."* — rather than silently dropping the partial work, so the user is never left with a half-answer and no explanation.
   - **No double-retry of the interrupted turn:** if the source's cancelled reply nonetheless completes after the cutoff and reaches the platform (a late tool callback), the `messageId` idempotency key + `ReplyMarkerTransport` dedupe suppress it (the turn's reply marker is already accounted for) — the user does not see both the interrupted tail and the target's retry.
   - **Test:** Tier-2 — inject a long-running LLM reply during a transfer, trigger the drain timeout; verify the source stops emitting AT the deadline (no channel output past `transferDrainTimeoutMs`), the partial reply is abandoned (not sent), the target's CONTINUATION discloses the interruption, and the idempotency key prevents a double-reply if the old turn later completes and reaches the platform.
2. **Sync** state: ensure files/important data synced to target (existing GitSync + the frequent sync). **Atomic sync via manifest + SHA256 verify (mandatory — no resume from corrupted/partial state).** A failover that catches the source half-written (killed mid-`git push`, killed mid-file-write) must NOT let the target resume from a torn state. Therefore:
   - The source writes a **sync manifest** alongside the synced files: `SyncManifest = { syncId, sessionKey, generatedAt, files: [{ path, sizeBytes, sha256 }], manifestSha256 }` — the SHA256 of every file the resume depends on (resume UUID map, live-tail buffer, ledger snapshot, session state files), plus a SHA256 over the manifest body itself. The manifest is the LAST artifact written and synced, so its presence means the file set it describes was fully written.
   - The target, BEFORE resuming, **verifies ALL hashes**: every listed file exists, its size + SHA256 match the manifest, and the manifest's own `manifestSha256` is intact. Verification is the gate — `ResumeValidator` is extended to run it.
   - **On ANY mismatch (missing file, wrong hash, missing/torn manifest)** the target does **NOT** resume from the corrupted state. It escalates honestly per Invariant #8: a CONTINUATION-style message to the user — *"I couldn't pick this up from <source machine> — its last sync looks incomplete (corrupted/partial). I'm not going to guess at stale state."* — and raises one deduped Attention item (`reason: sync-corrupted`). It then attempts a fresh resume strictly from channel history (the platform-retained messages), which is itself bounded + disclosed by the RPO rule below; if even that is unavailable it leaves the session queued + escalated rather than fabricating context.
   - **Ledger handoff flow (mandatory, fully specified — the redelivery race closes here).** The ledger replication is an explicit ordered sub-protocol of the transfer, not an aside. The contract:
     1. **Source flushes synchronously:** `MessageProcessingLedger.flushToGit()` writes a deterministic JSON snapshot — `LedgerSnapshot = { sessionKey, generatedAt, entries: [{ messageId, status: 'reply_committed'|'cursor_advanced'|'in_flight', replyMarker?, updatedAt }], snapshotSha256 }` — to a manifest-covered file at the registry's per-session ledger path. The flush is synchronous (the source blocks on it) and the snapshot file is one of the files listed in the §L5 `SyncManifest` (so its SHA256 is covered by the atomic-sync verify).
     2. **Source sends `transfer` MeshRpc to the target** (§L0 signed) carrying `ledgerSnapshotRef` (the git ref/path of the flushed snapshot) alongside `syncManifestRef`.
     3. **Target pulls + verifies:** the target pulls the ledger snapshot from git, verifies its SHA256 against the `SyncManifest` (reusing the atomic-sync verify of §L5), AND verifies **every entry is in a terminal state** (`reply_committed` or `cursor_advanced`) — **nothing `in_flight`**. An `in_flight` entry means a turn was still being processed at flush time: the target either waits for the source to flush a terminal snapshot (planned transfer, source alive) or, on failover with the source gone, treats that turn as the interrupted-drain case (disclosed in the CONTINUATION, deduped on redelivery).
     4. **Target ACKs `ledger-verified`** to the source (a `transferAck = { sessionKey, ledgerVerified: true, manifestVerified: true }`) — and ONLY then does the source proceed past `transferring` and the target proceed to step 3's claim CAS.
     5. **Ordering relative to the claim CAS:** the claim CAS to `active(owner=T, epoch=e+2)` is performed **AFTER** the `ledger-verified` ACK — never before. So the moment the target is `active`, it provably holds the full deduped ledger; any inbound message it then receives is checked against a complete ledger.
   - **This closes the redelivery race precisely:** if a message arrives at the target before ledger replication completes, the target has NOT yet CAS'd to `active` (it cannot dedupe-check against an absent ledger), so it does NOT process the message — it holds the inbound in a receive buffer (or rejects with `stale-ownership`, prompting router re-resolution) until the `ledger-verified` ACK has been sent and the claim has landed. A message is never processed against an incomplete ledger.
   - **`failover` branch:** the target pulls the latest replicated manifest+ledger as-of-last-sync before resuming — same verify-before-resume guarantee, bounded by RPO below; a corrupted as-of-last-sync manifest triggers the same honest escalation rather than a stale-state resume.
   - **Test (ledger-wiring):** Tier-2 — inject a redelivered message that is NOT yet in the replicated ledger (the message arrives during the target's pull, before the `ledger-verified` ACK); verify the target does NOT re-process it (held in the receive buffer / rejected `stale-ownership` until the claim lands), and once the ledger is replicated + claim CAS'd, the message is recognized as a duplicate and dropped — processed exactly once across the handoff.
3. **Claim** on target: CAS ownership to target at epoch+1 → `active(owner=T, epoch=e+2)`; target spawns `--resume UUID` (planned transfer, state current) or spawn-resume-from-channel-history (failover, source gone).
4. **Cutover**: target emits CONTINUATION; source releases ownership (the LAST step — cleanup, not a precondition for T's claim) + tears down its session. Ingress for `K` now resolves to target.
5. **Exactly-once**: the (now-replicated) message ledger + reply markers ensure any redelivery during the window is recognized and dropped; the user gets exactly one continuation.

**Test:** Tier-2 — (drain) simulate a long-running reply, trigger transfer, verify the drain timeout fires and the handoff still completes within bound; (ledger) send a message just before transfer, inject a git-sync delay, verify the target does NOT re-process even though the message arrives before ledger replication completes (cutover waited for ledger ACK); **(atomic sync) kill the source mid-sync (truncate a manifest-listed file / drop the manifest), then trigger failover; verify the target detects the SHA256 / missing-manifest mismatch, REFUSES to resume from the corrupted state, posts the honest "last sync corrupted" escalation + Attention item, and falls back to channel-history resume (or queued-escalated) rather than asserting torn state.**

**Triggers:** load rebalance (L2 pressure), hardware/model need (topic metadata), explicit user request (pin), failover (source offline → step 3 failover branch directly).

**Failover branch:** when the source is gone, there is nothing to quiesce; the router re-places and the target resumes from channel history (as-of-last-sync). If context is partial, the agent discloses "picking this back up from the other machine" rather than pretending nothing changed (inherited CROSS-MACHINE-SEAMLESSNESS honesty rule).

**Failover resume context bounds (RPO + recency disclosure).** "As-of-last-sync" must be bounded and disclosed, or a large gap causes silent context loss:
- **RPO target:** active-session state syncs at least every `failoverRpoTargetMs` (default 300000 = 5 min) while the session is active. (This is the existing frequent-sync cadence, made explicit as the failover RPO.)
- **Recency disclosure on resume:** the target reads `LastSyncTime` from the source's synced state files. If `now − LastSyncTime` exceeds the RPO plus drift tolerance, the CONTINUATION explicitly states the recency ("my memory of this is as of <timestamp>, about <gap> ago — I may have missed your last message or two") rather than silently asserting stale state.
- **RPO-violation escalation:** if `now − LastSyncTime` exceeds `failoverContextMaxStalenessMs` (default 900000 = 15 min), raise an Attention item (the sync cadence was violated — an operability signal) in addition to disclosing in-chat.
- **Auto-resume vs wait:** the target auto-resumes the conversation (it does NOT wait for a user action) so failover is silent-fast in the common case; the disclosure only appears when the gap is real. Config: `failoverRpoTargetMs`, `failoverContextMaxStalenessMs`.
- **Test:** Tier-2 — source goes offline, target resumes; verify CONTINUATION includes the as-of timestamp when the gap is non-trivial; verify the Attention item fires when staleness exceeds the max.

### L6 — Multi-Agent-Per-Machine

**Goal:** multiple agents installed on one machine share its resources without interference.

**Reuse (exists):** per-agent home (`~/.instar/agents/<name>/`), per-agent port, per-agent identity + state dirs, per-agent `QuotaTracker`.

**Build / verify:**
- The machine's `MachineCapacity` (L2) accounts for ALL resident agents' sessions when reporting `activeSessionCount` / load, so each agent's router sees the true machine load (not just its own).
- A machine-level resource signal (shared load view) so one agent's router won't pile sessions onto a machine another agent is already saturating. (A light machine-local capacity broker; agents read it, no cross-agent trust required beyond same-operator.)
- Isolation invariant: agents never read/write each other's state dirs; ports + identities are distinct; this is mostly already true — the work is the shared load accounting + a regression test proving isolation.

- **Independent load verification (agents cannot lie about load).** The shared load view says "no cross-agent trust required" — that only holds if no agent can falsely report zero load while running 100 sessions and starving the others. The broker therefore does NOT trust agent self-reports for the authoritative number:
  - **The machine** (the machine-local capacity broker, not any agent) independently reads OS metrics — `os.loadavg()`, total process count, per-process RSS — via system calls. This is the ground truth.
  - **Agents report only their own** session count + claimed resource footprint; they cannot write the machine-level total.
  - The broker's `MachineCapacity` record is the OS-measured truth **merged with** agent self-reports, and it **cross-checks**: if an agent's self-reported session/footprint diverges from its actual process footprint by more than `loadReportDivergenceTolerance` (default 0.20 = 20%), the broker marks that agent `suspect-overloaded`, reduces its placement weight, and escalates an operator alert. A lying agent thus cannot make itself look idle — the machine's own OS read overrides it.
  - **Test:** Tier-2 — an agent falsely reports zero load while actually running many sessions; the broker detects the divergence against OS metrics, marks the agent `suspect-overloaded`, and the other agent's router does NOT pile onto that machine.

---

## Invariants & Safety

Each invariant states HONESTLY what the substrate guarantees — no overstatement. Where git's CAS is only linearizable-when-reachable, the invariant names the partition window and the fence that covers it (§L−1), rather than claiming a stronger guarantee than git+fencing provides.

1. **Exactly-one-router (scoped honestly).** The router role is held by exactly one machine via the fenced lease. The CAS authority is `GitLeaseStore`'s single-ref fast-forward push: **when the remote is reachable, the remote ref-update is the linearization point** — a non-fast-forward push is rejected, so two contenders cannot both win; exactly one advances the epoch. **The only non-linearizable window is a partition** (a holder cut off from the remote holds a stale view); it is fenced, not ignored — the partitioned holder **self-fences on its monotonic-local TTL** (stops ingress before TTL elapses on its own clock) and its stale-epoch write is rejected non-fast-forward on rejoin. A lower epoch self-suspends ingress on read. (v0.1 is a single router shard — RouterShardKey always 0; see §L1 Pool-size scope.)
2. **Exactly-one-owner per session.** Per-session CAS at `ownershipEpoch+1` via the same single-ref fast-forward push (one ref file per session — §"Write Amplification"); the remote ref-update decides the winner, never `machineId`. A worker runs a session only while it observes itself as the `active` owner at the current epoch. Handoff is **claim-before-release** gated by the `active(S)→transferring→active(T)→S-release` state machine (§L3 "Handoff Ordering"), NOT release-before-claim: the status+epoch fence (not the physical release) guarantees no double-run and no no-owner gap. (The earlier "release before the new owner's claim" wording is withdrawn — see §L3.) Partition fence is identical to #1 (TTL self-fence + non-fast-forward rejection on rejoin).
3. **Exactly-once is scoped to CHANNEL messages + replies — NOT to external tool side effects (honest scoping).** No channel message is lost or double-processed and no reply is doubled across placement, transfer, or failover: this is enforced by `MessageProcessingLedger` (inbound dedupe keyed on platform event id) + `ReplyMarkerTransport` (reply-marker dedupe), with the transfer **mutual-exclusion-on-output** rule of §L3 (source stops channel emits within `transferOutputCutoffMs`; target emits only after CAS to `active(epoch+2)`). **External tool invocations and side effects are best-effort-once, NOT transactional.** If a transfer/failover happens while a tool call (an email send, a git push, an HTTP POST to a third party) is in flight, instar does NOT provide a transactional guarantee across that call — the tool may run zero times (cancelled mid-drain) or, on a redelivery, twice. Tools that must not duplicate effects MUST carry their own **idempotency key** (the message/turn id is available for this); instar exposes the turn id but cannot make a non-idempotent external API exactly-once. This is stated plainly so no caller assumes a guarantee that does not exist.
4. **Durable router lease.** Renewal lands a confirmed fast-forward push to the git lease ref (synchronous, ref-authoritative — §L1); MeshRpc/tunnel broadcast is a latency optimization on top, never the correctness backstop. Verify-on-read (epoch floor + monotonic-local self-expiry + signature) on every router-lease read (folds in LEASE-SUBSTRATE-ROBUSTNESS). No external coordination store (CLAUDE.md "no database dependency").
5. **No silent mis-placement** — an unmet hard constraint (pin/capability) with no capable online machine queues + escalates; never silently runs elsewhere. Invalid topic-placement metadata is schema-validated on read → block + escalate (Attention item), never inferred or sanitized (§L4 "Topic Placement Validation").
6. **Backward compatibility** — 1-machine agent behaves identically to today; feature dark until >1 machine paired.
7. **Security** — all m2m commands Ed25519-signed by a registered peer, recipient-bound; per-command RBAC gate (§L0); secrets X25519-encrypted end-to-end; nonce+epoch+timestamp replay protection.
8. **Honesty on partial context** — a failover resume from as-of-last-sync state discloses the catch-up rather than asserting stale state; an **atomic-sync checksum mismatch does NOT resume from corrupted state — it escalates honestly** ("unable to resume from <machine>; last sync corrupted") (§L5 atomic-sync manifest).
9. **Single-writer steady state** — only the router writes ownership in steady state; transfer-time CAS is the sole concurrent-write path and is fenced.

---

## What Exists vs What We Build

**Reuse (built):** FencedLease/LeaseCoordinator/GitLeaseStore/HttpLeaseTransport, MultiMachineCoordinator, MachineIdentity + machineAuth, SessionManager + TopicResumeMap + ResumeValidator, SessionMigrator, LiveTailBuffer + ReplyMarkerTransport, MessageProcessingLedger, CanonicalState (topic↔project), HeartbeatManager, InitiativeTracker/ProjectRoundRunner (project tracking), NonceStore, SecurityLog, GitSync.

**Build (new):** MeshRpc (L0, incl. the `deliverMessage` owner-forward command — §L4 "Message Routing to Owner"), MachineCapacity registry (L2, incl. the `clockSkewStatus` quarantine state machine — §L2), SessionOwnership + Distributed Session Registry (L3, per-session ref CAS + per-session-scoped NonceStore), Session Router + `PlacementExecutor` (`src/core/PlacementExecutor.ts`, data-driven canonical placement — §L4) + TopicPlacement metadata (L4), Transfer/Handoff orchestrator state machine + ledger-handoff sub-protocol (L5), shared machine-level load accounting (L6), the message-router change to consult placement instead of always spawning locally, and the rollout-gate components `StageAdvancer` (`src/core/StageAdvancer.ts`, sole stage-config writer) + `SessionPoolE2EResultStore` (`src/core/SessionPoolE2EResultStore.ts`, signed append-only E2E results) — §Rollout.

**Adapt:** SessionMigrator (machine target, not just account); LiveTailBuffer/ReplyMarkerTransport (proven for handoff under the new triggers).

---

## Rollout (Graduated)

Per `GRADUATED-FEATURE-ROLLOUT-SPEC`:
- **Stage 0 (dark):** all code ships; placement runs in **dryRun** (logs the decision it WOULD make; always places locally). Single-machine = no-op.
- **Stage 1 (shadow):** router makes real placement decisions, ownership records written, but transfer disabled — proves routing + ownership without moving live sessions.
- **Stage 2 (live transfer):** failover + explicit-pin transfers enabled.
- **Stage 3 (rebalance):** load-driven proactive transfers enabled.
- **E2E is a HARD per-stage gate enforced by TWO NAMED CODE COMPONENTS, not by willpower (Structure > Willpower).** A stage does NOT activate until the **Tier-3 E2E test for that stage** (real two-machine pool; the test-as-self real-Telegram exactly-once check below) completes GREEN — and that gate is mechanical, grounded in two implemented components:

  - **`src/core/SessionPoolE2EResultStore.ts` (the durable E2E-result record — store + writer + read API).**
    - **Schema:** `StageE2EResult = { stage: number, result: 'green'|'red', commitSha: string, ranAt: string, evidenceRef: string, signature: string }`.
    - **Storage:** persisted to `state/session-pool-e2e-results.json` as an **append-only, signed** log — it **reuses the `AuditTrail` signing pattern** (the same Ed25519/HMAC scheme other instar audit records use), so a result is tamper-evident. **A reversion or a new run APPENDS a row; it NEVER overwrites a prior row** (the history of green/red per commit is preserved).
    - **Writer (the ONLY writer):** `recordResult(stage, result, commitSha, evidenceRef)` is called by the **Tier-3 E2E harness in `tests/e2e/`**, never by hand — the harness records the outcome of its own run. The method signs the row and appends it.
    - **Read API:** `getLatestForStage(stage): StageE2EResult | null` returns the MOST RECENT row for that stage (so a later `red` supersedes an earlier `green` for gate purposes); `verify(row)` checks the signature. Exposed read-only over HTTP at **`GET /session-pool/e2e-results`** (Bearer auth, like all instar routes) so the gate state is observable.
    - **Test:** Tier-1 — `recordResult(1,'green',sha)` → `getLatestForStage(1)` returns it and `verify()` passes; a later `recordResult(2,'red',sha)` APPENDS (the file still contains the stage-1 green) and `getLatestForStage(2)` returns the `red`; a tampered row fails `verify()`.

  - **`src/core/StageAdvancer.ts` (the sole writer of the stage config — the structural gate).**
    - **Sole-writer guard:** `multiMachine.sessionPool.stage` is mutated ONLY through `StageAdvancer._writeStageConfig()` (its internal, private write method). A **config-read-through guard in `Config.ts`** (the same pattern as other instar single-writer config mutations) **rejects any direct write to `multiMachine.sessionPool.stage` originating outside `StageAdvancer`** — a direct config write is refused with `stage-write-not-permitted`. Structure, not prose: no other code path can flip the stage.
    - **`advanceTo(targetStage)`:** queries `SessionPoolE2EResultStore.getLatestForStage(targetStage − 1)` and **REFUSES (`e2e-gate-not-passed`, audited) unless that prior-stage result is `green` for the CURRENT `commitSha`.** A missing record, a `red` record, or a record for a stale commit → rejected; the stage stays where it was. Only a matching `green` lets `advanceTo` call `_writeStageConfig(targetStage)`.
    - **Mechanical reversion:** `StageAdvancer` evaluates the latest result on each cycle; if a stage's E2E later records `red`, it calls `_writeStageConfig()` to revert to the prior (shadow/dark) stage until a fresh `green` is recorded.
    - Generalized: **Stage N does not advance until Stage N−1's durable, signed E2E result is `green` for the live commit.** No stage ships on unit/integration tiers alone, and no human can hand-edit the stage past the gate (the `Config.ts` guard blocks it).
    - **Test:** Tier-1 — `StageAdvancer.advanceTo(2)` is REJECTED (`e2e-gate-not-passed`) when no `green` Stage-1 `StageE2EResult` exists for the current commit, and ACCEPTED (calls `_writeStageConfig`) once a matching `green` record is written; an attempted DIRECT config write to `multiMachine.sessionPool.stage` (bypassing `StageAdvancer`) is rejected by the `Config.ts` guard (`stage-write-not-permitted`).

  - **CI belt-and-suspenders:** a pre-release CI check also asserts that any committed bump of `multiMachine.sessionPool.stage` defaults is accompanied by a matching `green` `StageE2EResult` — so the gate holds at the release boundary too, not just at runtime.
- Each stage gated on the prior stage's proof. Config: `multiMachine.sessionPool.{enabled, stage, dryRun}` (where `stage` is `StageAdvancer`-write-only, enforced by the `Config.ts` guard above).

---

## Testing Strategy

Per the Testing Integrity Standard — all three tiers + wiring-integrity + restart-survival.

- **Tier 1 (unit):** placement policy (both sides of each boundary: capable/incapable, pinned/unpinned, loaded/free, constraint-unmet→escalate), TopicPlacement schema-validate-on-read (corrupt record → `placement-blocked`, never sanitized), ownership CAS (concurrent claim → exactly one wins **by ref-update, not machineId**), transfer state machine (each transition + failover branch), router election + failover idempotency, capacity/liveness staleness, monotonic-local lease self-expiry + partition self-fence, `assertClockSyncHealthy()` (bad clock + sub-drift tolerance both rejected), `StageAdvancer` E2E-gate refusal + config-write guard, multi-agent load accounting + isolation.
- **Tier 2 (integration):** HTTP/MeshRpc routes — placement decision endpoint, ownership registry read/write, transfer command, capacity report.
  - **Exactly-once, asserted as TWO SEPARATE properties (honest scoping per Invariant #3):** (a) **channel-message + reply dedup** — across a simulated router handoff, a redelivered inbound message is dropped by `MessageProcessingLedger` and the user sees exactly one reply (reply-marker dedup); (b) **tool idempotency is the TOOL's job, not instar's** — a test that fires a non-idempotent tool call during a transfer asserts instar does NOT magically prevent a double-effect (it may run twice on redelivery) and that the documented remedy (a tool-supplied idempotency key keyed on the turn id) DOES suppress the duplicate. The two are tested independently so the spec's scoped guarantee is verified, not overstated.
  - **Clock-skew quarantine (issue-10):** inject a 10-minute clock jump on a pool machine; verify divergence is detected on 2 consecutive heartbeats, the machine is marked `suspect-clock` and removed from placement (not silently degraded), an Attention item fires, and it is re-admitted only after 2 in-tolerance heartbeats; assert `clockSkewToleranceMs ≥ maxExpectedNtpDriftMs * 2` is enforced at startup.
  - **Atomic-sync corruption (issue-7):** kill the source mid-sync; verify the target detects the manifest/SHA256 mismatch and refuses the corrupted resume (escalates honestly).
  - **Placement-memo staleness (issue-9):** memo fresh+live → reused; memo stale → re-evaluated; memo target dead → re-placed live.
- **Tier 3 (e2e + real hardware):** two machines (laptop + mini, production agents untouched): (a) multiple concurrent sessions placed across both, (b) router places a new session on the correct machine per metadata, (c) a live session transfers mid-conversation cleanly (planned), (d) router-leader failover when the stick-holder drops, (e) a machine going offline re-routes its sessions (failover resume-from-history), (f) exactly-once verified end-to-end, (g) the Machines dashboard tab shows both machines with correct hardware + auto-assigned nicknames, a nickname edit persists + syncs, and a `move this to <nickname>` command transfers the live session to the named machine.
- **The gate (test-as-self) — the HEADLINE proof:** drive Justin's real Telegram via the dedicated Playwright profile, as Justin, against the live two-machine pool. The primary scenario is the **nickname-driven mid-conversation swap**: hold a real conversation on machine A, send `move this to <nickname-of-B>` mid-thread, and verify the conversation continues COHERENTLY on machine B (same context, no dropped/doubled message, the agent picks up where it left off) — exactly as Justin specified. Then also force a load/failover transfer + a machine-death mid-conversation; confirm no drop / no double each time; resolve every UX issue. The nickname the user types is the one shown in the Machines tab.

---

## Migration Parity & Agent Awareness

- **Config:** `multiMachine.sessionPool` block → `ConfigDefaults` + `migrateConfig()` (existence-checked, default dark). All the tunables introduced above (mesh/clock tolerances, ownership CAS retry/backoff, registry budget, placement hysteresis/cooldown, rebalance thresholds, drain/RPO/queue timeouts, `deliverMessage*` timeouts/retries, throughput caps) live under this block with the documented safe defaults.
  - **Explicit migration code (Migration Parity Standard — existing agents MUST receive defaults on update, not just new agents).** Add `migrateSessionPoolConfig()` to `src/core/PostUpdateMigrator.migrateConfig()`:
    1. **Existence-checked, idempotent:** if `config.multiMachine.sessionPool` is absent, add the full block with safe defaults — `{ enabled: false, stage: 'dark', dryRun: true, routerPoolMaxMachines: 10, routerMaxThroughputMsgPerSec: 500, routerQueueDepthAlertThreshold: 200, clockSkewToleranceMs: 300000, maxExpectedNtpDriftMs: 250, maxAllowedClockErrorMs: 5000, meshRpcClockToleranceMs: 30000, ownershipCasClockToleranceMs: 30000, ownershipCasMaxRetries: 5, sessionOwnershipBatchWindowMs: 100, maxOwnershipRegistryBytes: 104857600, placementHysteresisDelta: 0.15, placementCooldownMs: 300000, rebalanceIntervalMs: 30000, rebalanceThresholdPercent: 0.85, transferDrainTimeoutMs: 30000, transferOutputCutoffMs: 1000, deliverMessageTimeoutMs: 5000, deliverMessageMaxRetries: 3, failoverRpoTargetMs: 300000, failoverContextMaxStalenessMs: 900000, queueTimeoutMs: 7200000, … }`. Only MISSING fields are added (per-field existence check), so a re-run never clobbers an operator's tuned value, and a re-run on an already-migrated config is a no-op.
    2. **Cross-knob invariant validation:** after merging defaults, assert the cross-knob invariants from §L−1 — `clockSkewToleranceMs ≥ maxExpectedNtpDriftMs * 2` AND `clockSkewToleranceMs ≥ maxAllowedClockErrorMs` (and the analogous mesh-tolerance relations). A violation (e.g. an operator hand-edited a tolerance into an unsafe combination) raises one deduped Attention item naming the offending knobs — it does NOT silently degrade or silently "fix" the value.
    - **Test:** Tier-1 — an existing agent config WITHOUT a `sessionPool` block runs `migrateConfig()` → the block is added with all safe defaults; a re-run is idempotent (no duplication, no overwrite of a tuned field); a config with `clockSkewToleranceMs` set below `maxExpectedNtpDriftMs * 2` raises an Attention item rather than passing silently.
- **CLAUDE.md template — Tier-0 concise only (anti-bloat).** Per the L1 context-bloat lesson (cramming mechanics into the always-loaded identity file degrades the agent), CLAUDE.md gets only a SHORT Tier-0 blurb: *"Multi-Machine: I can spread conversations across machines; say 'run this on the mini' to pin one; ask 'where is this running?' to see placement."* It does NOT carry placement-policy internals, the transfer protocol, or the route catalog.
  - **Deep mechanics live on-demand, and the trigger is CODE-ENFORCED — not a prose hope (Structure > Willpower).** The deep Playbook entry (`multiMachine-placement-deep`) is not "available if the agent remembers to look"; it is bound to the message-context injector structurally:
    1. **Registered trigger at server startup.** A Playbook context item `multiMachine-placement-deep` is seeded with an explicit **trigger regex** in its manifest metadata — `where.*running|placement.*status|move.*to.*machine|which.*machine|run.*this.*on|I need more (cpu|ram|memory)|why.*(did|move)`. The Playbook's existing trigger-assembly path (`instar playbook assemble --triggers …`, the same mechanism that selects items for `session-start`) matches inbound message text against this regex and **injects the entry into context** when it fires — exactly like the existing session-start trigger binding, no new mechanism invented.
    2. **SelfKnowledgeTree probe.** A probe registered at startup answers the session-location question structurally: *"when the user asks where a session is running / asks to move it → surface the `GET /pool` route + the `run this on <machine>` command + the deep Playbook entry."* The `/pool` route and the "run this on X" command are registered as SelfKnowledgeTree capability nodes so the agent discovers them conversationally (not from always-loaded context).
    - **Test:** Tier-1 — instantiate the Playbook with the seeded `multiMachine-placement-deep` entry; feed the message "where is this running?" through the trigger-assembly path and assert (via a mock context interceptor) that the deep entry IS injected into the assembled context; feed an unrelated message and assert it is NOT injected (the trigger is specific, not always-on). Assert the SelfKnowledgeTree probe surfaces `/pool` for the session-location query.
  - → `generateClaudeMd()` + `migrateClaudeMd()` content-sniff for the Tier-0 blurb; a `PostUpdateMigrator` Playbook-seed migration installs the `multiMachine-placement-deep` entry (with its trigger regex) into existing agents' manifests idempotently (existing agents get the deep entry on update, per Migration Parity), and registers the SelfKnowledgeTree probe.
- **Registry-first:** pool status answerable via a route (`GET /pool` → router holder, machine capacities, session→machine map, `router.queueDepth`/`router.msgPerSec`, `registry.bytes`/`registry.sessionCount`/`registry.memoryPressure`, `ownership.casConflicts`) for the "where is session X running?" question.
- **Hooks/skills:** no new gate hooks; the router is a server component. A **"Machines" dashboard tab** (§L2 "Machines Dashboard Tab", per THE Dashboard Standard) shows every machine the agent is installed on with its editable nickname, hardware properties, online status, load, and current session count — backed by `GET /pool` (extended with `nickname` + `hardware`) and `PATCH /pool/machines/{machineId}` for rename. It is the discovery surface for the nicknames used in `move this to <nickname>`.

### External Surfaces & Authorization Boundaries

Per the L6 side-effects review (dimension 5: external surfaces), every new surface documents auth + rate-limit + authorization, so an untrusted agent cannot force a transfer:
- **`GET /pool`** (status) — read-only; same Bearer-token auth as all instar HTTP routes (CLAUDE.md API Authentication); no machine-RBAC needed (observe class); rate-limited under the standard server middleware.
- **`POST /transfer/{sessionKey}`** (operator/agent-initiated transfer) — Bearer-auth; authorized ONLY when the caller is the current `ownerMachineId` for that session OR the router holder; subject to the `topicPlacementUpdateMinIntervalMs` rate limit; audited.
- **`PATCH` TopicPlacement** (the "run this on X" / `/pin` update) — Bearer-auth + the whitelisted-command + validation + confirmation + rate-limit + audit rules in §L4 "Topic Placement Updates".
- **MeshRpc `place`/`claim`/`release`/`transfer`** — NOT HTTP-public; carried over the machineAuth-signed mesh channel, Ed25519 recipient-bound signature (§L0), per-command RBAC (§L0), nonce+timestamp replay protection. An untrusted (non-peer) machine cannot even reach these; a registered-but-unauthorized peer is refused by the per-command role check.
- Cross-references: §L0 (signature + RBAC), §L1 (router-lease verify-on-read), §L4 (placement-update validation/rate-limit).

---

## Open Design Decisions (for Justin)

Recommended defaults are baked into the spec above; these are the points where his call could change the design. None block drafting/convergence — they resolve at approval.

1. **Ingress ownership.** Recommended: the **router holder owns all channel ingress** and dispatches to session owners. (Simplest; makes exactly-once trivially single-owner; matches today's model.) Alternative: every machine polls and the router only arbitrates ownership (more parallel, more complex dedup). → *Recommend router-owns-ingress.*
2. **Transfer during an active reply.** Recommended: **drain the current reply on the source, then transfer.** (Cleaner UX; no interrupted message.) Failover is the exception (source gone → resume from history). → *Recommend drain-then-transfer.*
3. **Placement aggressiveness.** Recommended: **sticky-by-default** — only move a running session on real pressure / hard constraint / explicit request; place NEW sessions by least-loaded. (Minimizes churn.) Alternative: proactive rebalancing. → *Recommend sticky; rebalance is Stage 3, off by default.*
4. **Session unit.** Recommended: **per-topic** (a topic/conversation = a session = the ownership unit), matching today's TopicResumeMap. → *Recommend per-topic.*
5. **Router horizontal-scaling scope (the ONE scope decision — needs explicit confirmation).** v0.1 ships a **single fenced router** (RouterShardKey indirection always maps to shard 0; §L1 "Pool-size scope"). Supported envelope: **≤ `routerPoolMaxMachines` (default 10) same-operator machines** and **≤ `routerMaxThroughputMsgPerSec` (default 500) sustained** — which covers the real near-term target (one user's laptop + mini + phone). Multi-shard horizontal scaling (per-shard fenced lease + per-shard ledger, keyed by `hash(sessionKey) mod shardCount`) is **out of v0.1 scope** because it changes Invariants #1/#3 (per-shard exactly-once + cross-shard ordering is a distinct correctness model needing its own proof). This is **NOT a hand-wavy "Phase 2"**: the sharding design is **pre-specified** in §L1 and built behind the `RouterShardKey` indirection from day one, so it is not retrofit-blocking debt — a future sharded spec raises the modulus with no caller change. → *Recommend single-shard v0.1, envelope-bounded, sharding pre-specified.* **This scope decision is recorded in the `deferral-approvals` frontmatter <!-- tracked: router-single-shard-v0.1-scope --> (`router-single-shard-v0.1-scope`) and requires Justin's explicit confirmation at approval — it is surfaced here so it is never silently decided.** (Confirm: is the ≤10-machine / 500-msg-sec single-router envelope acceptable for v0.1, with multi-shard as a separate future spec built on the pre-specified `RouterShardKey` seam?)

---

## Build Plan (Project Tracks)

Tracked as an InitiativeTracker project (one track ≈ one round). Build order respects dependencies (each track lands behind the Graduated Rollout flag, dark):

- **Track A — Router-Leader Lease + durable renewal.** Fold in LEASE-SUBSTRATE-ROBUSTNESS; reinterpret the leader lease as the router lease; durable renewal + verify-on-read. *(Foundation — everything sits on it.)*
- **Track B — Machine-Pool Registry (L2) + Machines dashboard tab.** MachineCapacity heartbeats + read API; **hardware-property capture** (CPU/RAM/platform via `os`); **machine nicknames** (auto-assign via `NicknameAssigner` + user-editable via `PATCH /pool/machines/{id}`); clock-skew quarantine FSM; the **Machines dashboard tab** (per THE Dashboard Standard) + `GET /pool` extension. Nickname→machineId resolution helper (consumed by L4).
- **Track C — MeshRpc + secure backbone hardening (L0).** Signed command layer + secret-share.
- **Track D — Per-Session Ownership + Distributed Session Registry (L3).** CAS ownership, exactly-one-owner enforcement.
- **Track E — Session Router / Placement Engine + TopicPlacement metadata (L4).** The core. Message-router change to consult placement. The whitelisted command recognizer (`run this on <nickname>`, `move this to <nickname>`, `/pin`, `/unpin`) with nickname→machineId resolution (from Track B). Stages 0→1.
- **Track F — Transfer / Handoff Orchestrator (L5).** Transfer state machine; adapt SessionMigrator + LiveTail; the `move this to <nickname>` user-driven transfer path. Stage 2.
- **Track G — Multi-Agent-Per-Machine load accounting (L6).** Shared machine capacity broker + isolation regression.
- **Track H — Load-driven rebalance (Stage 3) + the real-hardware + test-as-self proof.** Headline proof = the **nickname-driven mid-conversation swap** over Justin's real Telegram (move a live conversation A→B by nickname, continue coherently), plus load/failover transfer + machine-death, exactly-once verified.

Each track: all three test tiers, migration parity, agent awareness, instar-dev artifact/trace/NEXT.md, PR to JKHeadley/main, ships dark.
