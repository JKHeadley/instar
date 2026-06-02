---
title: Threadline Agent-to-Agent Coherence
status: draft
approved: false
author: Echo (Instar agent)
created: 2026-06-01
supersedes-investigation:
  - finding_contextblind_spawn_loop_and_phase1_blocker
  - finding_perinbound_session_amnesia_false_spoof_alarm
---

# Threadline Agent-to-Agent Coherence Spec

> **One-line problem:** every inbound Threadline message spawns a fresh, memory-less
> Claude session, so an Instar agent talks to a peer as a *crowd of disjoint fragments*
> instead of one continuous individual — it loops, deadlocks on anything stateful, and
> does it all invisibly to the operator.

See the companion **THREADLINE-A2A-COHERENCE-ELI16.md** for the plain-language version.

---

## 1. Why this matters (the coherence frame)

An Instar agent is meant to be **one coherent individual** across every surface it acts
on. On the user-facing (Telegram) side this largely holds: a session resumes, carries
context, and presents as a continuous self.

On the **agent-to-agent (Threadline relay)** side it does not. Each inbound message from a
peer is handled by a *different ephemeral session* with no memory of the prior exchange.
The agent therefore behaves as many short-lived fragments wearing the same name. This is
not a performance or churn problem — it is an **identity-coherence failure**, and it
produces three concrete pathologies (all observed live, §3):

1. **Loops with no progress** — fragments re-acknowledge the same point repeatedly because
   none remember the last turn.
2. **Structural deadlock on stateful work** — a context-blind fragment *correctly* refuses
   to advance a multi-step handshake (e.g. a credential transfer), so anything requiring
   continuity can never complete through this path.
3. **Invisibility** — the entire peer conversation runs in throwaway sessions that never
   surface to the operator, who sees only silence.

Fixing this is prerequisite to *any* reliable agent-to-agent collaboration (including the
Phase-1 feedback-system transfer, which is currently blocked behind exactly this failure).

---

## 2. Root cause (grounded in code)

The inbound relay path (`src/commands/server.ts:6931`, `relayClient.on('gate-passed')`)
routes through, in order: waitForReply resolution → auto-ack → canonical inbox write →
Telegram-bridge mirror → **pipe-mode** → **warm-listener** → **`ThreadlineRouter`**.

`ThreadlineRouter.handleInboundMessage` (`src/threadline/ThreadlineRouter.ts:353`) chooses
between three handlers based on `threadResumeMap.get(threadId)`:

```
existingEntry = threadResumeMap.get(threadId)
if (existingEntry && messageDelivery)  → tryInjectIntoLiveSession   (PR-4 live-inject)
else if (existingEntry)                → resumeThread               (claude --resume UUID)
else                                   → spawnNewThread             (cold spawn)
```

So **continuity depends entirely on `get(threadId)` returning a usable entry.** It never
does. `ThreadResumeMap.get` (`ThreadResumeMap.ts:126`) returns `null` unless the entry's
Claude transcript exists on disk:

```js
if (!this.jsonlExists(entry.uuid)) return null;   // line 137
```

And `entry.uuid` is never a real Claude session UUID. Two independent breaks guarantee it:

- **B1 — the UUID is never captured.** `spawnNewThread` (line 666) stamps
  `uuid: spawnResult.sessionId || crypto.randomUUID()`. At spawn time the real Claude
  session UUID is not yet known (Claude assigns it after boot, in its JSONL), so this is a
  random placeholder or the tmux name — not a value `jsonlExists` will ever match.
- **B2 — the repair hook is dead.** `ThreadlineRouter.onSessionEnd(threadId, uuid, sessionName)`
  (line 488) exists precisely to write the *real* UUID back after a session ends — but it
  has **zero callers** in the entire codebase. Nothing ever tells the router "this thread's
  session finished, here is its real transcript UUID."

**Net effect:** the resume map only ever holds entries whose `uuid` has no matching JSONL.
`get()` therefore returns `null` on every subsequent message, `existingEntry` is always
falsy, and the router takes `spawnNewThread` every time. The live-inject path is doubly
dead — it requires both a non-null entry *and* a still-running session, and A2A sessions
are ephemeral (they respond and exit: `[ThreadlineRouter] sessionComplete … demoted`).

Verified at runtime: over two days, `auto-acks = 0`, `live-injects = 0`, and the server log
shows only `[relay] Spawned session …` for a peer thread — never `[relay] Resumed session`.

---

## 3. Evidence (the live Echo↔Dawn incident, 2026-06-01)

Echo initiated a Phase-1 credential handoff with peer agent Dawn. Dawn replied six times on
one thread (`thread-1780353572362-830e61`). Every reply cold-spawned a new Echo session.
The fragments looped — "first lock" → "third lock" → "received and held" → "received,
matched, held" — making zero progress. Both sides *correctly* recognized their own
context-blindness and refused to advance the handshake (Dawn, verbatim: *"A context-blind
session has no business initiating or completing this handshake, by design"*). None of it
surfaced to the operator, who experienced a two-hour silence. The security gate held (good),
but the conversation was structurally incapable of progressing or being seen.

---

## 4. Design

The fix is layered. **Layer 1 is the linchpin** — it alone converts the agent from a crowd
of fragments into one continuous individual within a thread. The rest harden and extend.

### Layer 1 — Thread-session continuity (resume actually works) — *Phase 1*

Capture the **real Claude session UUID** for an A2A thread and persist it, so `get()`
returns a resumable entry and `resumeThread` runs `claude --resume <uuid>` with full
context. Two complementary mechanisms (belt-and-suspenders, since each covers a different
failure window):

- **Post-spawn UUID discovery.** Immediately after `spawnNewThread`, resolve the spawned
  tmux session to its Claude transcript UUID (watch the project's Claude JSONL directory
  for the new session file owned by that tmux session) and `threadResumeMap.save` it. This
  makes the *next* message resumable even if the session is still running or crashed.
- **Wire `onSessionEnd`.** Hook the A2A session-exit path (where `sessionComplete` is
  already logged) to discover the final UUID and call `router.onSessionEnd(threadId, uuid,
  sessionName)`. This is the canonical repair the code already anticipates but never calls.

**Acceptance:** message 2 on a thread logs `Resumed session`, not `Spawned session`; the
resumed session demonstrably has the prior turn's context.

### Layer 2 — Live-session injection / warm threads — *Phase 2*

Resume still launches a fresh `claude --resume` per message. For rapid back-and-forth, keep
a per-thread (or per-peer) session warm for a TTL so follow-ups inject into the running
session via the existing `tryInjectIntoLiveSession` / `ListenerSessionManager` path (Phase
2b, currently not engaging for relay). Investigate and fix why `shouldUseListener` never
routes relay traffic. True single-session continuity, no respawn.

### Layer 3 — Identity coherence (the "one individual" requirement) — *Phase 2*

Resume gives *thread* continuity; coherence as *one agent* needs more. An A2A session must
be grounded in the agent's **current self**, not just thread history: its identity, its
shared memory, and awareness that it is the same agent currently talking to the user. Two
parts: (a) extend the spawn/resume prompt (already carries a grounding preamble + thread
history) to inject agent identity + a memory pointer; (b) ensure A2A sessions **write back
to the same memory** the user-facing sessions read, so the two surfaces cannot contradict
each other. This is where the "incoherent individual" risk actually lives.

### Layer 4 — Visibility (surface threads to the operator) — *Phase 1*

The Telegram bridge (`telegramBridge.mirrorInbound`) exists but is default-OFF / not firing
for active threads. Surface A2A conversations to the operator (per the existing "Threadline"
hub-topic convention so it stays calm, not a per-event topic flood). This closes the
invisibility pathology and would itself have prevented the perceived silence.

### Layer 5 — Decision guardrails (the deadlock was *correct*) — *Phase 3*

Critical nuance: a context-blind fragment refusing to complete a credential handshake was
the **right** behavior. The fix is **not** to let a coherent session auto-complete
sensitive handshakes. Coherence and the existing trust/autonomy gates **compose**: give the
session continuity *and* keep security-sensitive completions gated — escalate to the
operator (the R2 operator-confirm gate; "structure informs, the LLM decides, the decision is
audited") rather than letting an autonomous A2A session finish them. Formalize which
decision classes an autonomous A2A session may complete vs. must escalate.

---

## 5. Phasing

- **Phase 1 (resolves the coherence break):** Layer 1 (UUID capture → resume continuity) +
  Layer 4 (visibility). Smallest change that makes the agent coherent within a thread and
  visible to the operator.
- **Phase 2:** Layer 2 (warm live-session injection) + Layer 3 (identity-context injection +
  shared-memory write-back).
- **Phase 3:** Layer 5 (decision-class guardrails).

Each phase is independently shippable and independently testable.

---

## 6. Testing (3-tier, non-negotiable)

- **Unit** (`tests/unit/threadline/`): ThreadResumeMap retains a valid UUID after a
  simulated session-end and `get()` returns the entry (jsonlExists true); the router's
  resume-vs-spawn branch selects resume when an entry exists.
- **Integration** (`tests/integration/threadline/`): two inbound messages on one thread —
  assert message 1 → `spawned`, message 2 → `resumed` with the same UUID; the resume prompt
  carries prior-turn context.
- **E2E** (`tests/e2e/threadline/`): a thread that previously looped now progresses — the
  second response references the first (no re-acknowledgment loop), and the inbound surfaces
  to the operator bridge. This is the "feature is alive" test.

---

## 7. Open decisions for Justin

1. **UUID capture mechanism** — post-spawn discovery, `onSessionEnd` wiring, or both
   (recommended: both — they cover different failure windows).
2. **Visibility default** — surface *all* A2A threads to the hub topic, or only on-demand /
   above a trust threshold? (Recommended: default-on to the silent hub topic.)
3. **Warm-session model (Layer 2)** — per-thread vs per-peer persistent session, and TTL
   (resource-cost tradeoff).
4. **Phase 1 scope** — Layer 1 + 4 only, or pull Layer 3 identity-injection forward into
   Phase 1?

---

## 8. Non-goals

- Not changing the relay transport, encryption, or trust model.
- Not weakening any security gate — Layer 5 explicitly preserves operator-confirm.
- Not unblocking Phase-1 by relaxing Dawn's (correct) refusal; Phase-1 unblocks via direct
  operator authorization, independent of this work.
