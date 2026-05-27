# Cross-Machine Seamlessness Specification

> Close the gap between "a backup machine can take over" and "the same agent follows you across machines with no amnesia." Grounded in real-hardware Phase 0 verification.

**Status**: Draft v0 (grounded in real-hardware verification 2026-05-26)
**Author**: Echo (with Justin's direction)
**Builds on**: [`MULTI-MACHINE-SPEC.md`](./MULTI-MACHINE-SPEC.md) (v3, converged) — this spec does NOT replace it; it closes the seamlessness gap that v3 explicitly deferred.
**Companion (read first)**: [`CROSS-MACHINE-SEAMLESSNESS-SPEC.eli16.md`](./CROSS-MACHINE-SEAMLESSNESS-SPEC.eli16.md)
**Motivating initiative**: Instar × EXO 3.0 — cross-machine single-agent ("one Luna across machines"), Pillar 2.

---

## Table of Contents

1. [Overview](#overview)
2. [Phase 0 Findings (Empirical Grounding)](#phase-0-findings-empirical-grounding)
3. [Design Principles](#design-principles)
4. [The Seamlessness Gap — Precise Definition](#the-seamlessness-gap--precise-definition)
5. [Proposed Design](#proposed-design)
6. [Tunability](#tunability)
7. [Testing Strategy](#testing-strategy)
8. [Migration Parity](#migration-parity)
9. [Related Work & Open Questions](#related-work--open-questions)

---

## Overview

The converged multi-machine spec (v3) delivered machine identity, secure pairing, git-based state sync, primary/standby coordination, heartbeat/failover, and graceful handoff *machinery*. What it explicitly deferred — and what the EXO 3.0 "cross-machine single agent" vision needs most — is **seamlessness**: the experience that an agent is one logical identity that follows the user across machines with no loss of in-flight context.

Concretely, the vision (per Justin): *Adriana switches laptops mid-conversation, and "Luna" keeps talking with no amnesia.* Today, even when failover works, the machine that takes over arrives without the live conversation and in-flight work state.

This spec defines the narrow, high-leverage work to close that gap. It is deliberately scoped to the **runtime** seamlessness problem. The **onboarding** problem (how an agent installs itself onto a new machine) is captured as related work for a companion spec (see §9).

---

## Phase 0 Findings (Empirical Grounding)

This spec is not theoretical. On 2026-05-26 the multi-machine system was run on two real machines for the first time (a laptop + a Mac mini, a dedicated throwaway test agent), validating the v3 foundation and surfacing the precise gaps. Prior to this, the 60-item `MULTI_MACHINE_VERIFICATION.md` checklist was entirely unchecked.

**What works on real hardware:**

- **✅ Pairing (Checklist §1).** `instar pair` → `instar join <repo-url> --code` paired two real machines into one mesh. The pairing handshake completes **via the git repository** — no live server-to-server connection was required.
- **✅ Self-election.** A standby machine whose server starts while no other machine is posting a fresh heartbeat correctly claims the `awake` role on its own.

**What does NOT work yet (this spec's targets):**

- **❌ G1 — Split-brain resolution.** After self-election, the mesh registry recorded **both** machines as `role: awake` simultaneously. The newly-awake machine never demoted the silent peer, even though the differentiator was present (the silent machine's `lastSeen` was ~54 minutes stale, far past the 15-minute failover threshold).
- **❌ G2 — Automated state sync.** A running server modified its local registry (role change) and other state, but did **not** auto-commit/push those changes to git. Cross-machine state propagated only when pushed/pulled by hand. (The converged spec assumed `SyncOrchestrator` handles this; on real hardware it did not fire for registry/role state.)
- **❌ G3 — Live state sync + graceful handoff (untested, by design).** The test exercised startup-election against a dead peer, not a clean baton-pass between two live machines, because the seamless live-state path does not yet exist.

**Onboarding findings (→ companion spec, §9):** granting an agent access to a new machine is **two** bootstraps (SSH onto the host, *and* git credential to fetch the agent's repo); `join` does not create a runnable `config.json`, so a freshly-joined server defaults to port 4040 and can **collide with an existing agent** on that machine; the configured port does not propagate (it lives in gitignored `config.json`).

---

## Design Principles

- **Structure > Willpower.** Split-brain resolution and state sync must be code that runs deterministically — never an agent "remembering" to reconcile. (The Phase 0 split-brain persisted precisely because nothing *enforced* demotion.)
- **Signal vs. Authority.** Detectors (e.g. "I see two awake machines") emit *signals*; only the coordinator, with full context, has authority to demote a peer or trigger a handoff. No brittle filter unilaterally changes mesh roles.
- **Near-silent.** Sync and reconciliation are housekeeping. They write to logs/audit trails, not to the user's chat. The user hears about cross-machine activity only when it is actionable (e.g. an unresolvable split-brain requiring a decision).
- **Tunable latency vs. efficiency** (explicit Justin requirement). Seamlessness has a cost (network, compute, git churn). Every cadence/aggressiveness knob is configurable with sane defaults; "more machines = more reliable" must not mean "more machines = constant chatter."
- **Git as durable substrate, tunnel as low-latency channel.** Reuse the proven git sync for durable state; add a direct tunnel channel only where latency demands it (the live conversation tail).

---

## The Seamlessness Gap — Precise Definition

The gap decomposes into three sub-problems, in dependency order:

| ID | Gap | Why it matters | Phase 0 evidence |
|----|-----|----------------|------------------|
| **G1** | Split-brain resolution | Two "awake" machines = duplicated work, conflicting writes, user confusion | Registry showed both `awake` |
| **G2** | Automated state sync | Without it, no machine has a current view of the mesh; failover/handoff act on stale data | Role change never pushed to git |
| **G3** | Live conversation/work-state sync + near-instant graceful handoff | The actual "no amnesia" experience | Not yet built |

G2 is a prerequisite for trustworthy G1 and G3 (you cannot resolve or hand off on stale state).

---

## Proposed Design

### G1 — Split-Brain Resolution

Add a deterministic resolver to `HeartbeatManager` / `MultiMachineCoordinator`:

- **Detection (signal).** On each heartbeat tick, if the synced registry shows more than one machine in `role: awake`, emit a `split-brain-detected` signal with the candidate set.
- **Resolution (authority).** The coordinator resolves deterministically:
  1. A machine whose `lastSeen` is older than the failover threshold is **demoted** to `standby` (it is presumed dead/offline).
  2. Among machines with fresh heartbeats, the one with the most recent `lastSeen` wins; ties broken by lowest `machineId` (deterministic, so all machines independently reach the same verdict).
  3. The winner writes the corrected registry (single `awake`); demoted entries are marked `standby` (and `status: offline` if past threshold).
- **Self-demotion safety.** A machine that determines *it* lost must stop awake-only activity (job scheduling, Telegram ingress claim) before yielding — never two schedulers running.
- **Escalation.** If the candidates are genuinely co-fresh and cannot be deterministically separated (clock skew, true partition), emit an Attention-queue item rather than flip-flop. This is the only user-visible path, and only when truly unresolvable.

### G2 — Automated State Sync

Make the running server actually propagate mesh state (the Phase 0 gap):

- `SyncOrchestrator` on the **awake** machine auto-commits + pushes registry and heartbeat changes on a tunable cadence (debounced; not on every field write).
- Standby machines pull on a tunable cadence and on wake.
- Reuse existing `GitSync` field-merge / signed-commit machinery (no new transport for durable state).
- **Idempotent + conflict-free:** registry writes are last-writer-wins per-machine-entry (each machine only authors its own entry, except role demotions which are authored by the resolver winner). This avoids merge conflicts on the shared registry.
- **Failure handling:** a push failure is a signal (retry with backoff), not a crash; sync health is observable via `/health` and `instar doctor`.

### G3 — Live State Sync + Graceful Handoff

The "no amnesia" core. Two state classes, two transports:

- **Durable work state** (work ledger, in-flight task list) → **git** (coarse, every N seconds, tunable). Survives crashes; this is the cross-machine work-ledger visibility the v3 spec named "not yet implemented."
- **Live conversation tail** (the last exchanges, current turn context) → **direct tunnel channel** between awake and standby (low-latency push), buffered so the standby always holds a near-current copy.

**Graceful handoff protocol (both machines live):**

1. New machine requests handoff (existing `HandoffManager` path).
2. Current-awake **flushes** live conversation tail + work ledger to the incoming machine and confirms.
3. Incoming machine **acks "caught up"** (it has the live tail) *before* the current-awake yields.
4. Current-awake demotes to standby; incoming promotes to awake; registry updated (G2 propagates it).
5. Telegram ingress claim transfers atomically (no double-poll, no dropped messages).

The "seamlessness bar" — how fresh the live tail must be at handoff — is **tunable** (see §6). A near-instant bar buffers continuously; a relaxed bar accepts a small catch-up pull at handoff.

---

## Tunability

Per Justin's explicit requirement (balance latency/seamlessness vs. efficiency). All under `.instar/config.json` → `multiMachine`:

| Knob | Default | Meaning |
|------|---------|---------|
| `heartbeatIntervalMs` | 30s | How often the awake machine posts/pushes its heartbeat |
| `registrySyncDebounceMs` | 10s | Debounce window for pushing registry changes |
| `failoverThresholdMs` | (existing, ~15min) | How stale before a peer is presumed dead |
| `liveTailTransport` | `tunnel` | `tunnel` (low-latency) \| `git` (durable-only, cheaper) |
| `liveTailBufferMs` | 5s | Max staleness of the standby's live conversation copy |
| `handoffBar` | `near-instant` | `near-instant` (continuous buffer) \| `relaxed` (catch-up at handoff) |

Defaults target a good experience for 2-machine personal use; high-machine-count or cost-sensitive deployments dial cadence down.

---

## Testing Strategy

Per the Testing Integrity Standard — all three tiers, plus the real-hardware gate:

- **Tier 1 (unit).** Split-brain resolver: both sides of every boundary — two-fresh-awake (deterministic winner), one-stale-one-fresh (demote stale), genuine tie (escalate), self-demotion (loser stops scheduler). Sync debounce logic. Live-tail buffer freshness.
- **Tier 2 (integration).** Full HTTP pipeline: a running server auto-pushes registry on role change (the exact Phase 0 failure — this test would have caught it); standby pulls and converges; handoff over real tunnel transfers the live tail.
- **Tier 3 (e2e lifecycle).** Multi-process: two servers, real local git remote, real localhost tunnels; drive a graceful handoff with an in-flight conversation and assert the incoming machine has the live tail before the outgoing yields; drive a hard failover and assert split-brain resolves to a single awake within threshold.
- **Real-hardware gate.** `docs/MULTI_MACHINE_VERIFICATION.md` (60 items) remains the live acceptance gate. G1/G2/G3 each map to specific checklist sections (§2 Heartbeat/Failover, §3 Git Sync, §6 Handoff, §10 Full Lifecycle).

---

## Migration Parity

Existing multi-machine agents must receive this on update, not just new ones:

- **Config defaults** → `migrateConfig()` adds the `multiMachine` knobs (existence-checked, only missing fields).
- **Resolver + auto-sync** ship in the server; existing agents get them on the next server update. No agent-installed file changes required for G1/G2 beyond config.
- **Idempotent.** Resolver and sync are safe to run repeatedly; a single-machine agent (no peers) is a no-op.

---

## Related Work & Open Questions

- **Companion spec — Agent Self-Propagation Standard.** Justin's standard (one human authorization to grant an agent access to a new machine, then the agent installs itself and everything downstream). The Phase 0 onboarding findings feed it directly: the two-bootstrap access problem (SSH + git credential), `join` not creating a runnable `config.json`, and the default-port (4040) collision risk with an existing agent. **A joining machine must pick a free port and write a runnable config** — tracked there, not here.
- **Server bring-up on a guarded/new machine.** `instar server start` is (correctly) blocked from inside an agent session. The self-propagation flow must define how an agent brings up its *own* server on a new machine without that guard — likely launchd/supervisor registration performed in the onboarding step. Open question for the companion spec.
- **Open: clock-skew handling** in G1 ties (NTP assumption vs. logical clocks).
- **Open: live-tail privacy** — the conversation tail crossing the tunnel must honor the same secret-handling rules as the v3 secret-sync channel.
