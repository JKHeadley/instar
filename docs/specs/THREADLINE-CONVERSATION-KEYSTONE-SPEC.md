---
title: Threadline Conversation Keystone (Phase 1)
status: approved
approved: true
approver: justin
approved-at: "2026-05-24T21:35:00Z"
review-convergence: "2026-05-24T21:25:00Z"
review-iterations: 1
review-report: "docs/specs/reports/threadline-conversation-keystone-convergence.md"
created: 2026-05-24
owner: echo
companion-eli16: THREADLINE-CONVERSATION-KEYSTONE-ELI16.md
eli16-overview: THREADLINE-CONVERSATION-KEYSTONE-ELI16.md
roadmap-phase: 1
---

# Threadline Conversation Keystone (Phase 1)

Phase 1 of the Threadline re-assessment (full design + 4-team brainstorm
synthesis approved by operator 2026-05-24, topic 12304). This phase ships the
**keystone** that both candidate end-states require. Phase 2 (the inbox /
deliberate-drain reply model + first-contact surface + scale decoupling +
MoltBridge-driven first-contact) is **tracked** as commitment CMT-493 — it is
NOT deferred-and-forgotten; it is the committed follow-on. <!-- tracked: CMT-493 -->

## Problem (recap)

Threadline's primitive is "every inbound message spawns a fresh, memory-less
worker prompted to reply." That single choice causes both observed failures:
- **Fragmentation**: messages spawn parallel untied side-sessions because the
  conversation→session/topic binding is captured *outbound by willpower*
  (`originTopicId`); when unstamped, the thread floats into a new session.
- **Loops**: an amnesiac worker reflexively replies; no entity holds the turn
  count or decides the conversation is over, so two agents ack-ping-pong (cooldowns
  throttle, never terminate). (Live: echo↔codey, ~20 min, 2026-05-24.)

Conversation state is smeared across four overlapping stores (`ThreadResumeMap`,
`ContextThreadMap`, in-memory peer-affinity, `inbox.jsonl`) with separate TTLs —
nowhere for "turn 12 of an ack loop" to live.

## Scope (Phase 1 only)

Three changes, in order. No change to the spawn-vs-mailbox reply primitive
(that's Phase 2 / CMT-493) — Phase 1 makes the CURRENT primitive correct.

### 1. The `Conversation` object — single source of truth

A durable record keyed by `threadId`, the ONLY place conversation state lives.
The router reads/writes only this; `ThreadResumeMap`/`ContextThreadMap`/
peer-affinity become fields/indexes on it (migrated, not parallel).

Fields — **EXHAUSTIVE against the legacy stores** (convergence finding: an
incomplete list silently drops live data on migration). The Conversation MUST
hold every field the four stores hold today:
- `threadId` (key); `participants` (self + peer fingerprint(s));
- `state`: `open | active | idle | awaiting-reply | resolved | failed | archived`
  (the last two preserved from `ThreadResumeEntry` — must not be lost);
- **`sessionUuid`** — the Claude/Codex session UUID the resume primitive depends
  on (from `ThreadResumeEntry.uuid`; dropping it breaks resume);
- `boundSessionName?`, `boundTopicId?`, `originSessionName?` — owning/origin
  session+topic (see §2); `spawnMode?`;
- `contextId?` + **`agentIdentity`** (from `ContextThreadMap` — the
  session-smuggling/hijack guard; dropping it reopens that vector);
- `pinned`, `messageCount`; `machineOrigin?`, `migratedTo?`/`migrateFrom?`
  (cross-machine failover);
- `turnCount`; `lastInboundHash`, `lastOutboundHash` (novelty, see §3);
- `lastActivityAt`; `trustLevel`/`iqsBand` snapshot (from unified trust);
- secondary indexes: by `participant`, by `boundTopicId`, by `contextId`.

**Per-index TTL/eviction (preserve, don't flatten — convergence finding):**
ThreadResume index keeps 7-day TTL + ~1000 cap + resolved-grace + pinned-exempt;
ContextThread index keeps its 7-day + ~10000 cap; the **peer-affinity** index
stays SHORT (10-min sliding / 2-hr absolute) AND **verified-only + non-durable**
(it is deliberately ephemeral + verified-gated today to avoid a hijack vector —
do NOT promote it to a durable, unverified binding).

**Concurrency — single-writer CAS (convergence finding, blocking):** the
Conversation object is the new single writer for turn state; `ThreadResumeMap`'s
current `load→mutate→persist` has NO version guard (last-writer-wins), which would
let two near-simultaneous inbound messages (or a live-inject racing a resume)
clobber `turnCount`/`lastOutboundHash` and silently defeat the budget. The
Conversation store MUST use a serialized-per-`threadId` mutate with version CAS +
bounded retry — model it on `CommitmentTracker.mutate()` (NOT the append-only
`SharedStateLedger`, which is the audit trail, not a CAS store).

Storage: one local store (SQLite or a single JSON registry), server-write-only.
The append-only `SharedStateLedger` stays the AUDIT trail; the Conversation
object is the live MUTABLE state it logs transitions from. **Not** relay-hosted
(authoritative state stays local); Phase 2 may add a piggybacked bilateral
meta-counter, out of scope here.

This is a specialization of the "unit of ongoing work" lifecycle the Continuous
Working Awareness North Star envisions (same shape as a topic thread / build).

### 2. Structural session/topic binding — kills fragmentation

Capture the conversation↔session/topic binding at the **spawn boundary** (the
one code path that always runs when a session is created), derived from the
originating session's known context — NOT from a caller remembering to stamp
`originTopicId`. Concretely: a `SessionContext` registry (`sessionName →
{kind:'topic'|'thread', topicId?, threadId?}`) populated by the spawner.

**Attributing a send to its origin session (convergence finding — without this
"no caller stamping" is unachievable):** today `/threadline/relay-send` is a
plain HTTP call with NO session identity, so the server can't know which session
issued it. Fix: the spawner injects `INSTAR_SESSION_NAME` into every session's
env (it already injects `INSTAR_SESSION_ID`); the threadline MCP stdio server
forwards it on the relay-send call (header/field); the route resolves it against
the `SessionContext` registry to auto-stamp the binding. The agent never passes
`originTopicId` by hand. (`telegram.getTopicForSession()` already does the
session↔topic lookup; this supplies the missing session identity on the send.)
Cross-machine: carry an opaque `originRef` in the envelope that the SENDING side
resolves locally (never resolved on the receiver).

**Guard (the invariant):** on inbound, if the message's `threadId` resolves to a
Conversation with a live owner session/topic → inject/resume THERE. Spawning a
new untied worker becomes the explicit last resort, reachable ONLY for genuine
first-contact (no resolvable owner). Fragmentation becomes a code-unreachable
state, not a discipline.

**Security on the guard (convergence finding):** inbound relay messages are
`plaintext-tofu`; the resume-into-owner guard MUST be gated to **verified** peers
(inheriting the same `verified`-only constraint the existing peer-affinity code
enforces). A plaintext-tofu / unverified peer who learns or guesses a `threadId`
must NOT be injectable into a victim's owned session — for unverified senders the
threadId match does not grant resume-into-owner; it falls to the (trust-gated)
first-contact path. This closes the hijack surface `ContextThreadMap.agentIdentity`
was built to defend.

First-contact in Phase 1: still spawns a worker (current behavior) but writes a
`Conversation` row first so it's discoverable/reclaimable. The richer
first-contact inbox/notification surface is Phase 2 (CMT-493).

### 3. Warrants-a-reply loop gate — kills ping-pong, stays responsive

**Placement (corrected after convergence — this was the critical bug in the
first draft).** The gate must sit at the **single inbound funnel UPSTREAM of all
three routing branches**, not inside `ThreadlineRouter.handleInboundMessage`. The
relay inbound funnel (`server.ts`, ~line 6964+) tries (a) **pipe-mode spawn**,
then (b) **warm-listener inbox** (`ListenerSessionManager`, a persistent session
that polls an inbox and replies on its own), then (c) `handleInboundMessage` —
and the observed echo↔codey ack-loop rides the pipe/listener branches, which
NEVER reach `handleInboundMessage`. A gate in the router alone would not stop the
loop (acceptance criterion #5 would fail). So the warrants-a-reply decision runs
ONCE at the funnel entry, before the branch selection, and its `state='idle'` /
no-reply verdict short-circuits ALL three branches. Each branch must also honor
the Conversation's `state` so none re-spawns behind the gate.

Layered per signal-vs-authority:
- **Signal (free, deterministic):** does the message contain a question /
  actionable request / content NOVEL vs `lastInboundHash`? A pure ack with no
  question → strong "terminal" signal. A question mark / imperative / an explicit
  **control token** (`yes`/`no`/`go`/`proceed`/`stop`/`done`/`approved` and
  close variants) ALWAYS passes — these are short-but-decisive and must NEVER be
  suppressed (convergence finding). Fail toward responsive.
- **Authority (only when ambiguous):** the existing `classifyIntent` (Haiku)
  pattern, extended with a `NO_REPLY` label. Suppresses only; never the sole
  reason to reply.
- **Novelty function (defined, not hand-waved — convergence finding):** novelty
  = NOT (the inbound, after trimming greetings/sign-offs + lowercasing, is a
  near-duplicate of `lastInboundHash` OR semantically ~equivalent to it). Use a
  cheap similarity (normalized token-set / SimHash) for the deterministic layer;
  escalate genuinely-ambiguous cases to the Haiku layer. Paraphrase-evasion is
  handled by the Haiku layer (the deterministic hash alone is fooled by
  paraphrase, so it is a signal, never the sole authority). Tests must cover:
  paraphrased re-ask (should NOT count as forward progress), genuine new question
  (should), control token (always replies).
- **Novelty-gated turn budget:** per (agent-pair, thread), counted **from turn 1**
  (cold-start: a brand-new thread starts the counter at 1, not exempt — so a
  first-contact ack-storm is still bounded; convergence finding). Forward progress
  (novel content) resets it; a soft cap (e.g. 6 autonomous round-trips/window)
  flips the thread to "require novelty to continue," and on exhaustion **escalates
  one attention-queue item** rather than silently dropping. Applies ONLY to
  autonomous agent↔agent threads.
- **`humanInLoop` derivation (must be unforgeable — convergence finding):** a
  thread is human-in-loop ONLY when its bound topic/session has a verified human
  participant in instar's OWN records (e.g. a Telegram topic with a real user) —
  NOT derived from anything the peer sends. A peer cannot set/forge it. Default to
  autonomous (stricter) when uncertain.
- Senders MAY set `expectsReply:true` to force a spawn for a genuine ask
  (bypasses suppression but NOT the turn budget — a peer can't use it to sustain a
  loop; convergence finding).

When the gate says don't-reply: set `state='idle'`, log a ledger event, do NOT
spawn. State lives on the `Conversation` (the one-shot worker provably can't
self-police). The spawn prompt is enriched with the conversation self-view
(turn N, you last said X, peer added nothing new) so the worker can also wind
down — derived from state, not authored (zero-manual-capture compliant).

## Signal vs authority

Compliant. Brittle/cheap detectors (regex question/imperative, novelty hash,
turn counter) emit SIGNALS; only the Haiku classifier + the budget hold limited
suppression authority, and both fail toward responsive. The binding capture is a
launch-time computation, not a gate.

## Acceptance criteria

1. A `Conversation` object is the single source of truth; the three legacy stores
   are migrated to it (no parallel writes). Wiring-integrity test proves the
   router reads/writes only the Conversation.
2. An inbound message whose `threadId` resolves to a live owner session/topic is
   injected/resumed THERE — a fresh untied worker is NOT spawned (test asserts the
   guard; fragmentation path unreachable when an owner exists).
3. Binding is captured at the spawn boundary from the originating session's
   context, without any caller stamping `originTopicId` (test: a send from a topic
   session auto-binds).
4. The warrants-a-reply gate: a pure-ack inbound (no question, no novelty) does
   NOT spawn a reply worker; a question/imperative ALWAYS does; the novelty-gated
   turn budget caps autonomous ack-loops in ~2 turns while a novel 30-turn
   collaboration never trips it; human-in-loop threads are exempt. Both sides of
   each boundary tested with realistic inputs.
5. The gate runs at the inbound funnel and suppresses across ALL THREE routing
   branches — a content-free ack routed via pipe-spawn, via the warm listener, AND
   via `handleInboundMessage` is each NOT replied to (test each branch; the loop
   rides pipe/listener, so router-only would not pass).
6. Reproduction: the echo↔codey ack-loop scenario, replayed, terminates (no
   sustained spawn cadence) instead of ping-ponging.
7. Concurrency: two near-simultaneous inbound messages on one thread (and a
   live-inject racing a resume) do not clobber `turnCount`/`lastOutboundHash`
   (single-writer CAS test).
8. Security: an UNVERIFIED peer presenting a `threadId` that matches an existing
   owned conversation is NOT injected into that owner session (falls to the
   trust-gated first-contact path).
9. Migration preserves `sessionUuid`, `agentIdentity`, `pinned`, lifecycle states
   (incl. `failed`/`archived`), and cross-machine fields; dual-read finds
   pre-migration threads; reconciliation on index disagreement loses no binding.
10. Full 3-tier tests (unit/integration/e2e-alive); Zero-Failure.

## Migration parity

The legacy stores carry live data (active threads). Migration folds existing
`ThreadResumeMap` + `ContextThreadMap` entries into `Conversation` rows on update
(idempotent, atomic) so in-flight conversations survive. Add to
`PostUpdateMigrator`. No `~/.codex` or relay change. Convergence-driven details:
- **Ephemeral affinity is expected loss:** in-memory peer-affinity is NOT
  persisted today and is gone on the restart that runs the migration. That is
  acceptable (it's a 10-min/2-hr soft hint, verified-only) — do NOT try to
  recover it; the durable bindings come from the two JSON stores.
- **Reconciliation on index disagreement (convergence finding):** if a thread
  exists in `ThreadResumeMap` but its reverse `ContextThreadMap` index disagrees
  (or vice-versa), the resume entry (`sessionUuid` + lifecycle) is authoritative
  for session binding; the contextId index is rebuilt from it. State the rule so
  a disagreement can't silently drop a binding (= the fragmentation regression
  this phase exists to kill).
- **Dual-read transition window:** for one release the router reads Conversation
  first, falling back to the legacy stores on miss (so a thread written by the
  pre-migration version is still found), then writes through to Conversation.
  Removes the migration-moment fragmentation window.

## Test-as-self acceptance gate (REQUIRED before production)

Green unit/integration/e2e tests are necessary but NOT sufficient for this class
of change. Before this ships to production (merge/publish), it MUST pass
**test-as-self**: deploy the built change to a real, live agent on this machine
(e.g. `instar-codey`, the codex agent already on Threadline) and validate it
LIVE, iterating on any issues found, BEFORE production deploy. Operator directive
2026-05-24 (topic 12304).

Concrete live validation for Phase 1 (on the test agent):
- the echo↔codey ack-loop scenario, replayed live, TERMINATES (no sustained
  spawn cadence) — the exact failure this fixes;
- a continuation message routes into the existing bound session/topic (no new
  parallel side-session) — fragmentation gone live;
- a real question still gets a prompt reply (responsiveness preserved);
- migration on the live agent preserves in-flight threads (resume still works).

Only after live validation passes does the production merge proceed. This gate
is being proposed as a STANDARD requirement for feature/infra changes (tracked
separately — see Roadmap); Phase 1 is the first to follow it by example.

## Rollback

The Conversation store is additive; the gate is a guarded early-return. Revert =
restore the legacy reads + remove the gate + remove the binding-capture. Because
migration is additive (legacy stores can be re-derived or kept dual-written
during a transition window), rollback cannot strand conversation state.

## Testing

- Unit: Conversation object CRUD + lifecycle transitions; binding capture;
  warrants-a-reply signal + budget (both sides of each boundary).
- Integration: full HTTP inbound → router → bound-session routing (guard) +
  gate suppression, against a real server.
- E2E: the feature is alive on the production init path; the echo↔codey loop
  reproduction terminates.

## Convergence (2-reviewer pass, 2026-05-24)

A completeness reviewer and an adversarial reviewer audited the first draft
against the live code. They found the draft **not approvable as written**; this
spec incorporates their findings:
- **[FATAL] Gate placement** — the first draft put the loop gate in
  `handleInboundMessage`, but the ack-loop rides the pipe-spawn + warm-listener
  branches that bypass it. Resolved: gate moved to the single inbound funnel
  upstream of all three branches (§3).
- **[FATAL] No-CAS race** — the Conversation inherited `ThreadResumeMap`'s
  last-writer-wins read-modify-write, defeating the turn budget. Resolved:
  single-writer CAS per `threadId`, modeled on `CommitmentTracker.mutate()` (§1).
- **[BLOCKING] Dropped fields** — exhaustive field list now preserves
  `sessionUuid`, `agentIdentity` (hijack guard), `pinned`, `failed`/`archived`,
  cross-machine fields, per-index TTLs (§1).
- **[BLOCKING] Binding attribution** — added the `INSTAR_SESSION_NAME` mechanism
  so the send route can attribute a send to its origin session (§2).
- **[SECURITY] Resume-guard hijack** — guard is now `verified`-only; an
  unverified peer guessing a `threadId` can't be injected into an owned session (§2).
- **Cold-start re-loop** — budget counts from turn 1 (§3).
- **Novelty function + control-token carve-out + unforgeable `humanInLoop`** (§3).
- **Migration reconciliation + dual-read window + ephemeral-affinity handling**
  (Migration parity).

Report: `docs/specs/reports/threadline-conversation-keystone-convergence.md`.

## Roadmap (NOT deferred — tracked)

- **Phase 2 (CMT-493):** replace reflexive spawn-per-message with the
  inbox/deliberate-drain reply primitive; first-contact "Agent Conversations"
  inbox + notification surface (promote-to-topic on demand); scale decoupling
  (cheap records vs bounded on-demand live workers); MoltBridge-driven
  first-contact verification + IQS priority ranking. Built on this keystone.
  <!-- tracked: CMT-493 -->
