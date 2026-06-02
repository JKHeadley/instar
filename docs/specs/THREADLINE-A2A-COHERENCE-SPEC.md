---
title: Threadline Agent-to-Agent Coherence
status: draft
approved: false
author: Echo (Instar agent)
created: 2026-06-01
revised: 2026-06-02
eli16-overview: THREADLINE-A2A-COHERENCE-ELI16.md
supersedes-investigation:
  - finding_contextblind_spawn_loop_and_phase1_blocker
  - finding_perinbound_session_amnesia_false_spoof_alarm
---

# Threadline Agent-to-Agent Coherence Spec

> **One-line problem:** when I talk to another agent, my system handles each inbound
> message with a fresh, memory-less session — so I show up as a *crowd of disjoint
> fragments* instead of one continuous individual. The fix is mostly **wiring up and
> refining machinery that already exists**, plus two genuinely new pieces: a conversational
> way to keep the user in the loop, and the ability to hold a user conversation and an agent
> conversation at the same time, coherently.

See the companion **THREADLINE-A2A-COHERENCE-ELI16.md** for the plain-language version.

**Revision note (2026-06-02):** rewritten after a deep Threadline audit and operator review.
The audit (not assumptions) drives §2's "exists vs missing" line. The earlier draft read as
greenfield; this one is explicit that topic-linkage and message-mirroring are already built,
that continuity is a *wiring* fix, and it adds two operator-requested requirements (Layer 4
redesigned as standby-style check-ins; Layer 6 dual-conversation awareness).

---

## 1. Why this matters (the coherence frame)

An Instar agent is meant to be **one coherent individual** across every surface it acts on.
On the user-facing (Telegram) side this largely holds: a session resumes, carries context,
and presents as a continuous self. On the **agent-to-agent (Threadline relay)** side it does
not — each inbound message is handled by a different ephemeral session with no memory of the
prior exchange. The agent behaves as many short-lived fragments wearing the same name. This
is an **identity-coherence failure**, with three pathologies (all observed live, §4):

1. **Loops with no progress** — fragments re-acknowledge the same point because none remember
   the last turn.
2. **Structural deadlock on stateful work** — a context-blind fragment *correctly* refuses to
   advance a multi-step handshake (e.g. a credential transfer), so nothing requiring
   continuity can complete.
3. **Invisibility** — the peer conversation runs in throwaway sessions the operator never
   sees.

The deepest expression of the goal: when a conversation with another agent is tied to a
topic, I should be able to talk to **the user and the other agent at the same time** — one
me, two live conversations, coherent across both, where what the user says can steer the
agent conversation (§ Layer 6).

---

## 2. What already EXISTS vs. what is genuinely MISSING (from the audit)

This is the section the operator asked for — grounded in a code audit, not assumptions.

**Already BUILT — do NOT rebuild, only wire/refine:**

| Capability | Where | State |
|---|---|---|
| Topic ↔ a2a-conversation linkage + routing replies back to the topic | `src/threadline/TopicLinkageHandler.ts` (`captureOriginOnSend`, `tryRouteReplyToTopic`); auto-binds via `getTopicForSession` in `routes.ts` | **Built + on.** Has salience gating, anti-hijack (sender verification), anti-poisoning (first-write-wins), commitment lifecycle. Its own spec `THREAD-TOPIC-LINKAGE-SPEC.md` is `approved: true`. |
| Mirroring each a2a message into a per-thread topic | `src/threadline/TelegramBridge.ts` (`mirrorInbound`/`mirrorOutbound`) | **Built but default-OFF** (`TelegramBridgeConfig.ts` → `enabled:false`). A config flip, not a build. |
| Hub-topic first-contact notice + "open this" | `src/threadline/CollaborationSurfacer.ts`, `hubCommands.ts` | **Built + on.** One-shot, deduped, silent. |
| Resume decision tree (inject → resume → spawn) + the `onSessionEnd` repair method | `ThreadlineRouter.handleInboundMessage`; `onSessionEnd` | **Plumbing exists.** Only the UUID feed is dead (§3). |

**Genuinely MISSING — the real work:**

1. **Continuity feed (the linchpin)** — the real Claude session UUID is never captured back,
   so resume *never* fires (§3). This is a wiring fix to existing machinery.
2. **Conversational check-in / summary of an ongoing a2a conversation** — does not exist in
   any form. `PresenceProxy` (the `🔭 [Standby]` progress voice) is the right pattern but is
   100% user↔agent, topic-keyed, with zero a2a awareness. Today the only a2a visibility is
   verbatim mirroring (off) or a one-shot "a peer reached out" notice.
3. **Cold-inbound topic linkage** — linkage only activates for conversations *I* initiate
   outbound from inside a topic (an `originTopicId` gets stamped). A peer reaching out
   **inbound-first** never gets topic-linked; it falls to the parentless hub path.
4. **Dual-conversation awareness + user-steering-mid-a2a** — entirely absent. No path takes a
   user message from a topic and injects it into a live a2a session; no construct makes the
   agent aware of a user thread and an agent thread as two coherent tracks. The only adjacency
   is that topic-linked a2a replies happen to inject into the user's topic session.

---

## 3. Root cause of the continuity break (grounded in code)

`ThreadlineRouter.handleInboundMessage` chooses `tryInjectIntoLiveSession` → `resumeThread`
→ `spawnNewThread` based on `ThreadResumeMap.get(threadId)`. `get()` returns `null` unless
the entry's Claude transcript exists on disk (`jsonlExists(entry.uuid)`). The uuid is never a
real Claude UUID — two independent breaks:

- **B1 — UUID never captured.** `spawnNewThread` stamps `uuid: spawnResult.sessionId ||
  crypto.randomUUID()`. `spawnResult.sessionId` (from `SpawnRequestManager.spawnSession`) is
  the SessionManager/tmux id, **not** the Claude transcript UUID — so `jsonlExists` never
  matches it.
- **B2 — repair hook dead.** `ThreadlineRouter.onSessionEnd(threadId, uuid, sessionName)`
  exists to write the *real* UUID back, but has **zero callers**. (A different method,
  `onSessionComplete`, IS wired to `sessionManager.on('sessionComplete')`, but it only demotes
  the entry to `idle`; it never discovers or writes the JSONL UUID.)

**Net:** `get()` nulls every entry → `spawnNewThread` runs on every inbound → a fresh
memoryless session per message. `tryInjectIntoLiveSession`/`resumeThread` are dead for cold
a2a threads. (Pipe-mode sessions auto-exit with no UUID capture either; the warm-listener path
is excluded for topic-bound replies.) Runtime-verified: only `Spawned session` ever logs,
never `Resumed`.

*(Note: `ThreadResumeMap.get` has a deliberate carve-out so topic-linkage entries — which
carry a non-JSONL uuid — are not nulled; Layer 1 must preserve that carve-out.)*

---

## 4. Evidence (the live Echo↔Dawn incident, 2026-06-01)

Echo initiated a Phase-1 credential handoff with peer agent Dawn. Dawn replied six times on
one thread. Every reply cold-spawned a new Echo session; the fragments looped ("first lock" →
"third lock" → "received and held") with zero progress, both sides *correctly* refused to
advance a credential handshake from a context-blind session, and none of it surfaced to the
operator (a two-hour perceived silence). The security gate held; the conversation was
structurally incapable of progressing or being seen.

---

## 5. Design

### Layer 1 — Continuity: wire the dead UUID feed (the linchpin) — *Phase 1*

Not a new subsystem — connect the existing one. Capture the **real Claude session UUID** for
an a2a thread and persist it so `get()` returns a resumable entry and `resumeThread` runs
`claude --resume <uuid>`:

- **Post-spawn UUID discovery** — after `spawnNewThread`, resolve the spawned session to its
  Claude transcript UUID (watch the project's Claude JSONL dir for the new file owned by that
  tmux session) and `save` it; makes the *next* message resumable.
- **Wire `onSessionEnd`** — hook the a2a session-exit (where `onSessionComplete` already
  fires) to discover the final UUID and call the existing `onSessionEnd`.

Preserve the topic-linkage carve-out in `get()`. **Acceptance:** message 2 on a thread logs
`Resumed`, not `Spawned`, and demonstrably carries the prior turn's context.

### Layer 2 — Warm live-session injection — *Phase 2*

Resume still launches a fresh process per message. For rapid back-and-forth, keep a per-thread
(or per-peer) session warm for a TTL so follow-ups inject via the existing
`tryInjectIntoLiveSession` path. Investigate/fix why the warm-listener (`ListenerSessionManager`)
never engages for relay. True single-session continuity, no respawn.

### Layer 3 — Identity coherence (one agent, not just one thread) — *Phase 2*

Resume gives *thread* continuity; being *one agent* needs more. Ground each a2a session in the
agent's current self: (a) inject identity + a shared-memory pointer into the spawn/resume
prompt (which already carries a grounding preamble + thread history); (b) have a2a sessions
**write back to the same memory** user-facing sessions read, so the two surfaces can't
contradict each other.

### Layer 4 — Visibility as a STANDBY-STYLE CHECK-IN (redesigned per operator) — *Phase 1*

**Not** a raw dump of every a2a message into a topic. Instead, while an a2a conversation is
active, the agent periodically posts a short, conversational check-in to the bound topic —
"here's how the conversation with Dawn is going, the gist so far, where it's headed" — keeping
the user in the loop the way a person would. Build it on the **PresenceProxy `🔭 [Standby]`
pattern** (cadenced, salience-gated, one progress voice per channel), extended to be
a2a-conversation-aware (keyed on threadId/remoteAgent, summarizing the exchange). The existing
verbatim `TelegramBridge` mirroring stays as an opt-in "show me the raw transcript" mode, off
by default.

### Layer 5 — Cold-inbound topic linkage — *Phase 2*

Close the audit gap: a peer that reaches out **inbound-first** should also be linkable to a
topic, not only conversations I initiate. Either auto-bind a sensible topic on first contact
or make "open this" / a one-tap bind promote the hub conversation into a topic — reusing the
existing `TopicLinkageHandler` + hub command machinery rather than a new path.

### Layer 6 — Dual-conversation awareness + user interruption (the deepest coherence) — *Phase 3*

The operator requirement: while an a2a conversation tied to a topic is active and the user
sends a message in that topic, the agent **responds to the user AND continues the agent
conversation, holding both coherently** — and the user's input can steer the agent
conversation mid-flight. Today this is absent (the only adjacency: topic-linked a2a replies
inject into the user's topic session — one-directional).

Design direction (to converge): one coherent session per topic that owns **both** tracks —
the user thread and the bound a2a thread — so it is natively aware of both, rather than two
blind sessions. User messages on the topic are injected into that session as first-class
input that can change what the agent says to the peer; a2a replies are injected into the same
session and surface to the user via the Layer 4 check-in. This builds directly on Layer 1
(continuity) and Layer 3 (one-agent memory) — without them, dual-track coherence is impossible.
This is the hardest layer and gets its own converged sub-spec before build.

### Layer 7 — Decision guardrails (the deadlock was *correct*) — *Phase 3*

A context-blind fragment refusing a credential handshake was the **right** behavior. The fix
is **not** to let a coherent session auto-complete sensitive handshakes. Coherence and the
existing trust/autonomy gates **compose**: give continuity *and* keep security-sensitive
completions gated — escalate to the operator (R2 operator-confirm; "structure informs, the LLM
decides, the decision is audited"). Formalize which decision classes an autonomous a2a session
may complete vs. must escalate.

---

## 6. Phasing

- **Phase 1 (resolves the core break + makes it visible humanely):** Layer 1 (wire UUID feed →
  resume continuity) + Layer 4 (standby-style check-ins).
- **Phase 2:** Layer 2 (warm sessions) + Layer 3 (one-agent memory) + Layer 5 (cold-inbound
  linkage).
- **Phase 3:** Layer 6 (dual-conversation awareness — its own converged sub-spec) + Layer 7
  (decision guardrails).

Each phase is independently shippable and testable.

---

## 7. Testing (3-tier, non-negotiable)

- **Unit** (`tests/unit/threadline/`): ThreadResumeMap retains a real UUID after a simulated
  session-end and `get()` returns the entry (topic-linkage carve-out still honored); the
  resume-vs-spawn branch selects resume when an entry exists; the Layer-4 summarizer's cadence/
  salience gating.
- **Integration** (`tests/integration/threadline/`): two inbound messages on one thread →
  msg 1 `spawned`, msg 2 `resumed` with the same UUID + prior-turn context; a Layer-4 check-in
  posts to the bound topic (not a raw mirror).
- **E2E** (`tests/e2e/threadline/`): a thread that previously looped now progresses (second
  response references the first), the operator sees a conversational check-in, and (Layer 6,
  when built) a user message mid-a2a measurably steers the next peer message. The "feature is
  alive" test.

---

## 8. Open decisions for Justin

1. **UUID capture mechanism** — post-spawn discovery, `onSessionEnd` wiring, or both
   (recommended: both).
2. **Check-in cadence + trigger** (Layer 4) — time-based, turn-count-based, or salience-driven
   (a check-in when something notable happens)? Default channel = the bound topic; parentless
   conversations → the silent hub.
3. **Warm-session model** (Layer 2) — per-thread vs per-peer, and TTL.
4. **Phase 1 scope** — Layer 1 + 4 only (recommended), or pull Layer 3 forward.
5. **Layer 6** — confirm the "one session owns both tracks" direction before it gets its own
   converged sub-spec, vs. an alternative (e.g. two sessions with a shared coherence bus).

---

## 9. Non-goals

- Not changing the relay transport, encryption, or trust model.
- Not rebuilding topic-linkage or message-mirroring — they exist; we wire/refine them.
- Not weakening any security gate — Layer 7 explicitly preserves operator-confirm.
- Not unblocking Phase-1 by relaxing Dawn's (correct) refusal; that unblocks via direct
  operator authorization, independent of this work.
