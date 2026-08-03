# Scheduler Alert Delivery — Plain-English Overview

> The one-line version: Every Telegram startup topology now hands the same real sending channel to scheduled-job alerts and batched notices, while failed jobs retry and remind on a durable widening cadence instead of going silent or flooding the user.

## The problem in one breath

The server can run in two valid Telegram arrangements: it can receive messages itself, or Lifeline can receive them while the server keeps a send-only connection. The send-only arrangement constructed a perfectly usable sender but failed to hand it to the scheduler and several other outbound consumers, so a job could reach 253 consecutive failures without producing the alert its scheduler believed it had sent. The old alert rule also fired only at the exact threshold, which meant a missed attempt was missed forever.

## What already exists

- **One scheduler owner** — only an awake scheduler runs jobs, with the existing claim and lease machinery preventing two machines from owning the same run concurrently.
- **Two Telegram startup modes** — server-polling receives and sends; send-only leaves polling to Lifeline but can still send through the same adapter type.
- **Scheduled-job failure counts** — the scheduler already records consecutive failures and knows when a job recovers.
- **Notification batching and Threadline mirroring** — both are outbound consumers that need a send-capable adapter but do not care which process owns inbound polling.
- **Degradation reporting** — the runtime already has a durable way to make a broken subsystem visible without crashing the process.

## What this adds

The central change is one production topology resolver followed by a single post-branch send-side composition seam. The resolver covers explicit send-only, read-only standby laptop, Lifeline-polling owner, and server-polling owner arrangements. Every mode with a real Telegram adapter passes it through the seam, which attaches it to the scheduler and notification batcher. Startup then explicitly marks composition complete even when Telegram is intentionally unconfigured, so a missing-sink episode remains loud and retryable across restart instead of being mistaken for incomplete startup. Every process may prepare the Threadline bridge so promotion works without restart, but each individual mirror consults the live awake-and-lease-holder predicate before creating a topic, sending, or persisting a binding. The scheduler role-guard notification path remains available in both modes. The polling decision now controls only polling.

The scheduler's failure-alert rule becomes a small persistent state machine with scheduler-owned wakeup timers. At or beyond the priority threshold, it attempts delivery immediately. If delivery is unavailable or fails, the scheduler wakes the episode at 5 minutes, then 15 minutes, then once per hour even if the job itself does not run again. After a successful delivery, scheduler-owned unresolved reminders widen to 1 hour, 6 hours, then once per 24 hours. Restart and resume rehydrate the next timer for both configured-sink and missing-sink episodes; stop and recovery cancel it, and recovery deletes the episode so a later failure begins cleanly.

## The new pieces

- **Common send-side composition** — accepts the selected startup mode and the real Telegram adapter, then performs every polling-independent dependency handoff once. It does not start polling and cannot change which process owns inbound messages.
- **Shared missing-sink failure reporting** — turns an absent or failing notification sink into an explicit degradation record and error line. It does not choose retry timing; the component that owns the notification keeps that authority.
- **Persistent scheduler alert episode** — records attempts, successful deliveries, the last failure context, and the next eligible time per failed job. It owns the timer that wakes each attempt, and selects one delivery route: a job-specific Telegram topic when present, otherwise the generic messenger, never both.
- **Self-action convergence model** — subjects permanent delivery failure to the repository-wide self-action ratchet, proving that restart does not reset the cadence and that attempts retain a hard five-minute minimum spacing.

## The safeguards

**Prevents branch-shaped silence.** Composition tests feed the production topology resolver all four startup arrangements—including the standby laptop—and pass its result with a real adapter object into the shared seam, then prove that the scheduler and batcher can actually send through it. A structural assertion also enumerates every polling-independent handoff that formerly lived in the polling branch: scheduler messenger, scheduler Telegram topic delivery, notification batcher, Threadline bridge, and scheduler role guard. Topic memory is separately handed over only after its database opens.

**Prevents alert floods.** The implementation does not use a bare greater-than-or-equal comparison. Durable next-eligible state and scheduler-owned timers enforce 5-minute, 15-minute, and hourly retry spacing for failed deliveries, plus 1-hour, 6-hour, and daily reminders after a successful delivery. A per-job in-flight guard collapses overlapping callbacks; restart and scheduler resume rehydrate one timer, while stop and recovery cancel it.

**Prevents double delivery.** When both generic and topic-aware routes exist, topic delivery has explicit priority and the generic route is not called. Across machines, existing scheduler ownership and job-claim gates keep a single active job owner; the alert cadence state belongs to that owner and survives process reconstruction on that machine. The Threadline bridge checks live ownership on every inbound and outbound mirror, including immediately around effectful calls, so awake-to-standby demotion silences the old machine and promotion enables the new owner without reconstruction.

**Prevents hidden configuration failure.** Both the scheduler and notification batcher use the same loud missing-sink reporting primitive. The scheduler distinguishes “startup composition finished with no sink” from “composition has not finished yet,” so the former is observable and continues its bounded retries across restart and pause/resume rather than looking like successful delivery or disappearing.

## What ships when

This ships as one patch release because the branch composition, alert state machine, loud-failure behavior, tests, and release note form one safety unit. Releasing only the comparison change would create the flood Echo warned about; releasing only the startup wiring would leave historical over-threshold failures permanently missed.

## What you actually need to decide

Should this bounded, topology-independent scheduler alert delivery behavior become the patch-release default?
