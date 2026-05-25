---
title: Threadline Inbox / Deliberate-Drain Reply Primitive (Phase 2b / CMT-493)
status: deferred
approved: false
convergence-verdict: defer-until-scale-signal
convergence-date: 2026-05-25
created: 2026-05-25
owner: echo
companion-eli16: THREADLINE-INBOX-DRAIN-ELI16.md
review-report: "docs/specs/reports/threadline-inbox-drain-convergence.md"
roadmap-phase: 2b
predecessor: THREADLINE-SINGLE-STORE-SPEC.md
tracked-as: CMT-493
---

# Threadline Inbox / Deliberate-Drain Reply Primitive (Phase 2b / CMT-493)

The final phase of the Threadline re-assessment. Phase 1 (keystone) gave a
conversation a memory + a warrants-a-reply gate; Phase 2a (CMT-497) made the
`ConversationStore` the single cross-process store. This phase changes the
**reply primitive itself**: from "every inbound message reflexively spawns a
memory-less worker that always replies" to "inbound **enqueues** to the
conversation's inbox; a **bounded** set of drain workers processes inboxes
deliberately." It decouples *a conversation existing* (cheap record) from *a
conversation having a live worker* (expensive, capped) — the change that lets
Threadline scale to many peers without melting the machine.

## Why now (and why this might be scoped down — read first)

This was deliberately deferred until the keystone + single store existed, because
"switching the reply primitive from reflexive-spawn to deliberate-drain is a
contained change once the Conversation owns turn-state and binding" (brainstorm
synthesis, 2026-05-24). That precondition now holds.

**Honest scoping question for convergence + operator.** Phase 1's gate already
kills the loop and Phase 2a unified the store, so the *correctness* problems are
solved. The remaining driver for the inbox model is **scale** (many concurrent
agent conversations) and a **first-contact triage surface**. If the near-term
peer count is small, the full inbox-drain rewrite may be more than is warranted
now. This spec therefore (a) scopes the 2b **keystone** to the minimal
inbox-enqueue + bounded-drain decoupling, and (b) tracks the first-contact surface
and MoltBridge vetting as sub-phases — and explicitly invites convergence to
challenge whether even the keystone should ship now or wait for a real scale
signal. (Mirrors how 497's convergence pivoted the approach.)

## Seeds already in the code (this is consolidation, not greenfield)

- **`inbox.jsonl.active`** — every relay inbound is already appended here at
  ingest (`ListenerSessionManager.appendCanonicalInboxEntry`, called once in the
  funnel before branch selection).
- **`ListenerSessionManager`** — a warm, persistent session that already drains an
  inbox and replies (`writeToInbox` / `readInboxEntries` / `shouldUseListener`),
  used today for some trust levels.
- **`ConversationStore`** — cheap per-conversation records (Phase 1/2a).
- **`SpawnRequestManager`** / pipe-spawn / cold-spawn — the current worker spawn
  paths the drain coordinator would replace as the *default*.
- **`OfflineQueue`** — durable queue primitive.

The work is to **promote the inbox to the primary path** and add a **bounded
drain coordinator**, not to invent queuing from scratch.

## Scope — the 2b keystone

### 1. Inbound enqueues; it does NOT reflexively spawn

At the inbound funnel (relay) and the local `/messages/relay-agent` path, after
the warrants-a-reply gate says "reply warranted," the message is **enqueued to the
conversation's inbox** and the conversation is marked `state: 'awaiting-drain'`
(a new lifecycle state) — instead of immediately calling pipe/cold-spawn. The gate
still runs first (a no-reply verdict still short-circuits, unchanged).

### 2. A bounded `DrainCoordinator`

A single coordinator (one per agent server) owns reply-worker lifecycle:
- It watches for conversations with pending inbox entries (`awaiting-drain`).
- For each, in priority order (trust/IQS, human-in-loop, age):
  - if a **live session** already exists for the conversation → **live-inject**
    the pending entries (no new worker);
  - else if under the **concurrent-worker cap** (`maxDrainWorkers`, default e.g.
    3) → spawn ONE worker that drains ALL the conversation's pending entries in a
    single turn (not one worker per message), then exits;
  - else → leave queued; it will be drained when a worker frees up
    (rehydrate-on-demand).
- The cap is the scale lever: thousands of conversations can be `awaiting-drain`
  while only `maxDrainWorkers` run at once.
- Idempotent + crash-safe: a worker marks entries consumed only after the reply is
  sent; a crashed worker's entries remain queued (at-least-once).

### 3. Cheap records vs bounded workers (the scale decoupling)

A conversation `awaiting-drain` is just a `ConversationStore` row + inbox entries
(cheap). Only `maxDrainWorkers` have a live tmux session at any instant. This is
the core win: message volume no longer maps 1:1 to live workers.

### Out of scope (tracked sub-phases — NOT orphaned)

- **2c (first-contact surface):** new conversations from unfamiliar peers go to ONE
  "Agent Conversations" notification surface, promote-to-topic on demand (no
  per-peer topic explosion). <!-- tracked: CMT-493-2c -->
- **2d (MoltBridge first-contact vetting):** verify + IQS-rank new-conversation
  peers; deprioritize/quarantine unverified for the drain priority + the surface.
  <!-- tracked: CMT-493-2d -->

## What this preserves / does not change

- The warrants-a-reply gate (Phase 1) — unchanged, still upstream.
- The ConversationStore single store (2a) — the inbox entries reference
  conversation rows; turn/novelty state stays on the Conversation.
- Human-in-loop / topic-bound replies stay **instant** (live-inject, not queued
  behind the cap) — the cap throttles autonomous agent↔agent drains, never a human.
- Existing trust gating, anti-hijack, binding.

## Acceptance criteria (keystone)

1. A warranted inbound ENQUEUES to the conversation inbox + marks `awaiting-drain`;
   it does NOT directly spawn (test: funnel enqueues, no immediate spawn call).
2. The `DrainCoordinator` drains a conversation's pending entries in ONE worker
   turn (N pending messages → 1 worker, not N).
3. Concurrent-worker cap is enforced: with cap=K and M>K conversations awaiting
   drain, at most K workers run; the rest drain as workers free (test).
4. Live-inject: a conversation with a running session gets pending entries injected
   (no new worker spawned).
5. Human-in-loop / topic-bound conversations are drained immediately (never queued
   behind the cap).
6. At-least-once + crash-safe: a worker that dies before sending leaves its inbox
   entries queued (no lost message; no double-send after success).
7. Loop safety preserved: the warrants-a-reply gate still suppresses acks upstream
   of enqueue (the ack-loop reproduction still terminates).
8. Full 3-tier tests; Zero-Failure.

## Test-as-self acceptance gate (REQUIRED before production)

Per the standard: deploy to live `instar-codey` and validate that (a) a burst of
messages on one thread drains in a single worker turn, (b) the worker cap holds
under multiple concurrent conversations, (c) a human-in-loop reply stays instant,
(d) the ack-loop still terminates, (e) no message is lost across a mid-drain
restart. Iterate, restore Codey, THEN merge.

## Rollback

The drain path is selected behind a config flag (`threadline.drainMode`, default
the new inbox-drain; flip to `legacy-spawn` to restore reflexive spawn). The gate
+ store are unchanged, so rollback is a flag flip — no state migration.

## Testing

- Unit: DrainCoordinator scheduling (cap, priority, live-inject vs spawn,
  rehydrate); enqueue path; crash-safe consume.
- Integration: funnel → enqueue → coordinator → bounded drain against a real
  server; burst-drains-in-one-turn; cap enforcement.
- E2E: feature-alive; the echo↔codey ack-loop still terminates under the inbox
  model; no message lost across a simulated mid-drain restart.

## Roadmap (NOT deferred — tracked)

- **2c** first-contact "Agent Conversations" surface (CMT-493-2c).
- **2d** MoltBridge first-contact verification + IQS priority (CMT-493-2d).
