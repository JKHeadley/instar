---
title: "Parallel-Work Awareness — an agent that knows what all its hands are doing across topics/sessions (overlap councilor)"
date: 2026-06-03
author: echo
parent-principle: "Structure beats Willpower — the overlap signal comes TO the agent (a cadenced sentinel over existing per-topic intent), not by the agent remembering to look"
review-convergence: internal-adversarial-plus-integration-2026-06-03
review-iterations: 1
review-completed-at: 2026-06-03
approved: true
approved-by: Justin
approved-via: "Telegram topic 18423 (2026-06-03) — blanket workstream preapproval + the explicit ask: an agent must be 'coherently aware of all the parallel activities/topics/sessions… like a king/CEO with a council that informs the main mind', with a proactive Sentinel (NOT a willpower-trap on-demand query). Design converged via adversarial+integration review (1 round) which RESHAPED it from a new registry to a thin index over the existing Topic-Intent Layer + a contained overlap sentinel; see Convergence Report."
eli16-overview: parallel-activity-coherence.eli16.md
---

# Parallel-Work Awareness (overlap councilor)

## The principle (user's framing)
An Instar agent should be **coherently aware of all the parallel activities/topics/sessions
it is involved in at once** — like a king/CEO with a council that INFORMS the main mind.
**Motivating failure (real):** in topic 18423 I specced CPU/memory tracking with zero
awareness that the "Codey Collaboration" topic had already shipped CPU fixes — the user had
to tell me. Canonical bug: **duplicated/misaligned parallel work from self-blindness.**

## What ALREADY exists (convergence — do NOT rebuild)
The first draft proposed a new per-topic "Parallel Activity Registry." That is ~80% already
the **Topic-Intent Layer**, and the new feature must EXTEND it, not duplicate it:
- `TopicIntentStore` (`src/core/TopicIntent.ts:15`) — durable per-topic JSON at
  `{stateDir}/topic-intent/<topicId>.json`, with kinds `fact|decision|method|audience|goal`,
  confidence projection, **decay profiles**, per-file locking. (≈ the proposed focus store.)
- `TopicIntentCapture` (`src/core/TopicIntentCapture.ts`) — the "clerk" that ingests every
  substantive turn fire-and-forget OFF the delivery path. **This is the structural,
  event-driven write path** the draft wanted instead of a willpower `POST` — it already exists.
- `TopicIntentBriefing` — already renders the per-topic arc into session-start context (≈ the
  proposed seed). `TopicMemory.purpose` (`src/memory/TopicMemory.ts:50`) — a one-line current
  focus per topic. `SharedStateLedger` / integrated-being (`src/core/SharedStateLedger.ts`) —
  cross-session `decision|commitment|thread-opened` entries (supplementary seed).
- **What genuinely does NOT exist:** anything that compares work ACROSS topics. That is the
  real, non-duplicative contribution — the sentinel, not a store.

## Design (reshaped by convergence)

### Part 1 — Cross-topic Activity Index (thin; reads existing state)
A read aggregator over the EXISTING per-topic intent + memory state — NOT a new store and
NOT a new write path:
- `GET /parallel-work/activities` → for each topic with recent intent/memory state:
  `{ topicId, nickname, focus, tags, artifacts, updatedAt, running }`. `focus` is sourced
  from `TopicIntentStore` (goal/decision arc) + `TopicMemory.purpose`; `tags` are the
  high-specificity tokens extracted from those (entities, file paths, branches, subsystem
  names — NOT generic words). `running` = is a session/autonomous job live on this topic now.
- The write path is the existing `TopicIntentCapture` ingest (per-turn, structural) +
  `SharedStateLedger` appends. An optional manual `POST /parallel-work/activities/:topicId`
  exists only as enrichment, never the dependency.
- NOT mounted under `/coherence/*` (owned by the unrelated CoherenceGate; "coherence" already
  names 3 systems — Gate, Monitor, proposals). New prefix `/parallel-work` ⇒ needs its own
  `CapabilityIndex` entry (the #727 lint — a feature, it keeps the signal/authority boundary
  legible). 503 when the feature is off, independent of `ctx.coherenceGate`.

### Part 2 — ParallelWorkSentinel (the crux; the willpower-trap fix)
A cadenced, SIGNAL-ONLY sentinel that detects overlapping work and INFORMS the agent. NOT
named "Coherence Sentinel". Operates over the **SET of currently-running topics** (there is
no single "active topic" — multi-session autonomy is one-job-per-topic, `AutonomousSessions`
caps `maxConcurrent`; multi-machine runs many at once). For each running topic, compare its
focus/tags against the OTHER running topics + recently-active index entries, **explicitly
excluding self** (`topicId !== self`). On fresh overlap → one deduped councilor nudge.

**False-positive containment (mandatory — a noisy councilor gets muted, the user's words):**
- **Activity gate** (mirrors BurnDetector's): only compare against entries whose `updatedAt`
  is within an actively-worked window (default 4h). A dormant/decayed topic is not a live
  duplication risk.
- **Specificity, not bare Jaccard:** stopword-strip instar boilerplate (`fix|test|config|pr|
  spec|topic|sentinel|hook|session|migration|…`), IDF/rarity-weight, and require the match to
  rest on **≥1 high-specificity shared token** (entity/file-path/branch/subsystem) — never on
  generic tokens alone. Exclude the OTHER topics' own names/nicknames from scoring (so "I'm
  aligning with B" doesn't itself read as overlap-with-B).
- **Per-topic nudge rate cap** in the sentinel itself (the AttentionTopicGuard does NOT cover
  the in-session nudge path — it only guards `createAttentionItem`). Default ≤1 nudge / 60 min
  / topic.

**Dedup (avoid both re-nag and silent-suppress):** key the cooldown on the **pair**
`(topicA, topicB)` (survives focus edits), and define the overlap signature as the SET of
high-specificity shared tokens with **hysteresis** — re-fire only when that set changes by
more than a threshold (Jaccard(old,new) < X), not on any one-liner edit.

**Feedback-loop guard:** a nudge is delivered into the session; the agent's natural response
is to edit its focus to mention topic B — which would raise the next tick's score. The
pair-keyed cooldown + excluding B's name from scoring + hysteresis together break this loop.

**Cost / cadence:** `IdleAwareCadence` (`src/monitoring/IdleAwareCadence.ts`) so an idle agent
backs off the timer. Cheap keyword path is O(running²) (activity-gated), no LLM. Phase C's
LLM-judged overlap routes through `LlmQueue` (daily spend cap, low-priority lane) AND the
Task-2 component-framework router (overlap-judging is a `sentinel`-category call → Codex) — so
it does NOT add to the Claude rate-limit pressure the broader workstream reduces.

**Multi-machine:** only the **fenced-lease holder** runs the sentinel, so the same overlap
isn't nudged twice from two machines.

**Wiring (house pattern):** construct in `commands/server.ts` behind
`config.monitoring.parallelWorkSentinel` (mirror RateLimitSentinel `server.ts:5783`);
`EventEmitter`; every transition (detected/nudged/deduped/recovered) audited to
`logs/sentinel-events.jsonl` (default-ON housekeeping, user sees nothing); the nudge itself
is the only user-facing emission. Ships **DARK** (`enabled:false`) given the false-positive
risk; graduate via the rollout track.

## MUST NOT DROP
The Codey-Collaboration CPU-vs-ResourceLedger overlap is the canonical case the sentinel must
catch — it's the unit-test fixture for "true overlap on a high-specificity token (`resourceledger`,
`cpu-sampling`)" vs the false-positive case (two topics sharing only `cpu`/`fix`).

## Surfaces
- `GET /parallel-work/activities` — the cross-topic index (read-only).
- `POST /parallel-work/activities/:topicId` — optional manual enrichment (Bearer).
- (Phase B) the ParallelWorkSentinel nudge + `logs/sentinel-events.jsonl` audit.
- All read/signal-only; never gates. 503 when off.

## Phasing
- **A (PR 1):** the cross-topic Activity Index over EXISTING Topic-Intent/Memory state +
  `GET /parallel-work/activities` + tag extraction + CapabilityIndex + 3 test tiers +
  agent-awareness (template + migrateClaudeMd). Thin — no new store.
- **B (PR 2):** the ParallelWorkSentinel — activity-gated, specificity-weighted overlap +
  pair-keyed deduped nudge + IdleAwareCadence + lease-holder-only + rate cap. Ships dark.
  3 test tiers incl. the Codey-CPU fixture (positive) + the generic-token case (negative).
- **C (later):** LLM-judged semantic overlap (via LlmQueue + Task-2 router), cross-machine
  aggregation, then cross-agent (Threadline/integrated-being).

## Config / migration / awareness
`monitoring.parallelWorkSentinel` in `ConfigDefaults` (ships `enabled:false`; `applyDefaults`
add-missing-only propagates to existing agents — free migration; keep no destructive sub-flag
default, per the contextWedgeSentinel precedent). CLAUDE.md template + `migrateClaudeMd`
content-sniff. New `/parallel-work` CapabilityIndex entry.

## Signal vs authority
**Reference:** docs/signal-vs-authority.md. The index is a READER over existing state; the
sentinel is a SIGNAL (a councilor nudge). Neither gates, blocks, or mutates source. No
block/allow surface. (Deliberately NOT under `/coherence/*` to keep that from the authority gate.)

## Convergence Report (1 round, adversarial + integration, 2026-06-03)
Reshaping corrections folded in:
- **Part 1 duplicates the Topic-Intent Layer** (integration, blocker) → re-scoped to a thin
  index over `TopicIntentStore`/`TopicMemory`; write path = existing `TopicIntentCapture`.
- **"Active topic" has no referent in multi-session/multi-machine** (adversarial, blocker) →
  operate over the SET of running topics; lease-holder-only.
- **No false-positive containment** (adversarial, blocker) → activity gate + stopword/IDF +
  ≥1 high-specificity token + per-topic rate cap.
- **/coherence + "Coherence Sentinel" name collision** (integration, blocker) → `/parallel-work`
  prefix + `ParallelWorkSentinel`, own CapabilityIndex entry.
- **Willpower write path** (adversarial) → use TopicIntentCapture ingest, not a hand-called POST.
- **Unbounded cadence/LLM cost** (adversarial) → IdleAwareCadence, O(running²), Phase-C LLM via
  LlmQueue + Codex router.
- **Dedup drift/collision + self-feedback loop** (adversarial) → pair-keyed cooldown, signature
  = high-specificity token set with hysteresis, self-exclusion, exclude other-topic names.
- **Store backend** (integration) → JSON/existing files, not new SQLite.
- **Sentinel wiring + ConfigDefaults + agent-awareness** (integration) → mirror RateLimitSentinel;
  ship dark.
