# Convergence Report — Threadline Collaboration Surfacing (CMT-509)

**Spec:** docs/specs/THREADLINE-COLLABORATION-SURFACING-SPEC.md
**Date:** 2026-05-25 · **Mode:** two reviewers (completeness + adversarial),
grounded against live code at v1.2.78.

## Verdict: revise → ship a smaller MVP. (~70% of machinery already exists.)

The driver is real and present (a single peer made the collaboration invisible),
but the first draft would have re-opened the near-silent-notifications problem
Phase 1 just closed, double-written topics, and regressed nuanced live logic. The
spec is revised to a minimal, low-noise MVP that closes the exact incident; the
higher-volume surfacing is tracked.

| # | Severity | Finding | Resolution in revised spec |
|---|----------|---------|----------------------------|
| 1 | FATAL (factual) | First draft claimed the topic path "already posts to the topic" and framed §2 as a mere "strengthen." Reality: `tryRouteReplyToTopic` posts a **capped raw-body** notification only on `user-visible` (first reply); on `live-inject` + `agent-internal` it posts **nothing** (the incident). | Corrected the "verified current behavior" section; reframed as a single-writer fix (§3), not "strengthen." |
| 2 | BLOCKING | Commitment resolves on **delivery-mode** (`live-inject`/`resume-pending`), NOT agent-ack — and resolves even when nothing surfaced. First draft mis-stated the trigger. | §1 restated precisely: gate `deliver()` on `telegramSent`; keep `markReplyArrived` non-terminal; cite the 7-day TTL backstop; keep `failure-visible` escalation. Small, no refactor. |
| 3 | BLOCKING | Agent-initiated inbound never reaches `tryRouteReplyToTopic` (guarded on `originTopicId`). §1 needs NEW seams at the relay funnel AND the local `/messages/relay-agent` route (the incident was co-located → local seam). | §2 specifies both seams. |
| 4 | RISK (big) | "Substantive" is far below the operator's recorded "near-silent / action-required-or-usable-result" bar; the salience LLM classifier is **fallback-only** in prod; an N-turn exchange → N pings. | §2 = ONE attention item per new conversation (not per message, dedupe follow-ups); §4 binds surfacing to the Phase-1 novelty/turn-budget so non-novel/ack turns never surface. |
| 5 | RISK | First draft wanted an LLM "gist" per message → latency/cost/failure on the inbound hot path; the body is already natural language. | §5 drops the summarizer; post capped raw body; just strip envelope/JSON (the `JSON.stringify(content)` funnel path must never reach the operator). |
| 6 | RISK | §2's "complementary, not either/or" makes the interleave WORSE — background worker posting + live-inject into the same session = confusing double-write. | §3 = single-writer-per-topic: inject-if-live (let it relay), post-if-not. |
| 7 | RISK | "Which topic?" — no active-topic concept exists; only the lifeline topic is well-defined. | MVP anchors to the lifeline topic via `/attention`; the "last-active topic" heuristic is tracked (CMT-509-active-topic). |
| — | OK | All seeds are LIVE in production (SalienceGate, TopicLinkageHandler, CommitmentTracker.deliver/markReplyArrived, lifeline topic getter, /attention). No dead-code targets (unlike prior phases). |

## The MVP (what the revised spec ships)

1. Commitment doesn't resolve until a user-facing surface is confirmed sent (the
   exact incident bug).
2. Agent-initiated first contact → ONE near-silent attention item (deduped).
3. Single-writer-per-topic for topic-originated replies (closes the live-inject-
   posted-nothing gap without double-writing).
4. Surfacing bound to the existing novelty/turn-budget (stays near-silent).
5. No per-message summarizer; user-readable body, never raw JSON.

Deferred + tracked: guaranteed post on every reply + LLM salience wiring
(CMT-509-fullsurface), last-active-topic heuristic (CMT-509-active-topic), ambient
streaming (CMT-509-stream), dedicated surface (CMT-493-2c).

## Why this is the right size

It closes the exact failure (invisible collaboration + premature resolution) with
the least noise risk and no regression of the working topic-originated path, and it
validates the experience before committing to higher-volume surfacing. Process
working again: review caught that the obvious "surface everything" build would
violate the operator's own near-silent standard.
