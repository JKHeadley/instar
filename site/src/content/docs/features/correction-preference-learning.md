---
title: Correction & Preference Learning
description: The agent learns from the moments you have to correct it — turning recurring corrections into durable, structurally-applied preferences.
---

The **Correction & Preference Learning Sentinel** is the conversational twin of the [Failure-Learning Loop](/features/observability/). Where that loop learns from *code* that broke, this one learns from *moments you had to correct the agent* — "no, plainer", "stop asking me that every session", "from now on lead with the action", "actually, that's wrong".

Today those corrections help only the conversation they happen in. This feature captures the recurring ones, distills the lesson, and routes it — so a correction you make three times across a week becomes one durable change instead of three unrelated one-offs.

It is **signal-only** and **ships dark** (off by default behind `monitoring.correctionLearning.enabled`). It never blocks or rewrites an outbound message — surfacing a wrongly-suppressed message is worse than missing a preference, so the loop only observes, distills, records, and routes.

## The two kinds of lesson

Every correction is one of two things, and conflating them is the central design risk:

- **An Instar infrastructure gap** — a guard or feature that should have prevented the friction. These route upstream as Rising Tide `/feedback`, where they help *every* agent.
- **A this-user preference** — just how *you* like things. These adapt *this* agent: written to a preferences file and injected at every session start.

## How it works

The pipeline runs off the message-delivery hot path (fire-and-forget — a distill error can never delay or block a reply):

1. **Detect (Layer 0).** `HumanAsDetectorLog` is extended with `preference` and `frustration` categories — deterministic, metadata-only, and excluded from the guardian-failure heat map. This layer is always-on and free.
2. **Capture.** `CorrectionCaptureLoop` holds a short, per-topic look-back ring (LRU/TTL-evicted, never serialized into health output). Captured turns are deterministically scrubbed of secrets *before* anything leaves the process.
3. **Distill (Tier-1).** `CorrectionCaptureLoop` enqueues a Haiku-class distillation in its own rate-limited queue. The captured turns are framed as untrusted data — the model is instructed never to follow instructions inside them and to derive the lesson only from *your* turns. The output is a strict, enum-validated JSON envelope; the model's confidence is advisory only. The distilled lesson is scrubbed again before it is ever persisted. When that distillation call is rate-limited (the shared LLM circuit breaker is open, or the daily spend cap is reached), the already-scrubbed capture is not dropped — it is persisted to the durable backlog (`CorrectionCaptureBacklog`) and distilled later in a headroom window, so a sustained throttle can no longer silently lose every correction.
4. **Record.** `CorrectionLedger` is a SQLite store (mirroring the failure ledger) of distilled, scrubbed lessons — deduplicated by a stable hash so the same lesson phrased two different ways collapses to one row. It never stores raw conversation text.
5. **Analyze.** `CorrectionAnalyzer` applies a three-pronged, restart-proof recurrence gate (minimum support **and** distinct calendar days **and** a second orthogonal prong) so one bad day is never mistaken for a pattern. Only code-determined signals count toward the gate; the LLM's confidence can never admit a record on its own.
6. **Route.** `CorrectionLoopDriver` is the authority-guarded router. By construction it cannot mint an evolution proposal or write to a memory file — it can only open a tracked action, post to the agent's own `/feedback` route, write a preference, or route a candidate to the attention queue for you to confirm. A this-user preference is written via the `recordPreference` primitive (see [Conversational Memory](/features/memory/)); an infra-gap becomes a `/feedback` proposal; anything that looks like a policy change is routed to you, never auto-applied.

## Structural application

A learned preference is not a note the agent has to remember. The `recordPreference` primitive in `PreferencesManager` writes it to `.instar/preferences.json`, and from then on the session-start hook fetches `GET /preferences/session-context` on every boot and injects the active preferences — wrapped in an `<auto-learned-preference>` envelope that marks them as signals, not authoritative instructions. The agent reasons with your preferences from message one, by construction, not by willpower.

The recurrence watcher in `CorrectionAnalyzer` then closes the loop: if the same lesson recurs after the preference was written, it reopens; if it goes quiet *and* the written preference is still present, it is marked verified.

The same watcher runs on the infra-gap path with a longer window (14 days vs. 7): if the friction recurs after a `/feedback` proposal, it reopens; but because an infra-gap fix is the upstream project's to ship — the agent cannot prove its own proposal caused the fix — silence is marked *inconclusive*, never a "verified" the agent didn't earn.

## Surviving a throttle (the capture backlog)

A correction is most likely to arrive exactly when the agent is busy — and a busy agent is exactly when the shared LLM circuit breaker is open or the distill budget is spent. The original loop dropped any capture it could not distill in that moment, so a sustained rate-limit could leave the ledger empty even while corrections were being detected.

`CorrectionCaptureBacklog` closes that gap. When the Tier-1 distill is rate-limited, the *already-scrubbed* capture is persisted to a small SQLite store instead of being dropped. A drainer — triggered opportunistically after a later live distill succeeds, plus a slow periodic sweep — works the backlog down whenever the LLM is available again, distilling each entry into the `CorrectionLedger` and deleting the row once it lands. The drain is breaker-gated: it never runs while the breaker is open (which would just re-fail), and it never touches the message hot path.

The store is a bounded extension of the ephemeral look-back ring, not a new data sink. It persists **only** the pre-scrubbed turns — the same secret-scrubbing that guards the distill prompt runs before anything is written, and a second defensive scrub runs on enqueue. Retention is bounded two ways: a max-entries cap (oldest evicted) and a TTL (stale entries discarded); every entry is deleted the moment it distills or exhausts its retries. No API route ever serves backlog contents. The whole thing is on by default when the feature is enabled (it is pure resilience) and is disabled by setting its max-entries to zero, which restores the old drop-on-throttle behavior.

## Self-Violation Signal

A preference the agent recalls every session can still get *violated* — and until now that slip evaporated with no consequence. The **Self-Violation Signal** closes that gap by turning a self-violation into a learning signal.

A learned preference can carry an optional **violation pattern** (a regular expression or a keyword set). When the agent sends an outbound message that contradicts that pattern — for example it says "I'll pick this up in a fresh session" against a "don't defer work to a fresh session" preference — the contradiction is recorded as a self-violation in the `CorrectionLedger`. Because it is keyed on the violated preference's own lesson, repeated self-violations of the same preference collapse to one record whose recurrence count climbs, so that preference is injected more prominently the next session. A stored-but-violated preference no longer fades; it becomes evidence.

This is strictly **observe-only**. The detector (`SelfViolationDetector`) is a pure, deterministic, precision-biased function — a lone or weak match never fires, an unparseable pattern is a no-check, and it is guaranteed never to throw. It runs *after* the message text is finalized, as a fire-and-forget branch that is structurally independent of the outbound-message authority (`MessagingToneGate`): it cannot block, delay, rewrite, or alter the message, and on any internal error it silently no-ops while the message sends normally. A preference without a violation pattern is never checked, so existing preference files are fully compatible.

It ships dark behind both `monitoring.correctionLearning.enabled` and a separate `monitoring.correctionLearning.selfViolationSignal` sub-flag, so it is inert unless explicitly enabled.

## The Preferences dashboard tab

The **Preferences tab** in the dashboard is the calm, human read surface for everything above. It shows, in plain language, the preferences the agent has picked up about you (the same block the session-start hook injects) and the recent corrections it has noticed, each with a short scrubbed summary and its status. The exact words you used are never stored or shown — only the neutral summary. When the feature is off, the tab shows a friendly "not turned on yet" state rather than an error. It is read-only and never blocks or changes a message.

## API

- `GET /preferences/session-context` — the structured block of active preferences (byte-bounded, priority-ordered); `503` when the feature is off.
- `GET /corrections` — the deduplicated, scrubbed ledger view (metadata + the neutral summary only; raw text is never served). Paginates with `?limit` (default 100), a `?before=<ISO>` keyset cursor (pass the prior page's `nextBefore`), and a `?since=<ISO>` lower-bound; filter with `?kind` and `?status`.
- `GET /corrections/:id` — a single ledger record.
- `POST /corrections/analyze` — run the recurrence analysis on demand (the weekly `correction-analyzer` job does this on a schedule). The response includes `routed.overflow` (gate-crossing records left for the next run by the per-tick ceiling or a rate-limited feedback batch) and `routed.rateLimited`.

## Scalability bounds

The loop is bounded at every step so it can never run away under load:

- **Per-tick add ceiling.** The analyzer routes at most `maxRoutesPerTick` learnings per run (default 5); the rest stay open and route on the next run.
- **Batched, rate-limit-aware feedback.** When auto-feedback is on, infra-gap proposals serialize with a delay between them and stop on the first rate-limit response, so a converged batch never trips the feedback route's limit or silently drops a learning.
- **Drift-canary sub-budget.** The drift canary that watches for natural-language phrasing drift gets its own small daily LLM budget (`driftCanaryDailyCents`, default 5), separate from the main distill cap, so it can never starve the main path.
- **Indexed recurrence query.** A composite index on the occurrence log backs the restart-proof distinct-calendar-days count.

## Safety & privacy

- **Signal-only.** Nothing in this loop blocks, rewrites, or delays a message. `CorrectionLoopDriver` holds no blocking authority.
- **Both-sided scrub.** Secrets are removed before the capture leaves the process *and* before the distilled lesson is persisted — the deterministic regex pass is the guarantee, not the LLM.
- **Authority-guarded.** `CorrectionLoopDriver` is given a narrow capability set; it physically cannot auto-implement a policy change. Policy-relaxing phrasings are routed to you to confirm.
- **Primary-user-gated.** Only the topic's primary user's corrections shape the agent's behavior.
- **Ships dark.** Everything except the free Layer-0 classification is gated off until you enable `monitoring.correctionLearning.enabled`.
