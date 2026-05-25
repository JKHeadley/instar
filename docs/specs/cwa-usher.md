---
slug: cwa-usher
title: The Usher — a signal-only mid-task watcher that re-surfaces faded-but-relevant context
author: echo
project: continuous-working-awareness
status: approved
review-convergence: "2026-05-25T18:00:00Z"
review-iterations: 1
review-note: "Claude-authored + manual standards/lessons self-review (single angle). Full /spec-converge + /crossreview multi-model convergence NOT run — tooling absent on this host. Ratified by Justin 2026-05-25 with that caveat explicit; fuller review (esp. the usher_acted precision definition that gates rung 5) advisable before/with merge."
approved: true
approved-by: justin
eli16-overview: cwa-usher.eli16.md
---

# The Usher (rung 4 — signal-only)

## Problem statement

We can now capture context automatically (rungs 0–1), enforce the constitution
(rung-3 normative slice), and read a unified ranked working set (rung 2). But the
working set is only consulted at **two moments**: session-start (the briefing) and
pre-send (ArcCheck). Between those, a context can fade out of the hot set and then
become relevant again mid-task — and nothing pulls it back. The North Star names
this exact gap: *"a continuous MID-TASK injection surface (today injection is
session-start briefing or pre-send gate only)."*

The Usher fills it: a watcher that, as the conversation proceeds, notices when a
**faded-but-now-relevant** context is worth re-surfacing — and **signals** it.

> Per the North Star evolution path, rung 4 is the Usher **signal-only**: *"emit
> 'you may want context X' to a surface — measure precision before it's allowed to
> inject."* Actual mid-task injection is rung 5, deliberately separate and gated on
> the Usher's measured precision. This spec is rung 4 only.

## The hard constraint (why signal-only first)

A continuous watcher that interrupts is the fastest way to become the thing the
user (or agent) learns to tune out — the [Near-Silent Notifications](#) failure.
So the Usher does **not** inject anything in v1. It emits signals to a pull
surface, and we **measure its precision** (how often a signal was actually useful
vs. noise) BEFORE rung 5 is allowed to turn any of them into a mid-task injection.
This is [Signal vs. Authority](#) applied to the riskiest surface yet: the Usher
is a pure signal producer; the authority to interrupt is withheld until the data
earns it.

## Proposed design

### 1. The seam — per inbound turn (cheap, reuses the existing path)

The Usher chains onto `telegram.onMessageLogged` (the same per-turn seam the
capture loop uses), running AFTER capture so it sees the freshly-filed turn. Each
substantive inbound turn is a "mid-task moment": the conversation just moved, so
maybe a faded context now matters.

**Decision flagged for ratification (A):** per-turn seam (recommended) vs. a
per-tool-call hook. Per-turn reuses the established seam, bounds cost to one
cheap check per substantive turn, and "mid-task" = "mid-conversation" for a
chat-driven agent. A per-tool-call Usher is finer-grained but multiplies cost and
is rung-5 territory; recommend per-turn for v1.

### 2. What it watches — the "re-warm" detector

The Usher asks, for each substantive turn: *is there a context that is currently
FADED (not in the hot/surfaced set — below the briefing tier, or decayed out) but
that THIS turn makes relevant again?* It draws candidates from the unified working
set (rung 2's `WorkingMemoryAssembler`), specifically the **faded tail** — items
the session-start briefing did NOT carry — and asks a cheap LLM whether the new
turn re-activates any of them.

- **Degrade-safe:** no working set / no intelligence / LLM throw → no signal
  (fail-open). The Usher never throws into the message path; it's fire-and-forget.
- **Cost:** one fast-tier call per substantive turn, through the shared LlmQueue
  (background lane), rate-limited per topic, and skipped under QuotaTracker
  pressure — the same envelope as the capture loop. The deterministic pre-filter
  (reuse `isSubstantiveTurn`) keeps trivial turns from ever reaching the model.

**Decision flagged for ratification (C):** "faded" = working-set items below the
briefing tier / not in the last briefing (recommended — the genuine re-warm case)
vs. all working-set items (re-surfacing already-hot context is noise).

### 3. The signal surface — a read-only pull surface (no injection)

The Usher writes signals to a durable, read-only surface: `GET /usher/signals?topicId=N`
returns recent re-surface suggestions (`{contextRef, reason, turn, at}`), and the
dashboard can show them. It does **not** push to chat and does **not** inject into
the agent's context. A consumer (the agent, the user, or — later — rung 5's gate)
*pulls* it.

**Decision flagged for ratification (B):** a dedicated `/usher/*` surface
(recommended — clean, independently measurable) vs. reusing the Attention Queue.
Dedicated keeps Usher precision metrics separate and avoids overloading the
attention semantics.

### 4. Precision measurement (the whole point of doing rung 4 before rung 5)

Per the Observability standard, the Usher is metered from brick one — and the
metering is what gates rung 5:

- `usher_fired` — signals emitted (per topic, per turn).
- `usher_acted` — a signal that was subsequently *used* (the re-surfaced context
  appears in the agent's next action / a later briefing / an ArcCheck fire). This
  is the precision numerator.
- **Miss signal:** the shipped `HumanAsDetectorLog` heat map — a human-caught
  "you forgot X / you should have connected those" that the Usher *should* have
  re-surfaced and didn't. Pairing `usher_fired`/`usher_acted` (what it caught) with
  the heat map (what it missed) is the precision read.

`GET /usher/metrics` exposes the funnel. **Rung 5 (mid-task injection) does not
proceed until this precision is measured and judged trustworthy** — written into
rung 5's spec as a precondition, not left implicit.

### 5. Signal vs. authority + near-silent (NON-NEGOTIABLE)

The Usher signals; it has no authority to inject or interrupt. Its surface is a
*pull* surface (dashboard / endpoint), never a chat push — so even a noisy Usher
can't train the user to tune it out. The full-context decision to act on a signal
is withheld for rung 5, gated on §4's precision.

## Non-goals (tracked, not silent)

- **Mid-task injection / interruption** is rung 5 <!-- tracked: cwa-injection -->,
  explicitly gated on the Usher's measured precision (§4).
- **Per-tool-call watching** <!-- tracked: cwa-usher-tool-seam --> — finer-grained
  observation than per-turn; revisit after per-turn precision is known.
- **Capability/standards descriptors as re-surface candidates** ride the
  capability-index follow-up <!-- tracked: cwa-capability-index-context -->.

## Lessons carried (manual lessons-grep)

- **Signal vs. authority** (the Usher's defining constraint) + **near-silent**
  (pull surface, never chat push).
- **No greenfield** — reuses the onMessageLogged seam, the rung-2 working set, the
  LlmQueue, the pre-filter, and the human-as-detector miss-map.
- **Best-effort / degrade-safe / fire-and-forget** — inherited from the capture
  loop; the Usher never blocks or slows the message path.
- **Framework-agnostic** (IntelligenceProvider via the queue, never raw API),
  **Observability** (metered from brick one, and the metering *gates the next
  rung*), **migration parity** (additive watcher + route + config default),
  **testing integrity** (3 tiers + wiring-integrity that the watcher is attached
  to the live callback).
- **Measure before authority** — the explicit "rung 5 waits on rung 4's precision"
  precondition is the structural guard against shipping an interrupter we haven't
  verified.

## Testing (all three tiers + wiring + transport)

- **Tier 1 (unit):** the re-warm matcher (stubbed LLM) emits a signal for a faded
  context the turn re-activates, and none for an unrelated turn / an already-hot
  context; degrade-safe (no provider / no working set → no signal, no throw);
  pre-filter skips trivial turns; transport routes through the queue's background
  lane on the injected provider.
- **Tier 2 (integration):** a posted turn produces a signal readable at
  `GET /usher/signals`; `usher_fired` increments; `/usher/metrics` reflects the funnel.
- **Tier 3 (e2e):** boot the real path; file a context, let it fade, then post a
  turn that re-activates it → a signal appears on the pull surface (the re-warm
  caught end-to-end); the surface is alive (200, not 503).
- **Wiring-integrity:** the Usher is attached to the live `onMessageLogged`
  callback (anti-"shipped-but-asleep").

## Acceptance criteria

1. A substantive turn that re-activates a faded context produces a signal on
   `GET /usher/signals` — verified e2e, not unit-mocked.
2. An unrelated turn, or one matching only already-hot context, produces no signal.
3. The Usher never injects or pushes to chat (signal-only; pull surface).
4. Message delivery is never blocked or slowed; Usher failures degrade to a counter.
5. `/usher/metrics` exposes `usher_fired` / `usher_acted` + ties to the
   human-as-detector miss-map; rung 5's spec will cite this as its precondition.
6. The extraction LLM call goes through the subscription/REPL-pool transport (asserted).
7. All three tiers + wiring + transport green; tsc + lint clean.

## Risk and rollback

Medium-low. Additive (a watcher on an existing callback + a read-only surface),
fire-and-forget, degrade-safe, and — critically — **it cannot act**, only signal,
so a logic bug produces noisy/missed *suggestions on a pull surface*, never a
wrong interruption or a delivery failure. New per-turn cost is one fast-tier call,
bounded exactly like capture. Rollback: remove the watcher + route; nothing else
depends on it (rung 5 isn't built). Config kill-switch `usher.enabled` (default
true; signal-only is safe-on).

## Migration parity

Additive watcher wiring in server.ts + a new `/usher/*` route + a config default
(`usher.enabled`, existence-checked) + metrics file. Server-side (every agent on
update). `usher` added to `INTERNAL_PREFIXES`. No hook/template/skill change.

## Open decisions for ratification

- **(A)** Per-turn `onMessageLogged` seam (recommended) vs. per-tool-call hook.
- **(B)** Dedicated `/usher/*` pull surface (recommended) vs. reuse the Attention Queue.
- **(C)** "Faded" = below-briefing-tier / not-last-briefed (recommended) vs. all
  working-set items.

## Convergence note (honest)

Claude-authored draft + manual standards/lessons self-review; full `/spec-converge`
+ `/crossreview` multi-model tooling absent on host. The Usher is deliberately the
*safe* half of the continuous-injection idea (signal-only, pull surface, measured
before rung 5 earns authority) — but a fuller multi-model review before the code
merges remains advisable, especially on the precision-metric definition that will
gate rung 5.
