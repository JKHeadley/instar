---
title: Content-hash dedup for the agent-to-agent relay-agent ingress
review-convergence: retrospective-single-pass
approved: true
eli16-overview: THREADLINE-RELAY-CONTENT-DEDUP.eli16.md
---

# Content-Hash Dedup for the relay-agent Ingress

## Problem

Agent-to-agent messages arrive at `POST /messages/relay-agent`. The handler
accepts the message, then `await`s `ThreadlineRouter.handleInboundMessage`,
which spawns or resumes the receiving agent's session before the HTTP response
returns. On a loaded box that spawn can take longer than the sender's request
timeout. The sender then **retries the same message with a fresh `message.id`**.

The existing dedup in `MessageRouter.relay` keys on `message.id`, so a retry
with a new id is not recognized as a duplicate. The receiver spawns/resumes a
second time and replies twice. This was observed live on 2026-05-30 — six
doubled replies in one evening on a single thread.

The id-based key is the wrong identity for this failure: the thing that is
genuinely the same across the original and the retry is not the id, it is the
*content* — the same sender, on the same thread, saying the same thing, a few
seconds apart.

## Scope

Add a content-hash dedup layer at the `relay-agent` ingress, keyed on the stable
triple `(senderAgent, threadId, normalized content)` within a short fixed
window.

In scope:

- New module `src/messaging/relayContentDedup.ts` (`RelayContentDedup`).
- Wire one instance per server into `createRoutes` and check it in the
  `/messages/relay-agent` handler, after envelope validation and before the
  relay accept.
- On a duplicate within the window, short-circuit with an idempotent `200`
  (`{ ok: true, deduped: true }`) and do not spawn — so the sender's retry still
  sees success and never causes a second spawn/reply.

Out of scope (tracked separately):

- The **accept-boundary** change — returning the HTTP response at the moment the
  message is accepted into the inbox, rather than after the receiver's session
  spawn completes. That removes the *root* cause (the sender no longer blocks on
  the spawn, so it never times out and never retries), but it changes the
  response semantics of the route and interacts with the warrants-reply gate in
  the same handler, so it is a higher-blast-radius change that ships as its own
  reviewed follow-up. This spec deliberately ships the dedup alone: it is
  self-contained, low-risk, and on its own stops the duplicate *replies* the
  user sees.

## Design

`RelayContentDedup` is a bounded, in-memory, fixed-window dedup.

- **Key**: `sha256(senderAgent + sep + threadId + sep + normalizedContent)`,
  where normalization collapses insignificant whitespace so a retry that only
  differs in whitespace still matches.
- **Window**: a key seen within `ttlMs` (default 60 s) of its first sighting is
  a duplicate. After the window elapses, an identical message is treated as a
  genuine new send (two identical sends a minute apart are plausibly real).
- **Fixed window, not sliding**: the first-seen timestamp is only re-stamped
  when the prior sighting has expired, so a persistent retrier is still
  recognized as duplicate within each window rather than holding a key alive
  forever.
- **Bounded memory**: a `maxEntries` cap (default 2000) evicts oldest-first, and
  a lazy sweep drops expired keys on each call. Memory cannot grow without
  bound.
- **Injectable clock**: the class takes a `now()` function so the window logic
  is deterministically testable.

The guard runs only when both `threadId` and message content are present; a
message missing either is passed through unchanged (the dedup has no stable key
for it, and such messages are not part of the observed failure).

## Why this layer, not the existing dedup

`MessageRouter.relay` dedups by `message.id` (correct for true redeliveries of
the same id). `ingressDedup.ts` dedups the Telegram platform path by
`platform:topicId:eventId`. Neither recognizes a relay retry that carries a
fresh id. The content triple is the stable identity for that case, and adding it
at the route keeps the change small and local to where the failure manifests.

## Testing

- **Unit** (`tests/unit/relayContentDedup.test.ts`): both sides of every
  boundary — fresh processes, retry within window drops, window expiry
  processes, distinguishing sender/thread/content, whitespace normalization, the
  memory cap (oldest evicted), and the lazy sweep.
- **Integration** (`tests/integration/threadline-relay-agent-dedup.test.ts`):
  drives the real `POST /messages/relay-agent` route on a booted `AgentServer`.
  A retry with a fresh id but identical `(sender, thread, content)` is deduped
  (the receiver is handed the message exactly once); genuinely different content,
  and identical content from a different sender, are both processed.

## Risks and non-goals

- The window is intentionally short, so the only thing it ever collapses is a
  true rapid retry; it never merges two genuinely distinct sends.
- This does not address the *root* timeout (that is the accept-boundary
  follow-up). It addresses the user-visible symptom — duplicate replies — which
  is the urgent part.
- The dedup is per-server-process in-memory state. Across a multi-machine
  failover the new holder starts with an empty window; a duplicate that straddles
  the handoff could slip through. This is acceptable: the durable per-message
  ledger and the id-based relay dedup still apply, and the straddle window is
  seconds wide.
