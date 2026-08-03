<!-- bump: patch -->

## What Changed

Scheduler failure alerts now use the Telegram adapter in both server-polling
and Lifeline-owned send-only startup modes. Polling-independent handoffs for
scheduled-job alerts, batched notifications, Threadline mirroring, and the
scheduler role guard now converge after startup topology selection. The
stateful Threadline bridge consults live awake-role and lease ownership on
every mirror, so demotion silences the old machine and promotion enables the
new owner without restart. Topic memory is handed to the scheduler only after
its database is ready.

Failure escalation now remains eligible after the original threshold has been
missed. Undelivered attempts use persistent bounded retry backoff, successful
alerts use a widening reminder cadence while the failure remains unresolved,
and scheduler-owned timers wake those attempts even when the job itself does
not run again. Restart and scheduler resume rehydrate the next timer for both
configured and missing sinks; stop and recovery cancel it. Startup marks alert
composition complete even when Telegram is intentionally unconfigured, so a
missing delivery sink remains an explicit, bounded, durable degradation
instead of a silent no-op that disappears after restart.

## What to Tell Your User

- **Scheduled-job alerts work when Lifeline owns Telegram polling:** “The
  server can still send job-health alerts even though another process receives
  Telegram messages.”
- **A missed threshold is recoverable without notification floods:** “An
  unresolved job failure will retry on a bounded schedule and remind me less
  often over time.”
- **Delivery misconfiguration is visible:** “If the alert channel is not wired,
  the system records a clear degradation instead of silently discarding the
  notification.”

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Send scheduler alerts in either Telegram ownership topology | No configuration change is needed; startup now wires the common send side automatically |
| Recover alerts already beyond their failure threshold | The scheduler retries the unresolved alert according to persisted backoff state |
| Avoid repeated alert floods | Successful unresolved alerts follow widening reminder intervals until recovery |
| Diagnose missing notification wiring | Inspect the recorded delivery-sink degradation and scheduler delivery event |

## Evidence

Composition tests exercise explicit send-only, standby laptop,
Lifeline-polling, and server-polling startup arrangements through the production
topology resolver with a real Telegram adapter object, proving that scheduler
and notification batcher can send. A live handoff test proves the Threadline
bridge stops on demotion and resumes on promotion without reconstruction.
Structural assertions pin every polling-independent handoff after
topology selection and the topic-memory handoff after database initialization.
State-machine tests cover failure count 253, timer-owned missing-sink backoff,
timer-owned successful reminders, configured- and missing-sink restart/resume rehydration, stop/recovery
cancellation, recovery/send races, single-sink selection, and overlap
coalescing. The affected
scheduler and notification suites, TypeScript compiler, repository policy
lint, and build all pass.
