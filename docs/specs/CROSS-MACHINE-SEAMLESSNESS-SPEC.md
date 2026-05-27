---
title: "Cross-Machine Seamlessness"
slug: "cross-machine-seamlessness"
author: "echo"
eli16-overview: "CROSS-MACHINE-SEAMLESSNESS-SPEC.eli16.md"
approved: true  # Justin approved 2026-05-27 over Telegram (topic 13481), after reviewing the 5-round convergence result
principal-signoff: approved  # onboarding/self-install gaps are owned by ACT-156 (companion Self-Propagation spec); this spec's scope is approved as-is
review-convergence: "2026-05-27T05:52:19.795Z"
review-iterations: 5
review-completed-at: "2026-05-27T05:52:19.795Z"
review-report: "docs/specs/reports/cross-machine-seamlessness-convergence.md"
---

# Cross-Machine Seamlessness Specification

> Close the gap between "a backup machine can take over" and "the same agent follows you across machines with no amnesia." Grounded in real-hardware Phase 0 verification.

**Status**: Draft v1 (converged through multi-angle review; grounded in real-hardware verification 2026-05-26)
**Author**: Echo (with Justin's direction)
**Builds on**: [`MULTI-MACHINE-SPEC.md`](./MULTI-MACHINE-SPEC.md) (v3, converged) — this spec does NOT replace it; it closes the seamlessness gap that v3 explicitly left open.
**Companion (read first)**: [`CROSS-MACHINE-SEAMLESSNESS-SPEC.eli16.md`](./CROSS-MACHINE-SEAMLESSNESS-SPEC.eli16.md)
**Motivating initiative**: Instar × EXO 3.0 — cross-machine single-agent ("one Luna across machines"), Pillar 2.

---

## Table of Contents

1. [Overview](#overview)
2. [User Stories & Channel Experience](#user-stories--channel-experience)
3. [Guarantees: What Is Hard vs Best-Effort (RPO/RTO)](#guarantees-what-is-hard-vs-best-effort-rporto)
4. [Phase 0 Findings (Empirical Grounding)](#phase-0-findings-empirical-grounding)
5. [Design Principles](#design-principles)
6. [Coordination Primitive — The Fenced Lease](#coordination-primitive--the-fenced-lease)
7. [The Seamlessness Gap — Precise Definition](#the-seamlessness-gap--precise-definition)
8. [Proposed Design](#proposed-design)
9. [Tunability](#tunability)
10. [Testing Strategy](#testing-strategy)
11. [Migration Parity & Agent Awareness](#migration-parity--agent-awareness)
12. [Related Work & Open Questions](#related-work--open-questions)

---

## Overview

The converged multi-machine spec (v3) delivered machine identity, secure pairing, git-based state sync, primary/standby coordination, heartbeat/failover, and graceful handoff *machinery*. What it explicitly left for a follow-on — and what the EXO 3.0 "cross-machine single agent" vision needs most — is **seamlessness**: the experience that an agent is one logical identity that follows the user across machines with no loss of in-flight context.

**The yardstick is the user's experience in the channel** (Telegram is the default and reference; Slack and any other channel must work equally), not internal state mechanics. "Seamless" is defined entirely from the user's side: a person is mid-conversation with the agent over Telegram; the agent quietly moves machines underneath them; and the person notices *nothing* worse than a brief "getting up to speed" beat. The internal state sync exists only to deliver that channel experience. Every design choice below is justified by a user story, not by architectural elegance.

This spec defines the narrow, high-leverage work to close that gap. It is deliberately scoped to the **runtime** seamlessness problem. The **onboarding** problem (how an agent installs itself onto a new machine) is captured as related work for a companion spec (see §12).

> **What review changed (v0 → v1).** The first draft trusted wall-clock timestamps for leader election, treated "only one machine consumes the channel" as sufficient to prevent duplicate replies, and left the live-tail transport's security as an open question. Multi-angle review (security, scalability, adversarial, integration, lessons-aware, and an external GPT-class reviewer) showed all three were unsafe under the exact failure modes this spec exists to handle (clock skew, network partition, crash mid-handoff). v1 introduces a single **fenced-lease** coordination primitive as the backbone, makes message processing **idempotent at the message level** (so duplicates are structurally impossible rather than merely unlikely), and promotes transport security to a normative requirement.

---

## User Stories & Channel Experience

The whole spec serves these. Each gap and design choice traces back to one.

- **US1 — Invisible failover mid-conversation.** *As a user chatting with the agent on Telegram, when the machine currently serving me goes down, I keep chatting and notice nothing worse than a short catch-up beat — my next message is answered normally, with memory of what we were just discussing.*
- **US2 — Same agent across my machines.** *As a user who works on two machines, it's the same agent on both — same conversation, same half-finished task, same context — so I can switch machines and not miss a beat.*
- **US3 — Reliability that's felt, not seen.** *As a user, I just experience an agent that's always there and always coherent; the fact that it spans several machines is invisible. More machines should mean more reliability, never more noise or more confusion.*

### The realistic bar: "no worse than a compaction pause or a fresh-session catch-up"

We are explicitly **not** chasing magically-perfect, zero-latency seamlessness. A machine handoff is the same *kind* of moment users already accept in two existing places: (a) the agent pausing to **compact**, and (b) messaging a topic where a **fresh session spins up and gets up to speed**. Nobody expects those to be invisible — they expect them quick, and to resume knowing what's going on. That is exactly the bar for a handoff. This lets us reuse the catch-up machinery we already trust (compaction-recovery, the CONTINUATION mechanism) rather than build a fragile always-streaming pipe.

The goal is therefore: **carry over as much fresh handoff context as possible, and degrade gracefully when we can't.** Two flavors, two expectations:

- **Planned handoff** (both machines awake; one passes the baton): near-instant, full context flushed across cleanly.
- **Hard failover** (a machine crashes, or the internet drops mid–live-test): best-effort. The backup resumes from the last good sync — it may miss the last few seconds of in-flight *context*, exactly like a session that crashed and recovered. We explicitly do **not** over-engineer to guarantee perfect context recovery in this rare worst case. (Note: "may miss context" is about conversational *freshness*, not about *losing or duplicating messages* — those remain hard guarantees; see §3.)

### What "seamless" means, measured from the channel (acceptance criteria)

User-facing pass/fail bars, observed on the channel, not in the code:

1. **No lost messages.** Every message the user sends during/around a handoff is processed *at least once and acted on exactly once*. *(Hard guarantee, both flavors — see §3 for the mechanism.)*
2. **No duplicate replies.** The user never receives the same answer twice (a real, recurring instar failure mode — see drain-respawn / gate-latency duplicates). *(Hard guarantee, both flavors — enforced by message-level idempotency, not merely by single-consumer ingress; see §3 and §8 G3.)*
3. **Maximal context, no fresh-start.** The first reply from the new machine reflects the conversation as of the last sync — no generic greeting, no "what were we talking about?" In a planned handoff this is fully current; in a hard failover it is as-of-last-sync (the compaction/continuation bar). *(Best-effort, bounded by sync freshness — see RPO in §3.)*
4. **Pause no worse than a compaction / fresh-session catch-up.** A brief, recognizable "getting up to speed" moment is acceptable; an open-ended hang or silent drop is not. Bounded by RTO (§3) and tunable (§9).
5. **Channel identity follows the agent.** The channel's thread/conversation binding (Telegram topic, Slack channel+thread, etc.) moves with the agent, so replies land in the same conversation regardless of which machine produced them.
6. **Machine-awareness.** The agent always knows which machine served the last turn and that a handoff occurred. This is cheap, lets the agent be honest when context is partial ("picking this up from the other machine"), and feeds per-machine self-knowledge. Provenance is recorded as an **Integrated-Being Ledger** entry (kind `turn-provenance`) — the existing *synced* cross-machine store, not a new parallel one — and surfaced to the agent via the existing CONTINUATION injection, not a permanent CLAUDE.md section (avoids context bloat, lesson L1). Because the IBL is synced (not local-only), provenance is consistent across a handoff; if a failover outpaces IBL sync, the agent reports honestly ("served from the other machine, exact provenance catching up") rather than asserting a stale machine.

### Channel-agnostic by design (Telegram is the default, not the spec)

Seamlessness is a property of the **channel layer**, not of Telegram specifically. Instar already routes every channel through the adapter pattern (`MessageRouter` → `TelegramAdapter`, `SlackAdapter`, `WhatsAppAdapter`, iMessage, …). This spec defines a single **Channel Seamlessness Contract** that every adapter must satisfy; Telegram is the reference/default implementation, and Slack is the explicit second target. **WhatsApp and iMessage are out of scope for the launch contract** (they get the contract later). No mechanism here may be Telegram-specific — anything Telegram-specific lives *inside* the Telegram adapter.

**The Channel Seamlessness Contract (every adapter implements).** This requires extending the existing `MessagingAdapter` interface (`src/core/types.ts`), which today exposes only `start`/`stop`/`send`/`onMessage`/`resolveUser`. The new methods (final signatures fixed during implementation):

1. **`getIngressPosition(): IngressPosition`** — the adapter's durable "where I left off" marker, serializable into synced state. Telegram = the long-poll `update_id` offset; Slack = the per-conversation `lastTs` cursor (`channelResumeMap`) with documented best-effort semantics (Slack socket-mode has *no* exactly-once cursor — see below).
2. **`stopConsuming(): Promise<IngressPosition>`** — stop the inbound loop, drain or discard any in-flight batch deterministically, and return the durable position *after* the stop is complete (not the in-memory cursor).
3. **`resumeConsuming(position: IngressPosition): Promise<void>`** — resume the inbound loop from exactly that position.
4. **`dedupeKey(rawEvent): string`** — a stable provider-level identity for an inbound event (Telegram `update_id`; Slack `event_id`/`client_msg_id`), used by the message-processing ledger (§3, §8 G3) so a redelivered event is recognized and not re-acted-on.

**Channels are at-least-once, not exactly-once.** Telegram long-poll and Slack Events API both redeliver on reconnect/retry; an offset/cursor alone does not give exactly-once *processing* across a consumer transfer. The contract therefore guarantees exactly-once *effect* via (4) + the durable message-processing ledger, **not** by assuming the cursor is a transactional boundary. Slack in particular: socket-mode resumes from reconnect, so its resumable position is the coarse `lastTs` and its exactly-once property comes entirely from `event_id` dedup. A new adapter is "seamless-ready" only when it passes the §10 contract-conformance suite.

---

## Guarantees: What Is Hard vs Best-Effort (RPO/RTO)

The honest split (this is what makes "no worse than a compaction pause" a checkable promise, not a vibe):

| Property | Guarantee | Mechanism | Bound |
|----------|-----------|-----------|-------|
| Message **acted-on exactly once** (no lost, no duplicate reply) | **HARD** (both planned + hard failover) | Durable per-message processing ledger keyed by `dedupeKey`; idempotent reply/outbox reservation gated by fencing token; dual-medium `reply_committed` marker + outbound idempotency key | Always, with one named impossibility-floor exception: a single duplicate reply is possible only under a simultaneous triple-fault (reply physically sent → hard crash before the marker reaches tunnel *or* git → channel has no native outbound dedup). See §8 G3a. |
| Outbound reply delivered | **HARD, at-least-once with dedup** | Outbox reservation + fencing token; receiver-side dedup by reply key | Always |
| Conversational **context freshness** | **BEST-EFFORT** | Live-tail sync (planned: synchronous flush; failover: last synced tail) | **RPO** = `liveTailMaxStalenessMs` (default 5s). Planned handoff RPO ≈ 0. |
| User-perceived **pause** at handoff | **BEST-EFFORT, bounded** | CONTINUATION resume on receiving machine | **RTO** ≤ `handoffAckTimeoutMs` + continuation spin-up (target: ≤ a normal fresh-session spin-up) |

**RPO** (Recovery Point Objective) = how much in-flight *context* a hard failover may lose: at most one live-tail staleness window. **RTO** (Recovery Time Objective) = how long the user may wait: bounded by the ack timeout plus a normal session catch-up. Message *processing* is never sacrificed to either bound — only context freshness and pause length are best-effort. This directly encodes Justin's framing: a handoff is allowed to feel like a compaction pause, but it is never allowed to drop or double-answer a message.

---

## Phase 0 Findings (Empirical Grounding)

This spec is not theoretical. On 2026-05-26 the multi-machine system was run on two real machines for the first time (a laptop + a Mac mini, a dedicated throwaway test agent), validating the v3 foundation and surfacing the precise gaps. Prior to this, the 60-item `MULTI_MACHINE_VERIFICATION.md` checklist was entirely unchecked.

**What works on real hardware:**

- **✅ Pairing (Checklist §1).** `instar pair` → `instar join <repo-url> --code` paired two real machines into one mesh. The pairing handshake completes **via the git repository** — no live server-to-server connection was required.
- **✅ Self-election.** A standby machine whose server starts while no other machine is posting a fresh heartbeat correctly claims the `awake` role on its own.

**What does NOT work yet (this spec's targets):**

- **❌ G1 — Split-brain resolution.** After self-election, the mesh registry recorded **both** machines as `role: awake` simultaneously. The newly-awake machine never demoted the silent peer, even though the differentiator was present (the silent machine's `lastSeen` was ~54 minutes stale, far past the 15-minute failover threshold).
- **❌ G2 — Automated state sync.** A running server modified its local registry (role change) and other state, but did **not** auto-commit/push those changes to git. Cross-machine state propagated only when pushed/pulled by hand. **Root cause confirmed during review:** `MultiMachineCoordinator` holds no reference to `SyncOrchestrator` and emits its `roleChange` event with no subscriber that marks the registry dirty — so the push never fires. This is a *wiring* gap, and the fix must name the wiring (§8 G2), not just the intent, or it will ship as dead code a second time.
- **❌ G3 — Live state sync + graceful handoff (untested, by design).** The test exercised startup-election against a dead peer, not a clean baton-pass between two live machines, because the seamless live-state path does not yet exist.

**Onboarding findings (→ companion spec, §12):** granting an agent access to a new machine is **two** bootstraps (SSH onto the host, *and* git credential to fetch the agent's repo); `join` does not create a runnable `config.json`, so a freshly-joined server defaults to port 4040 and can **collide with an existing agent** on that machine; the configured port does not propagate (it lives in gitignored `config.json`).

---

## Design Principles

- **Structure > Willpower.** Awake-only privilege is enforced by a **structural gate**, never by an agent or process "remembering" to demote itself. The job scheduler and every channel's ingress consumer check `holdsValidLease(self)` against synced state *on each tick / before each poll* and refuse to operate otherwise — even if the in-process demotion signal was never delivered (the Phase 0 split-brain was exactly a missing structural demotion). A machine that cannot prove it is visible (sync push failing past a threshold) self-suspends ingress.
- **Signal vs. Authority.** Detectors (e.g. "I see two awake machines") emit *signals*; **only the holder of the current coordination lease has authority** to demote a peer, transfer ingress, or write authority-bearing registry state. Non-holders may detect and signal but must not mutate roles. This removes the v0 anti-pattern where every machine simultaneously ran the resolver and all wrote the registry.
- **Idempotency over single-consumer.** "No duplicate replies" is guaranteed by making message *effects* idempotent (a durable processing ledger keyed on the provider event id + a fencing-token-gated outbox), not by the weaker assumption that exactly one machine ever consumes. Single-consumer is still the normal case; idempotency is what holds during the overlap window of a partition or crash.
- **Near-silent.** Sync and reconciliation are housekeeping. They write to logs/audit trails, not the user's chat. The user hears about cross-machine activity only when it is genuinely actionable (an unresolvable split-brain requiring a decision) — and that escalation is **deduped per partition-episode**, never per heartbeat tick.
- **Tunable latency vs. efficiency** (explicit Justin requirement). Every cadence/aggressiveness knob is configurable with sane defaults; "more machines = more reliable" must not mean "more machines = constant chatter" — enforced by an explicit cost ceiling (§9).
- **Ephemeral liveness ≠ durable history.** Heartbeats/leases are high-frequency and disposable; git history is durable and append-only. They must not share a write path, or the repo bloats by thousands of commits/day (§8 G2).
- **Reuse the catch-up model, don't reinvent.** A handoff is the cross-machine generalization of compaction-recovery and fresh-session continuation. The receiving machine resumes via the existing **CONTINUATION** mechanism; the user-facing bar is "no worse than a compaction pause." No fragile always-streaming pipe.
- **Own the lifecycle.** A single sentinel class owns the whole handoff (detect → attempt → verify → retry → finalize) with race guards, rather than scattering the steps across five components (§8 G3e).

---

## Coordination Primitive — The Fenced Lease

Everything authority-bearing (who is awake, who holds channel ingress) is expressed as a **fenced lease**, the standard distributed-systems primitive for "exactly one holder, safe under clock skew and partition." This single primitive resolves the split-brain, ingress-ownership, and authority findings together.

- **Epoch (fencing token).** A monotonically increasing integer, advanced once per successful lease acquisition. It is the *authority clock* — never wall-clock time. Stored in the registry as `leaseEpoch`.
- **Lease record.** A single registry object: `{ holder: machineId, epoch: N, expiresAt: <holder-local-monotonic+TTL>, signature }`, signed with the holder's Ed25519 key (the v3 machine key). Acquisition is a **compare-and-swap**: a machine may take the lease only by writing `epoch = currentEpoch + 1` and only if no unexpired higher-or-equal epoch exists. Git has no native CAS, so the CAS is enforced via (a) push-fast-forward-or-reject + re-read + re-evaluate, and (b) epoch monotonicity: a push that would not advance the epoch, or that conflicts, is rejected and retried from fresh state. **Epoch gaps are explicitly safe** — any holder observed at an epoch higher than mine wins on re-read; skipping a number is never an error. To prevent a symmetric **livelock** (two live machines repeatedly contending and re-reading without either landing), CAS acquisition has a bounded retry (default 5, exponential backoff); after exhaustion the higher-`machineId` machine backs off for `leaseTtlMs` before retrying, guaranteeing one side lands. A machine that cannot push at all (net-isolated) self-suspends ingress (structural gate, §8 G2) rather than serving on an unconfirmable lease. The **low-latency authoritative copy of the lease travels over the tunnel** (bounded by RTT); the git copy is the durable audit trail, not the transfer mechanism — this closes the git-cadence transfer-window race.
- **Fencing check.** Before *every* awake-only action — ingress poll, scheduler tick, outbound send, authority-bearing registry write — the actor verifies it holds the lease at the current epoch (`holdsValidLease(self)`), and stamps its writes/sends with that epoch. Any consumer (registry, outbox, the channel-send path) **rejects actions stamped with a stale epoch.** A wedged old-awake that resumes after the lease moved on is fenced out: its late writes and late sends carry an old epoch and are dropped. **The epoch used for the fencing check is `max(tunnel-observed, git-committed)`** — a fast tunnel copy can *accelerate* acquisition but can never lower the observed epoch below what git has already committed. Normatively, **a tunnel lease message is accepted only if its `leaseEpoch ≥ the current git-committed epoch`** (below-floor messages are dropped), and each lease message carries a per-holder monotonic nonce so a replay of a previously-seen message is detected and ignored — together these mean a delayed/replayed tunnel message can neither trick a standby into believing a stale lease is current nor suppress a legitimate acquisition once the real holder's lease has TTL-expired.
- **Lease renewal requires the tunnel medium.** A holder renews its lease over the tunnel each `ingressHeartbeatMs`. If it cannot renew for `> leaseTtlMs` (tunnel unreachable), it **MUST self-suspend ingress regardless of its local monotonic clock** — the lease lapses; it does not get to keep serving on a clock it controls. This closes the tunnel-down / git-up split-authority window (a stranded old-awake stops within `leaseTtlMs`, well before a standby's failover acquisition).
- **`machineId` is unforgeable.** Derived from the machine's Ed25519 public key (hash/truncation), so it is unique and cryptographically bound — safe to use as the deterministic tiebreaker and as the lease holder identity.
- **Clock-skew safety.** Election authority is the epoch, not `lastSeen`. `lastSeen` is retained only for human-readable staleness and for the *liveness* heuristic (presumed-dead after `failoverThresholdMs`), and that threshold must exceed worst-case NTP drift by ≥2×. A machine with a fast clock can no longer "win" anything — it has no way to advance the epoch without a valid CAS.

A machine's roles map onto the lease: **awake = holds the coordination lease**; **standby = does not.** "Split-brain" becomes definitionally impossible for *new* actions (two machines cannot both hold the same epoch); any residual overlap during a transfer is bounded by the lease TTL and rendered harmless by the idempotent message ledger.

---

## The Seamlessness Gap — Precise Definition

| ID | Gap | Why it matters | Phase 0 evidence |
|----|-----|----------------|------------------|
| **G1** | Lease-based leader resolution (replaces split-brain "resolver") | Two "awake" machines = duplicated work, conflicting writes, user confusion | Registry showed both `awake` |
| **G2** | Automated state sync, with ephemeral/durable separation + the missing wiring | Without it, no machine has a current view of the mesh; failover/handoff act on stale data | Role change never pushed; `SyncOrchestrator` not wired to `roleChange` |
| **G3** | Seamless channel experience: idempotent ingress + lease-fenced ownership transfer + context availability + a lifecycle owner | The actual user-facing "no amnesia, no double-reply" experience (US1/US2) | Not yet built |

G2 is a prerequisite for trustworthy G1 and G3 (you cannot resolve or hand off on stale state). G1's determinism holds **only** because the lease lives on the low-latency tunnel path; the git copy may lag, but authority does not depend on the git copy being current.

---

## Proposed Design

### G1 — Lease-Based Leader Resolution

Replaces the v0 "every machine runs the resolver and writes the registry" design (which violated signal-vs-authority and raced under skew).

- **Detection (signal, any machine).** On each heartbeat tick, if the synced registry shows more than one machine claiming `awake`, or the lease appears expired/contested, emit a `lease-contested` signal. Detection never mutates roles.
- **Acquisition (authority, CAS).** A machine that believes it should be awake (startup with no live holder; failover threshold passed for the current holder; planned handoff target) attempts to acquire the lease: CAS `epoch+1` over the tunnel; on git, push-or-reject-then-reread. Exactly one acquisition can win an epoch. The winner is, by construction, the single authority.
- **Demotion is structural, not cooperative.** A machine that does *not* hold the current lease is standby — its scheduler and ingress consumers are gated off by `holdsValidLease(self)` regardless of any in-memory signal. The Phase 0 "nobody demoted the silent peer" cannot recur: the silent peer's lease expires, and a single CAS acquisition by the live machine makes it the sole holder; the silent peer, on any later action, fails its own fencing check.
- **Liveness tiebreak.** Presumed-dead (`lastSeen` older than `failoverThresholdMs`, which exceeds NTP drift ×2) frees the lease for acquisition. If two genuinely-live machines contend, the CAS resolves it deterministically (only one epoch advance wins); the unforgeable lowest-`machineId` is the deterministic preference for *who attempts first*, but correctness does not depend on it — the CAS is the real arbiter.
- **Escalation (the only user-visible path).** If acquisition cannot complete (e.g. a true partition where neither side can advance the epoch via any shared medium), emit **one** Attention-queue item, deduped on a stable `partitionEpisodeId` (not per-tick), carrying a specific decision ("machine X looks alive but unreachable — demote it? Y/N") and a `recurrenceCount`. After `splitBrainEscalationCooldownMs` the resolver stops re-evaluating until the user acts.
- **Supervision.** Tier 0 (pure deterministic algorithm, no policy judgment) — *justified*: the escalation fires only on an **unambiguous** trigger (`lastSeen` past the drift-padded `failoverThresholdMs`, or a CAS that cannot land on any shared medium), and the Attention item presents the contested state as **data** (which machine, its last-seen, the evidence) plus a Y/N decision — it does not author a recommendation. There is no soft framing judgment for an LLM to get wrong; the only judgment (which machine to keep) is the user's. (If future telemetry shows the deterministic framing can still mislead, a Tier-1 framing pass is the upgrade path — noted, not built.)

### G2 — Automated State Sync (with the missing wiring named)

- **Ephemeral vs durable split (closes the git-bloat finding).** Heartbeat/lease liveness is **not** committed to git history on every tick. It lives in a compact, single-blob state file written by atomic rename and propagated over the tunnel; only **meaningful, durable** state transitions (role/lease epoch change, work-ledger checkpoints) are committed to git, and those are debounced and coarse. Steady-state healthy operation produces ~0 commits, not thousands/day.
- **The wiring (the Phase 0 fix, stated explicitly).** `MultiMachineCoordinator.on('roleChange', …)` (and lease-epoch change) calls `syncOrchestrator.markRegistryDirty()`; the subscription is established in `AgentServer` startup where both objects already exist; the debounce lives in a `RegistrySyncDebouncer` (or `GitSync`'s pending-paths flush). A **wiring-integrity test** (§10) asserts the subscription exists and a simulated role change triggers a push — this test would have caught Phase 0.
- **Single-writer for authority state.** Only the lease holder writes authority-bearing registry fields; each machine writes only its own liveness entry. This removes the O(N) thundering-herd of every machine pushing a corrected registry.
- **Push contention handling.** Every push is preceded by `pull --rebase`; on non-fast-forward, re-read, re-evaluate against the current epoch, and only act if still authoritative; exponential backoff, max-retry, then a sync-health signal. A machine failing to push its liveness for `> ingressHeartbeatMs × N` self-suspends ingress (structural gate above).
- **Replay/freshness on pull.** Applied registry commits must carry a strictly-increasing `syncSequence` per author, **the `leaseEpoch` they were authored under**, and a valid signature (v3 signed-commit + revoked-machine rejection already exists). A commit is discarded (logged, not applied) if it is unsigned, its `syncSequence` is stale for its author, **or its `leaseEpoch` is lower than the current committed epoch** — the epoch check catches the case a per-author sequence cannot: a machine that wiped/restored local state (sequence resets to 0) or re-keyed cannot smuggle in an authority-bearing write, because its stale `leaseEpoch` is rejected regardless of a locally-monotonic sequence.
- **Unknown-key first commit is constrained.** The **first** commit from a previously-unseen `machineId` (a re-keyed or freshly-joined machine) is accepted **only** if it is `role: standby` + `rejoined: true` (or a valid pairing-join record); any unknown-key first commit asserting an awake role or a lease claim is rejected. A rejoining machine must always pull-and-read before writing — it never writes its stale prior role. (Security-negative test, §10.)
- **Supervision.** Tier 0 (mechanical), with the sync-health signal feeding the existing monitoring layer.

### G3 — Seamless Channel Experience

The user-facing core (US1/US2), defined by the channel. Five parts.

**(a) Idempotent message processing (the no-loss / no-duplicate guarantee).** A durable **message-processing ledger**, keyed by the adapter's `dedupeKey(rawEvent)`, records each inbound event's lifecycle: `received → processing → reply_committed → cursor_advanced`. Rules:
- An event whose `dedupeKey` is already `reply_committed`/`cursor_advanced` is **never acted on again** — redelivery (Telegram retry, Slack reconnect, or a transfer-window overlap) is recognized and dropped.
- The outbound reply is reserved in a **fencing-token-gated outbox** before send; a machine may only send while holding the lease at the stamped epoch. A fenced (stale-epoch) machine's in-flight reply is suppressed at the send path. This is what actually prevents the double-reply the spec promises — not the assumption of a single consumer.
- **Outbound idempotency key + dual-medium sent-marker (closes the `reply_committed`-during-failover dup).** Every reply carries a deterministic idempotency key (`hash(dedupeKey + replyIndex)`) that any machine re-running the same event reproduces identically. The `reply_committed` marker (and the idempotency key of the sent reply) is propagated over **both** the tunnel *and* git, so a failover where either medium survived sees the reply already happened and does not re-send. On a channel with native outbound dedup, the key makes re-send a no-op even if no marker propagated. **Honest residual:** the only case that can still produce *one* duplicate reply is the simultaneous triple-fault — reply physically sent, then the holder hard-crashes before the marker reaches *either* medium, on a channel with *no* native outbound dedup (Telegram). This is the Two-Generals impossibility floor, not a design defect; it is bounded to a single duplicate, surfaced honestly in §3, and mitigated (not eliminable) by the dual-medium marker + idempotency key.
- The ingress cursor advances **only** on durable completion (`cursor_advanced`), so a crash before completion replays the event (at-least-once) and the ledger makes the replay a no-op-or-resume (exactly-once effect).
- **Storage substrate (named, per lesson L17 + Migration Parity).** The ledger and outbox are **SQLite-backed** (the same proven path as `PendingRelayStore` / `CommitmentTracker`: WAL + busy_timeout, per-agent-id isolation), **not** a new ad-hoc JSON file and **not** a new git-synced blob. They **self-initialize** on first access (schema created if absent) — no `migrateConfig` schema step needed; this is stated in §11. They are not folded into the Integrated-Being Ledger because their write rate (per-message, sub-second) and dedup-keyed access pattern differ from the IBL's coarse durable entries — this divergence is deliberate, not the L17 backtrack-tell.
- **Durability is local-immediate, cross-machine bounded by the lease medium (honest statement).** Each lifecycle transition is flushed to local SQLite **synchronously, on commit** — *not* on the debounced `registrySyncDebounceMs` git cadence — so a crash-and-restart on the *same* machine never double-acts. For a *hard failover to another* machine, ledger transitions propagate over the **same low-latency tunnel as the lease** (not the coarse git path), so the receiving machine's view is fresh to within tunnel RTT; the residual worst case (tunnel-down hard crash) is bounded and reconciled by `dedupeKey` on the provider's at-least-once redelivery — the channel itself re-presents the event, and the ledger dedups it once the standby's ledger catches up.
- **Stuck-`processing` recovery.** An entry left in `processing` past `maxProcessingMs` (e.g. the old holder was fenced mid–LLM-turn and its reply suppressed) is eligible for re-run by the current lease holder, which re-executes the turn from the ledger entry's stored input. The fenced machine's abandoned output is discarded. This prevents an event from being stranded in `processing` forever when a lease moves during a long turn. (Tier-1 test, §10.)

**(b) Channel-state classes and transports.**
- **Durable work state** (work ledger, in-flight task list, the message-processing ledger) → **git** (coarse, on checkpoint, tunable; subject to the ephemeral/durable split in G2).
- **Live conversation tail** (recent exchanges + current-turn context per active topic) → **direct tunnel channel**, low-latency push, **persisted on the standby** (acknowledged, with freshness metadata) so a hard failover has a durable, not merely in-memory, copy. Bounded by `liveTailMaxBytesPerTopic` (drop-oldest) and a push-rate cap; on N>3 machines, only the designated next-in-line standby maintains a live-tail subscription, others pull from git (the cost ceiling that makes "more machines = more reliable, not more chatter" actually hold).
- **Tail flushes are sequence-deduped on the standby (context-integrity).** Each flush carries the monotonic sequence (§8 G3c). The standby applies a flush **only if its sequence is `lastAppliedSeq + 1`**, coalescing/holding out-of-order flushes and dropping duplicates — so an at-least-once tunnel redelivery cannot double-append and corrupt the persisted context window (which would make the post-failover reply misrepresent history, violating criterion 3). Out-of-order flushes are held only until `liveTailOutOfOrderTimeoutMs` (default = `leaseTtlMs`); if the gap is never filled (sender died mid-sequence), the standby **declares the gap unfillable, discards the held flushes, and proceeds with the last contiguous sequence** as its resumable tail — bounding the holdout buffer and never wedging the standby behind a gap the at-least-once channel will re-present anyway. To bound the redaction/leak surface, large raw tool-output is **carried by reference** (a pointer into the durable encrypted work-ledger) rather than inlined into the tail wherever feasible, so the secret-redaction problem (§8 G3c) is reduced structurally, not left purely to pattern-matching.

**(c) Live-tail transport security (NORMATIVE — promoted from open question).** The live tail carries the most sensitive data in the system (user messages, tool outputs, incidentally-present secrets). It therefore MUST:
- Be **mutually authenticated** — the receiver's machine identity is verified against the mesh registry's Ed25519 public key before any tail content is accepted or decrypted.
- Use **authenticated encryption in transit** — the same scheme as v3 secret sync (ephemeral X25519 key agreement + XChaCha20-Poly1305), forward-secret per flush.
- Carry a **monotonic sequence** for replay protection and a wall-clock stamp **for staleness display only** (never for election).
- **Redact/exclude secrets** — content matching v3's secret patterns (tokens, keys, Secret Drop payloads) is redacted or routed through the v3 secret channel, never sent in the clear over the tail. The redaction **category set is versioned alongside this spec** (a named enum, not an ad-hoc inline regex) so it can be extended as new token/credential shapes appear; combined with the carry-by-reference rule (§8 G3b), the tail minimizes raw sensitive bytes structurally rather than relying on pattern-matching alone. Note the residual: the standby persists the *decrypted* tail, so a compromised standby is a cleartext-exposure surface — carry-by-reference keeps the heaviest such content (tool output) out of the tail.
- Be **rejected if the peer identity cannot be verified.** A §10 security-negative test asserts this.

**(d) Verifiable, bounded handoff acknowledgment.** "Caught up" is not a bare boolean. The incoming machine's ack must **echo**: the live-tail sequence number it holds, the ingress position it will resume from, and a hash of the thread history it loaded. The outgoing machine verifies the echo matches what it flushed *before* yielding. There is a hard `handoffAckTimeoutMs`: if the verified ack does not arrive, the **graceful handoff is aborted and the outgoing machine stays awake** (planned case) or the system falls through to failover semantics — it **never** yields ingress on an unverified or absent ack. The ack travels over the same tunnel as the tail, so a dead tunnel correctly forces failover mode rather than a false "caught up."

**(e) The handoff lifecycle owner (own-the-lifecycle).** A single **`HandoffSentinel`** owns the entire handoff as an explicit epoch state machine — `prepare → tail_synced → ingress_fenced → new_owner_active → old_owner_standby → committed` — with one entry point, per-handoff state, verify-before-finalize, bounded retry, terminal events (`handed-off` / `failover-complete` / `failed`), and a **race guard** so the zombie reaper / scheduler do not act mid-handoff. **The outgoing machine retains the lease (and its fencing epoch) through the entire `ingress_fenced → new_owner_active` window**; the incoming machine attempts its lease-CAS acquisition **only after receiving an explicit `yield` signal from the outgoing machine**, which is sent *only* on a verified ack (§8 G3d) AND a passing Tier-1 validation. A validator timeout or ack-verification failure means **no `yield` signal is sent** — so the incoming machine never initiates its CAS, the outgoing machine simply stays awake, and there is no window in which both attempt to hold the same epoch. (This closes the planned-handoff yield race; a hard failover, by contrast, has no outgoing machine to send `yield`, so the incoming acquires via the lease-TTL-expiry path in §6.) Every worker (channel send, scheduler) acts from the current epoch and rejects stale epochs. This replaces the v0 design that scattered handoff steps across `HeartbeatManager`, `MultiMachineCoordinator`, `SyncOrchestrator`, and `HandoffManager` with no owner. `HandoffManager` is *extended* (new `flushToIncoming` / `awaitVerifiedAck` methods) — its current behavior covers only WIP-commit + note-file (steps equivalent to prepare + a coarse commit), not the live two-machine protocol.
- A `minHandoffIntervalMs` prevents oscillation from hammering the CONTINUATION machinery (each resume is an LLM call).
- **Supervision.** Tier 1 — handoff errors are user-visible; a Haiku-class validator confirms the receiving machine's ack/echo before the lease yields. **Latency budget (lesson B24):** the validator's own timeout is sized well inside `handoffAckTimeoutMs`, and a validator timeout is treated as **"ack not verified" → abort the graceful handoff (outgoing machine stays awake)** — never as an implicit pass. The lease is never yielded on an unconfirmed validation.

**(f) CONTINUATION resume.** On the receiving side, the agent session resumes via the existing **CONTINUATION** mechanism — it picks up the conversation rather than re-greeting (criterion 3), and surfaces machine-provenance honestly when context is as-of-last-sync.

**Failover (outgoing died):** no flush is possible; the incoming machine acquires the lease (CAS over whatever shared medium survives), resumes from the last *persisted* live tail (freshness = RPO bound) + thread history + the durable ingress position, and the message ledger guarantees no double-action on any in-flight event. The user may see at most an RTO-bounded catch-up beat and at most RPO-bounded missing context — never a lost or duplicated message.

---

## Tunability

Per Justin's explicit requirement. All under `.instar/config.json` → `multiMachine`. **Knobs are renamed to avoid collision** with the existing `MachineHeartbeat` (`DEFAULT_HEARTBEAT_INTERVAL_MS` = 30 min) and Threadline `ConnectionManager` (60s) — both also use `heartbeatIntervalMs`, so the seamlessness knobs carry distinct names.

| Knob | Default | Meaning |
|------|---------|---------|
| `ingressHeartbeatMs` | 30s | How often the lease holder refreshes its liveness/lease (distinct from the 30-min machine-presence heartbeat) |
| `registrySyncDebounceMs` | 10s | Debounce window for committing *durable* registry changes to git |
| `standbyPullIntervalMs` | `min(failoverThresholdMs/4, leaseTtlMs/2)` (auto) | Standby git-pull cadence; auto-derived to satisfy **both** the `< failoverThresholdMs/3` and `< leaseTtlMs` invariants at once (at default ratios `leaseTtlMs` is the binding bound, so a bare `failoverThresholdMs/4` would violate the leaseTtl invariant — implementation verified). Explicit overrides are validated against both bounds |
| `failoverThresholdMs` | (existing, ~15min) | How stale before a peer is presumed dead; must exceed worst-case NTP drift ×2 |
| `leaseTtlMs` | 2 × `ingressHeartbeatMs` | Lease expiry; bounds the worst-case transfer overlap window |
| `liveTailTransport` | `tunnel` | `tunnel` (low-latency) \| `git` (durable-only, cheaper; recommended default for N>3) |
| `liveTailMaxStalenessMs` | 5s | RPO: max staleness of the standby's persisted live tail |
| `liveTailPushRateMs` | = `liveTailMaxStalenessMs` | How often the holder pushes a tail flush; **invariant: ≤ `liveTailMaxStalenessMs`** (validated on startup) so the RPO bound is actually achievable |
| `liveTailOutOfOrderTimeoutMs` | = `leaseTtlMs` | How long the standby holds an out-of-order flush before declaring the gap unfillable |
| `liveTailMaxBytesPerTopic` | 256KB | Memory/bandwidth cap; drop-oldest on overflow |
| `handoffAckTimeoutMs` | 5s | Max wait for a verified "caught up" ack before aborting graceful handoff |
| `minHandoffIntervalMs` | 60s | Anti-oscillation floor (protects CONTINUATION LLM cost) |
| `splitBrainEscalationCooldownMs` | 5min | After this, stop re-escalating an unresolved partition until the user acts |
| `handoffBar` | `near-instant` | `near-instant` (continuous tail buffer) \| `relaxed` (catch-up pull at handoff) |

Defaults target a good experience for 2-machine personal use; high-machine-count or cost-sensitive deployments dial cadence down and/or switch `liveTailTransport: git`. **Startup validation enforces the cross-knob invariants** — `standbyPullIntervalMs < failoverThresholdMs / 3`, `standbyPullIntervalMs < leaseTtlMs` (so a standby always refreshes its git-committed epoch view at least once per lease lifetime — otherwise a short `ingressHeartbeatMs` could leave it deciding `max(tunnel,git)` on a stale git floor), and `liveTailPushRateMs ≤ liveTailMaxStalenessMs` — so a user widening `ingressHeartbeatMs` (which widens `leaseTtlMs`) cannot silently invalidate the RPO bound promised in §3; a violating config is rejected with a clear message rather than degrading quietly.

---

## Testing Strategy

Per the Testing Integrity Standard — all three tiers, plus wiring-integrity, fault-injection, channel-experience acceptance, and the real-hardware gate.

- **Tier 1 (unit).** Lease CAS: two contenders, exactly one epoch advance wins; stale-epoch action rejected (fencing); `max(tunnel,git)` epoch never regresses below git-committed; epoch-gap accepted; livelock backoff lands one winner; expired lease frees acquisition; clock-skew machine cannot win; tunnel-unreachable-past-`leaseTtlMs` holder self-suspends ingress. Message-ledger: redelivered `dedupeKey` is a no-op; cursor advances only on `cursor_advanced`; transition flushed to SQLite synchronously (durable across same-machine crash-restart); `processing` past `maxProcessingMs` is re-runnable by the new holder. Live-tail: out-of-order/duplicate flush is coalesced/dropped (no doubled context). Sync debounce; live-tail staleness/byte-cap; escalation dedup by `partitionEpisodeId`.
- **Tier 2 (integration).** Full HTTP pipeline: `roleChange`/lease-epoch change marks the registry dirty and triggers an auto-push (**the exact Phase 0 failure — this test gates it**); standby pulls and converges; stale-sequence commit on pull is discarded.
- **Tier 3 (e2e lifecycle).** Multi-process: two servers, real local git remote, real localhost tunnels; planned handoff with an in-flight conversation asserts the incoming machine holds the verified tail before the lease yields; hard failover asserts a single lease holder within threshold and the message ledger prevents double-action.
- **Wiring-integrity tests (required, per the "feature actually alive" lesson).** Assert: `MultiMachineCoordinator` has a live `roleChange` subscriber that calls into `SyncOrchestrator`; the `HandoffSentinel` is constructed and wired in `AgentServer` startup (not dead code); the live-tail transport component is started.
- **Fault-injection (the adversarial/external block).** Inject crashes at every boundary: after channel ack before cursor sync, after cursor sync before reply, mid outbound send, during a non-fast-forward git push, under injected clock skew, with delayed/dropped tunnel packets, and with duplicate provider deliveries. Assert exactly-once *effect* and single-lease-holder in every case.
- **Security-negative (the security block).** Forged/stale-epoch lease write rejected; unsigned/replayed/low-`leaseEpoch` registry commit rejected on pull; unknown-key first commit asserting `awake` rejected (only `standby`+`rejoined` accepted); live-tail rejected from a peer whose identity can't be verified; a false "caught up" ack whose echo-hash mismatches does not cause yield; secrets in the tail are redacted.
- **"Feature is alive" E2E (the most important test).** An automated Tier-3 test asserts the server exposes `/health.multiMachine.syncStatus` and returns valid fields (not null, not 503) on a single-machine install — the standard Phase-1 alive check, distinct from the manual real-hardware gate.
- **Channel-experience acceptance (the real bar).** Drive a real conversation across a handoff/failover and assert from the channel: exactly-once handling (no loss, no duplicate reply), context retained in the first post-handoff reply (no re-greeting), perceived pause within RTO. Runs against **Telegram (reference) AND Slack** to prove the contract is channel-agnostic — a new adapter is "seamless-ready" only when it passes this suite.
- **Real-hardware gate.** `docs/MULTI_MACHINE_VERIFICATION.md` (60 items) remains the live acceptance gate. **It is a merge prerequisite for the launch increment** (not a post-merge afterthought); G1/G2/G3 each map to specific checklist sections (§2 Heartbeat/Failover, §3 Git Sync, §6 Handoff, §7 Communication, §10 Full Lifecycle). The new `/health.multiMachine.syncStatus` fields (below) give the checklist concrete endpoints to probe.

---

## Migration Parity & Agent Awareness

Existing multi-machine agents must receive this on update, not just new ones:

- **Config defaults** → `migrateConfig()` (sync path, applies before first server boot) adds the renamed `multiMachine` knobs, existence-checked per individual key, under a named marker `_instar_migrations: "seamlessness-v1-config-defaults"` for idempotency. The rename means no collision with any pre-existing `heartbeatIntervalMs`.
- **Mesh protocol version gate (partial-migration safety).** The mesh carries a `protocolVersion`. A machine that does not support fenced leases + ingress dedup + handoff epochs is **ineligible for the awake lease** during a seamless handoff — an old-version machine cannot be handed authority, preventing a half-migrated mesh from running two coordination semantics at once.
- **Resolver + auto-sync + HandoffSentinel + live-tail transport** ship in the server; existing agents get them on the next server update. The wiring (G2) is server-internal — covered by the wiring-integrity tests so it cannot regress to dead code.
- **New durable stores self-initialize.** The SQLite-backed message-processing ledger and outbox create their schema on first access (the `PendingRelayStore` pattern) — no `PostUpdateMigrator` schema step is required, and an existing agent's first post-update server boot initializes them transparently. This is the explicit contract (not an assumption), so the stores are never "missing" on an upgraded agent.
- **CLAUDE.md template (Agent Awareness Standard).** `generateClaudeMd()` gains a short multi-machine-seamlessness section (machine-aware honest-disclosure behavior; the `/capabilities` pointer for mesh/sync status; how to read a split-brain Attention escalation); `migrateClaudeMd()` adds it to existing agents with a content-sniffing guard. The honest-disclosure behavior itself is delivered via CONTINUATION injection at session-start, **not** a permanent prompt section (avoids L1 context bloat).
- **Observability.** `/health` gains `multiMachine.syncStatus`: `{ leaseHolder, leaseEpoch, lastPushAt, lastPullAt, liveTailStalenessMs, splitBrainState }`; `instar doctor` surfaces the same. This is what the agent reads before claiming mesh state, and what the real-hardware checklist probes.
- **Idempotent.** Resolver, sync, and migrations are safe to run repeatedly; a single-machine agent (no peers, holds its own lease trivially) is a no-op.

---

## Related Work & Open Questions

- **Companion spec — Agent Self-Propagation Standard.** Justin's standard (one human authorization to grant an agent access to a new machine, then the agent installs itself and everything downstream). The Phase 0 onboarding findings feed it directly: the two-bootstrap access problem (SSH + git credential), `join` not creating a runnable `config.json`, and the default-port (4040) collision risk with an existing agent. **A joining machine must pick a free port and write a runnable config** — tracked there, not here.
- **Server bring-up on a guarded/new machine.** `instar server start` is (correctly) blocked from inside an agent session. The self-propagation flow must define how an agent brings up its *own* server on a new machine without that guard — likely launchd/supervisor registration performed in the onboarding step. Open question for the companion spec.
- **Closed by v1 (were open in v0):** clock-skew in elections (now epoch-fenced, not wall-clock); live-tail privacy (now normative §8 G3c). Retained as **explicit, principal-approvable deferrals only if** the launch increment scopes Slack to best-effort `lastTs` before the full Events-API dedup path — flagged for sign-off, not silently dropped. <!-- tracked: ACT-156 -->
- **Open: lease medium under total partition.** When neither tunnel nor git is reachable between machines but both can reach the user channel, no shared medium can advance the epoch — the design correctly degrades to "each fences on its own last-known lease and self-suspends ingress if it can't refresh," but the *product* choice of which side keeps serving in a true split is the user-escalation path; whether a third arbiter (e.g. the channel itself as a tiebreak token) is worth adding is an open question.
