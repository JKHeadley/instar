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
2. [User Stories & Channel Experience](#user-stories--channel-experience)
3. [Phase 0 Findings (Empirical Grounding)](#phase-0-findings-empirical-grounding)
4. [Design Principles](#design-principles)
5. [The Seamlessness Gap — Precise Definition](#the-seamlessness-gap--precise-definition)
6. [Proposed Design](#proposed-design)
7. [Tunability](#tunability)
8. [Testing Strategy](#testing-strategy)
9. [Migration Parity](#migration-parity)
10. [Related Work & Open Questions](#related-work--open-questions)

---

## Overview

The converged multi-machine spec (v3) delivered machine identity, secure pairing, git-based state sync, primary/standby coordination, heartbeat/failover, and graceful handoff *machinery*. What it explicitly deferred — and what the EXO 3.0 "cross-machine single agent" vision needs most — is **seamlessness**: the experience that an agent is one logical identity that follows the user across machines with no loss of in-flight context.

**The yardstick is the user's experience in the channel** (Telegram is the default and reference; Slack and any other channel must work equally), not internal state mechanics. "Seamless" is defined entirely from the user's side: a person is mid-conversation with the agent over Telegram; the agent quietly moves machines underneath them; and the person notices *nothing* — no dropped message, no duplicate reply, no "sorry, what were we talking about?", no fresh greeting, no awkward gap. The internal state sync exists only to deliver that channel experience. Every design choice below is justified by a user story, not by architectural elegance.

This spec defines the narrow, high-leverage work to close that gap. It is deliberately scoped to the **runtime** seamlessness problem. The **onboarding** problem (how an agent installs itself onto a new machine) is captured as related work for a companion spec (see §9).

---

## User Stories & Channel Experience

The whole spec serves these. Each gap and design choice traces back to one.

- **US1 — Invisible failover mid-conversation.** *As a user chatting with the agent on Telegram, when the machine currently serving me goes down, I keep chatting and notice nothing — my next message is answered normally, with full memory of what we were just discussing.* (No lost message, no duplicate reply, no re-introduction, no long stall.)
- **US2 — Same agent across my machines.** *As a user (e.g. Adriana) who works on two machines, it's the same agent on both — same conversation, same half-finished task, same context — so I can switch machines and not miss a beat.*
- **US3 — Reliability that's felt, not seen.** *As a user, I just experience an agent that's always there and always coherent; the fact that it spans several machines is invisible. More machines should mean more reliability, never more noise or more confusion.*

### The realistic bar: "no worse than a compaction pause or a fresh-session catch-up"

We are explicitly **not** chasing magically-perfect, zero-latency seamlessness. A machine handoff is the same *kind* of moment users already accept in two existing places: (a) the agent pausing to **compact**, and (b) messaging a topic where a **fresh session spins up and gets up to speed**. Nobody expects those to be invisible — they expect them quick, and to resume knowing what's going on. That is exactly the bar for a handoff. This lets us reuse the catch-up machinery we already trust (compaction-recovery, the CONTINUATION mechanism) rather than build a fragile always-streaming pipe.

The goal is therefore: **carry over as much fresh handoff context as possible, and degrade gracefully when we can't.** Two flavors, two expectations:

- **Planned handoff** (both machines awake; one passes the baton): near-instant, full context flushed across cleanly.
- **Hard failover** (a machine crashes, or the internet drops mid–live-test): best-effort. The backup resumes from the last good sync — it may miss the last few seconds of in-flight context, exactly like a session that crashed and recovered. We explicitly do **not** over-engineer to guarantee perfection in this rare worst case.

### What "seamless" means, measured from the channel (acceptance criteria)

User-facing pass/fail bars, observed on the channel, not in the code:

1. **No lost messages.** Every message the user sends during/around a handoff is processed exactly once. *(Hard guarantee, both flavors — this is the one we don't compromise.)*
2. **No duplicate replies.** The user never receives the same answer twice (a real, recurring instar failure mode — see drain-respawn / gate-latency duplicates). Only one machine "owns" the channel at a time. *(Hard guarantee, both flavors.)*
3. **Maximal context, no fresh-start.** The first reply from the new machine reflects the conversation as of the last sync — no generic greeting, no "what were we talking about?" In a planned handoff this is fully current; in a hard failover it is as-of-last-sync (the compaction/continuation bar). *(Best-effort, bounded by sync freshness.)*
4. **Pause no worse than a compaction / fresh-session catch-up.** A brief, recognizable "getting up to speed" moment is acceptable; an open-ended hang or silent drop is not. Tunable (see §6).
5. **Channel identity follows the agent.** The channel's thread/conversation binding (Telegram topic, Slack channel+thread, etc.) moves with the agent, so replies land in the same conversation regardless of which machine produced them.
6. **Machine-awareness.** The agent always knows which machine served the last turn and that a handoff occurred. This is cheap, lets the agent be honest when context is partial ("picking this up from the other machine"), and feeds per-machine self-knowledge (each machine tracking what is specific to it).

### Channel-agnostic by design (Telegram is the default, not the spec)

Seamlessness is a property of the **channel layer**, not of Telegram specifically. Instar already routes every channel through the adapter pattern (`MessageRouter` → `TelegramAdapter`, `SlackAdapter`, `WhatsAppAdapter`, iMessage, …). This spec defines a single **Channel Seamlessness Contract** that every adapter must satisfy; Telegram is the reference/default implementation, and Slack is the explicit second target. No mechanism here may be Telegram-specific — anything Telegram-specific lives *inside* the Telegram adapter.

**The Channel Seamlessness Contract (every adapter implements):**

1. **Single-owner ingress.** Exactly one machine consumes the channel's inbound stream at any moment (two consumers = duplicate handling). Ownership is recorded in the mesh and transfers atomically on handoff/failover — the outgoing machine releases only once the incoming machine holds the claim.
2. **Resumable consumption position (exactly-once).** Each adapter exposes a durable "where I left off" marker that can be recorded into synced state and resumed by another machine, so the inbound stream is consumed exactly once across a transfer — none dropped, none double-handled. *The marker is per-channel:* Telegram = the long-poll `update_id` offset; Slack = the Events API delivery + per-event dedup id (or socket-mode cursor); other adapters define their own. The contract is "a resumable, exactly-once position exists," not any specific cursor.
3. **Portable conversation identity.** The channel's thread/conversation handle (Telegram topic, Slack channel+thread_ts, etc.) is machine-independent, so replies land in the same conversation regardless of which machine produced them.
4. **Context-before-answer.** The receiving machine must hold that conversation's history + live tail before it answers (prevents the "fresh start" failure). This part is channel-independent — it's agent state, routed by conversation identity.

Instar already has a "messages are not lost — they replay on recovery" guarantee for version-skew restarts; the resumable-position requirement (2) is the cross-machine generalization of it.

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
- **Reuse the catch-up model, don't reinvent.** A handoff is the cross-machine generalization of compaction-recovery and fresh-session continuation. The receiving machine resumes via the existing **CONTINUATION** mechanism, and the user-facing bar is "no worse than a compaction pause." We do not build a fragile always-streaming pipe to chase perfect seamlessness — best-effort context + graceful degradation is the explicit, accepted design point.
- **Machine-aware by default.** The agent records which machine served each turn (provenance, in synced state) and knows when it is resuming someone else's turn. Cheap, and it underpins honest "picking this up from the other machine" behavior plus per-machine self-knowledge.

---

## The Seamlessness Gap — Precise Definition

The gap decomposes into three sub-problems, in dependency order:

| ID | Gap | Why it matters | Phase 0 evidence |
|----|-----|----------------|------------------|
| **G1** | Split-brain resolution | Two "awake" machines = duplicated work, conflicting writes, user confusion | Registry showed both `awake` |
| **G2** | Automated state sync | Without it, no machine has a current view of the mesh; failover/handoff act on stale data | Role change never pushed to git |
| **G3** | Seamless channel experience: ingress ownership transfer + conversation-context availability + no-visible-seam | The actual user-facing "no amnesia" experience on Telegram (US1/US2) | Not yet built |

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

### G3 — Seamless Channel Experience

This is the user-facing core (US1/US2), and it is defined by the channel, not by internal state. It has three parts that together deliver the acceptance criteria in §2.

**(a) Channel-state classes and transports.** Two kinds of state must reach the receiving machine:

- **Durable work state** (work ledger, in-flight task list) → **git** (coarse, every N seconds, tunable). Survives crashes; this is the cross-machine work-ledger visibility the v3 spec named "not yet implemented."
- **Live conversation tail** (the recent exchanges + current turn context for each active channel/topic) → **direct tunnel channel** between awake and standby (low-latency push), buffered so the standby always holds a near-current copy. This is what satisfies "context retained" (criterion 3) — the receiving machine can answer the next message coherently.

**(b) Channel ingress ownership transfer (the no-loss / no-duplicate guarantee).** This implements the Channel Seamlessness Contract (§2) and is channel-agnostic; each adapter plugs in its own resumable position. The protocol guarantees exactly-once handling:

1. Incoming machine signals intent to take ingress ownership.
2. Outgoing machine **stops consuming** and records the adapter's resumable position into synced state (Telegram: last-processed `update_id`; Slack: last-acked event/cursor; etc.).
3. Incoming machine **resumes consuming from that exact position** — messages in the transfer window are processed exactly once (none dropped, none double-handled). This directly serves criteria 1 & 2.
4. Only one machine ever holds the ingress claim at a time (enforced via the mesh registry / a claim record), so two machines can never both reply.

The handoff orchestration (claim, record-position, resume) lives in the shared coordination layer; only the "read/record/resume my position" primitive is per-adapter. Telegram is the reference implementation; Slack is the second target and validates that the contract is genuinely channel-agnostic.

**(c) Graceful handoff protocol (both machines live):**

1. New machine requests handoff (existing `HandoffManager` path).
2. Current-awake **flushes** the live conversation tail + work ledger to the incoming machine and confirms.
3. Incoming machine **acks "caught up"** (it holds the live tail + thread history) *before* the current-awake yields — this prevents the "fresh start" failure (criterion 3).
4. Ingress ownership transfers per (b); the channel/topic binding follows the agent (criterion 5).
5. Current-awake demotes to standby; incoming promotes to awake; registry updated (G2 propagates it).
6. On the receiving side, the agent session resumes via the existing **CONTINUATION** mechanism — it picks up the conversation rather than re-greeting.

**Failover (outgoing machine died, not graceful):** the incoming machine cannot receive a flush, so it relies on the last synced live tail (freshness bounded by `liveTailBufferMs`) + thread history + the recorded ingress offset. The user may experience at most a small catch-up gap (criterion 4's bound) but no lost/duplicate messages and no amnesia beyond the buffer window.

The "seamlessness bar" — how fresh the live tail must be, and how aggressive the handoff is — is **tunable** (see §6). A near-instant bar buffers continuously; a relaxed bar accepts a small catch-up pull at handoff. The bar is chosen to keep the user-perceived pause within criterion 4.

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
- **Channel-experience acceptance (the real bar).** Beyond the mechanical tiers, the §2 user-facing criteria are tested *from the channel*: drive a real conversation across a handoff/failover and assert — exactly-once message handling (no loss, no duplicate reply), context retained in the first post-handoff reply (no re-greeting), and perceived gap within bound. This is the test that actually proves US1/US2; the mechanical tiers exist to make it pass.
- **Contract conformance across channels.** The acceptance suite runs against **Telegram (reference) AND Slack** to prove the Channel Seamlessness Contract is genuinely channel-agnostic, not Telegram-shaped. A new adapter is "seamless-ready" only when it passes this same suite — making the contract the structural gate for any future channel.
- **Real-hardware gate.** `docs/MULTI_MACHINE_VERIFICATION.md` (60 items) remains the live acceptance gate. G1/G2/G3 each map to specific checklist sections (§2 Heartbeat/Failover, §3 Git Sync, §6 Handoff, §7 Communication, §10 Full Lifecycle).

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
