---
title: Threadline Collaboration Surfacing (background agent collaboration flows into the user's conversation)
status: draft
approved: false
created: 2026-05-25
revised: 2026-05-25
owner: echo
companion-eli16: THREADLINE-COLLABORATION-SURFACING-ELI16.md
review-report: "docs/specs/reports/threadline-collaboration-surfacing-convergence.md"
roadmap-phase: experience-layer
tracked-as: CMT-509
relates-to: CMT-493 (Phase 2b inbox — deferred), CMT-493-2c (first-contact surface)
---

# Threadline Collaboration Surfacing (MVP)

When this agent collaborates with another agent over Threadline, the
collaboration must be **visible to the operator** — not happen in an invisible
side channel they manually reconcile. Present-day product gap from a real incident
(2026-05-25, topic 12304): a genuine Echo↔Codey collaboration happened entirely in
background worker sessions and never surfaced to the operator, AND the "report
back" commitment resolved with the operator never informed.

> **Scoped DOWN after convergence (2026-05-25).** Two reviewers (grounded against
> live code) found the first draft would (a) re-open the near-silent-notifications
> problem Phase 1 just closed (surfacing on "substantive" is far below the
> operator's "action-required / usable-result" bar; the salience LLM classifier is
> fallback-only in prod), (b) double-write topics, and (c) regress the more-nuanced
> live resolution logic. ~70% of the machinery already exists. So this is now a
> **minimal, low-noise MVP** that closes the exact incident; the higher-volume
> surfacing is tracked.

## Verified current behavior (corrects the first draft)

- `TopicLinkageHandler.tryRouteReplyToTopic` (topic-originated replies) ALREADY
  posts a capped **raw-body** notification to the originating topic — but ONLY
  when the salience verdict is `user-visible` (first reply) OR delivery is
  failure/resume-pending. On `live-inject` + `agent-internal` it posts **nothing**
  (the incident). It is NOT a summary; the peer's body is already natural language.
- The commitment is marked **delivered on delivery-mode** (`live-inject` /
  `resume-pending`) — NOT on the user actually seeing anything. So a live-inject
  with an agent-internal verdict closes the "report back" promise silently.
- **Agent-INITIATED** inbound (no `originTopicId`) never reaches
  `tryRouteReplyToTopic` at all (`ThreadlineRouter` guards on `originTopicId`), so
  it surfaces nothing.
- `SalienceGate` is constructed **fallback-only** (deterministic, no LLM):
  first-reply → `user-visible`, later → `agent-internal`.
- There is **no "active topic" concept**; the only well-defined durable anchor is
  `telegram.getLifelineTopicId()`. `/attention` exists as a near-silent
  pull-with-ping surface (`createAttentionItem`).

## Scope — the MVP keystone

### 1. Fix the premature commitment resolution (the core incident bug)

A `threadline-reply` "report back when X" commitment must NOT be marked delivered
until a **user-facing surface is confirmed sent** (the Telegram post resolved
without throwing — read-receipts don't exist, so "send resolved" is the signal).
Today `deliver()` fires on `live-inject`/`resume-pending` regardless. Change: keep
`markReplyArrived()` (non-terminal) on every arrival; gate `deliver()` on
`telegramSent === true`. If surfacing fails, the commitment stays OPEN (and the
`failure-visible` escalation path is preserved); the existing 7-day commitment TTL
+ `expireCommitments()` sweep is the backstop against a permanent hang.

### 2. Agent-initiated FIRST-CONTACT surfaces as one attention item

When a peer initiates a Threadline conversation with no resolvable origin topic
AND the warrants-a-reply gate judged the message substantive (reuse the existing
verdict, including the gate's novelty/turn-budget — see §4), surface ONE
`/attention` item (near-silent, pull-with-ping) anchored to the lifeline topic:
"🧵 <peer> started a Threadline conversation: <gist> — say 'open this' to engage."
- ONE item per new conversation (not per message); follow-ups update/dedupe it,
  they do not stack. This respects near-silent.
- Wired at BOTH inbound seams (the relay funnel in `server.ts` after the
  warrants-reply gate, AND the local `/messages/relay-agent` route) — the incident
  was a co-located peer, which uses the local seam.

### 3. Single-writer-per-topic for topic-originated replies

Resolve the current either/or cleanly: when the topic's session is LIVE,
live-inject (and let that session relay) — do NOT also post a standalone surface
(avoids the §6 interleave). When NO live session exists, post the user-facing
surface directly. This also closes the incident's "live-inject posted nothing"
gap: on a `user-visible` verdict with no live session, the post is guaranteed.

### 4. Bind surfacing to the existing novelty / turn-budget

Surfacing is a CONSUMER of the Phase-1 Conversation signal: never surface a turn
the warrants-a-reply gate marked non-novel / pure-ack. An N-turn legitimate
exchange does not produce N operator pings — only genuinely new, user-relevant
content surfaces. This is what keeps it near-silent.

### 5. User-readable, never raw JSON

Surfaced text is the peer's message body (capped), prefixed with peer + gist —
NO per-message LLM summarizer (latency/cost/failure on the hot path for marginal
gain; the body is already natural language). MUST strip any envelope/JSON: the
agent-initiated funnel path can have `textContent = JSON.stringify(content)` when
content is a non-string object — that must never reach the operator (extract a
readable field or skip surfacing).

## Out of scope (tracked — NOT orphaned)

- Guaranteed user-readable post on EVERY reply (vs. first-contact + no-live-session)
  + wiring the LLM salience classifier for a higher-volume bar. <!-- tracked: CMT-509-fullsurface -->
- A "last-active topic" heuristic so in-flight collaboration lands in the topic the
  operator just used (vs. the lifeline anchor). <!-- tracked: CMT-509-active-topic -->
- Ambient/as-it-happens streaming of the back-and-forth. <!-- tracked: CMT-509-stream -->
- Dedicated "Agent Conversations" surface + promote-to-topic + IQS ranking
  (CMT-493-2c). The inbox/scale rewrite (CMT-493, deferred).

## Acceptance criteria

1. A `threadline-reply` commitment does NOT resolve until a user-facing surface is
   confirmed sent; on surfacing failure it stays open (failure-visible escalation
   intact); the 7-day TTL is the backstop. Test: live-inject + agent-internal no
   longer silently resolves.
2. An agent-initiated substantive first contact produces exactly ONE attention item
   to the lifeline topic; a pure-ack/no-op (per the gate) produces none; follow-ups
   update one item, not N. Test both sides + the dedupe.
3. Topic-originated reply: live session present → inject only (no double post);
   no live session + user-visible → exactly one user-facing post. Test both.
4. Surfacing never emits raw envelope/JSON or a transport placeholder.
5. Surfacing only fires on novel/user-relevant turns (bound to the gate's signal);
   an N-turn novel-then-acks exchange does not produce N pings.
6. Reproduction: replay the 2026-05-25 incident (co-located peer-initiated note) —
   the operator sees one user-facing update WITHOUT manual reconciliation, and the
   follow-up commitment resolves only after that update.
7. Full 3-tier tests; Zero-Failure.

## Test-as-self acceptance gate (REQUIRED before production)

Deploy to live `instar-codey`; Codey initiates a substantive note to Echo; confirm
Echo posts ONE user-facing update (attention item) automatically (no manual paste),
it's readable, follow-ups don't spam, and the commitment resolves only after the
update. Verify a multi-turn exchange does NOT flood the operator. Iterate, restore
Codey, THEN merge.

## Rollback

Behind a flag (`threadline.surfaceCollaboration`, default on). Revert = flag off
(today's behavior) or revert the handler/funnel changes. The commitment-resolution
fix is a guard on an existing call — revert is removing the guard. No state
migration.

## Testing

- Unit: commitment resolves-only-after-surface (gate on telegramSent); attention
  first-contact dedupe (one item, follow-ups update); single-writer decision
  (inject-if-live vs post-if-not); JSON-stripping of surfaced text; novelty binding.
- Integration: inbound (agent-initiated + topic-originated) → correct surface to the
  correct topic against a real server; commitment lifecycle gated on surface.
- E2E: feature-alive; incident reproduction (co-located peer note → one operator
  update, no manual reconcile, commitment resolves only after).
