---
title: "Periodic Goal Re-Alignment (automatic topic-goal resync)"
slug: "periodic-goal-realignment"
author: "Echo"
eli16-overview: "periodic-goal-realignment.eli16.md"
status: draft
single-run-completable: true
---

# Periodic Goal Re-Alignment (automatic topic-goal resync)

## Problem statement

Long-running work drifts. On 2026-07-23 the operator issued a course-correction to a
14-hour autonomous drive: the session's queue had accumulated locally-sensible next
steps whose sum no longer matched the topic's top-level goals, and the operator had
to manually direct "review all the messages in this topic from the last week to see
the priorities in our top level goals." His directive, verbatim: "it's feeling like
that needs to be something you do automatically regularly otherwise it feels like
the goals get misdirected or start working towards solutions [that] don't have
alignment with a holistic view."

Today the only defenses are willpower-class: the agent remembering to re-read the
topic, or the operator noticing drift and intervening. Both failed silently for
hours. Per the constitution's foundational standard, if the behavior matters it must
be enforced structurally — a re-alignment the agent must remember to run is a wish.

## CLASS review (before design)

### What standard is missing or needs upgrading?

A **Goal-Anchored Autonomy** standard: any session doing multi-hour autonomous work
in a topic must be periodically re-grounded against the operator's actual stated
goals in that topic — from durable, sender-verified message history, not from the
session's own summary of itself (a drifted session summarizing its own goals
re-inhales its drift). The anchor is the operator's words; the session's state file
is the *subject* being checked, never the source of truth for the check.

### What development-process gap allowed the class?

Autonomous-run machinery (stop-hook re-feed, completion judge, progress heartbeat)
all evaluate the run against the run's OWN goal statement, captured once at setup.
Nothing compares that goal statement — or the evolving queue derived from it —
against the operator's messages as they accumulate. The gap: setup-time intent was
treated as immutable ground truth for the entire run lifetime.

## Goals

1. At session start for a topic with an active autonomous run, and on a cadence
   during the run (default 60 min), produce a **goal digest**: a compact, bounded
   summary derived exclusively from the operator's sender-verified messages in that
   topic over a lookback window (default 7 days).
2. Compare the run's current focus (state-file goal + recent task additions) against
   the digest with one LLM pass, yielding `aligned` | `drifting` | `diverged` plus a
   one-paragraph reason naming the specific unaddressed operator priority.
3. Inject the digest + verdict into the working session as a signal-only
   re-alignment brief (session-start hook context at boot; a nudge line into the
   session at cadence ticks). Never block, never rewrite, never halt work.
4. Record every verdict durably so drift-over-time is auditable per topic.
5. Bounded cost: ride the LlmQueue, register in the per-feature metrics surface,
   route off-Claude by the provider-fallback default policy.

## Non-goals

- Not a gate. A `diverged` verdict changes what the agent SEES, never what it CAN
  do. The agent (and ultimately the operator) decides whether to re-steer.
- Not a replacement for the completion judge or scope-accretion discipline — those
  hold the exit bar; this holds the *direction* during the run.
- Not cross-topic. Each topic's digest is built from that topic's history only
  (parallel-work awareness already covers cross-topic overlap).
- Not retroactive interpretation authority: the digest QUOTES operator priorities
  with message timestamps; it never asserts new obligations the operator didn't
  state.

## Design

### Components

**GoalDigestBuilder** (deterministic + one LLM summarize pass). Input: the topic's
durable inbound message store filtered to the topic's VERIFIED operator (Know Your
Principal — sender-authenticated uid match, never content names), lookback-bounded,
length-clamped. Output: a digest of stated goals/priorities, each entry carrying the
source message timestamp. Cached per topic; rebuilt only when new operator messages
arrived since the last build (zero LLM spend on quiet topics).

**AlignmentReviewer** (one LLM pass per tick). Input: the digest + the run's state
file frontmatter goal + the tail of its task list (bounded). Output:
`{verdict: aligned|drifting|diverged, reason, unaddressed: [..]}`. Fails toward
silence: provider error, empty digest, or no active run ⇒ no injection, counter
incremented, never a fabricated verdict.

**RealignmentInjector** (existing surfaces, no new channels). Session-start: rides
the same hook-context path as preferences/self-knowledge, wrapped in an
`<auto-goal-realignment>` envelope marked advisory. Cadence tick: one bounded
plain-text nudge line into the session (the AutonomousProgressHeartbeat delivery
pattern), rate-limited to one per cadence period, suppressed while the session is
mid-turn (inject at the next idle boundary, per the send-keys interruption lesson).

### Authority & safety

- Signal-only end to end. Every failure path fails toward silence, never toward a
  blocked or rewritten message, never toward a halted run.
- Digest sources are quoted untrusted-adjacent data: operator messages are
  authoritative for PRIORITIES, but the digest text injected into context carries
  its provenance envelope so a poisoned/mistaken summary is inspectable.
- The verdict LLM call is a non-gating internal call (category: reflector): it rides
  the provider-fallback default (off-Claude), the non-gating failure-swap, the
  spawn-cap funnel, and per-feature metrics under feature key `goal-realignment`.
- No new notification surface: a `diverged` verdict that persists N consecutive
  ticks (default 3) raises ONE deduped attention item per episode — the operator
  hears about sustained drift exactly once, on the existing queue.

### Rollout ladder

Ships dark on the fleet (`monitoring.goalRealignment.enabled` omitted ⇒
resolveDevAgentGate), dryRun-first even on dev (`dryRun: true`: verdicts computed +
logged to `logs/goal-realignment.jsonl`, nothing injected). Graduation to live
injection on the dev agent after a measured soak (false-`diverged` rate reviewed
from the log); fleet flip is a separate deliberate step. Off-switch read live.

### Observability

- `GET /goal-realignment` → per-topic last digest age, last verdict, tick counters,
  suppression counters, breaker state (503 when dark).
- `logs/goal-realignment.jsonl` → one row per tick: topic, verdict, reason,
  digest-message-count, injected|suppressed|dry-run.
- Per-feature LLM metrics row (`goal-realignment`) for cost accountability
  (Token-Audit Completeness).

## Acceptance matrix (minimum)

| Scenario | Expected |
|---|---|
| Active run, new operator msgs, drifted queue | `drifting`/`diverged` verdict logged; dryRun ⇒ no injection; live ⇒ brief injected at idle boundary |
| Active run, no new operator msgs since last digest | Zero LLM spend for digest; reviewer may still run on cadence against cached digest |
| No active autonomous run in topic | No-op, counter only |
| Provider down / empty digest | Silence + counter; never a fabricated verdict |
| 3 consecutive `diverged` | Exactly ONE attention item per episode (deduped) |
| Session mid-turn at tick | Injection deferred to idle boundary, never mid-work |
| Feature dark / single verdict surface off | Routes 503; session-start hook injects nothing |
| Operator message from unverified sender | Excluded from digest (verified-operator filter) |

## Open questions for convergence

1. Should the cadence tick re-drive the FULL digest rebuild when the state file
   changed but no new operator messages arrived (drift can grow queue-side only)?
   Current answer: yes — the reviewer always sees the live state-file tail; only
   the digest build is cached.
2. Interaction with CONTINUATION resumes: inject the brief on every resume, or only
   when the last injection is older than the cadence? Current answer: age-gated.
3. Whether `diverged` should also annotate the run's state file (a durable marker
   the stop-hook re-feed surfaces) — stronger loop-closure, but writes to a file
   the session owns; needs a single-writer story.
