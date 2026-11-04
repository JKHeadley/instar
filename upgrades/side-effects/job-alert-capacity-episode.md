# Side-Effects Review — Job capacity and calm alerts

**Version / slug:** `job-alert-capacity-episode`
**Date:** 2026-11-03
**Author:** echo
**Second-pass reviewer:** independent Codex reviewer

## Summary of the change

Tier 1, reversible: the session manager reserves one existing reroute slot for scheduler jobs; the scheduler treats typed capacity refusals as waits, retries from its priority queue, persists one episode, and routes bounded plain notices through the user-notice catalog. The change touches session admission, machine claim completion, scheduler queue admission, and job alert delivery. About 11 files and 300 changed lines; one design pass, one independent review with fixes, and one planned commit attempt.

## Decision-point inventory

- `SessionManager.evaluateRerouteGate` — modified: conversation admission stops one slot earlier on hosts with at least two slots; memory pressure remains authoritative.
- `JobScheduler` spawn catch and queue drain — modified: typed refusal is a wait; recovered jobs take a fresh claim.
- `JobScheduler` episode alert — added: critical waits reach a 10 minute ceiling, others 30 minutes, with a single delivery after a dead-session check.
- Job failure alert renderer and sink — modified: raw errors are mapped to a bounded notice and the job topic or Attention is used when Telegram is configured.

## 1. Over-block

A sixth direct conversation on a six-slot host now waits even if no scheduled job is queued. This is intentional reserve capacity for Health Check; it can be relaxed by reverting the change. A one-slot host has no reservation. Elevated memory pressure still blocks all new reroutes.

## 2. Under-block

A host already holding six conversations cannot be instantly fixed by a new reservation; one must end. A process crash between a Telegram send and recording its delivered timestamp could repeat the episode notice after restart. This is the same ambiguous-delivery boundary as the existing alert system. A queue capped at 50 can still drop additional jobs; that produces an internal warning.

## 3. Level-of-abstraction fit

The scheduler owns cron triggers, job priority, state, and notices. The session manager owns the host-wide reroute and memory cap. The change reuses both authorities. The typed error is a structural signal, not a text classifier. Proven-dead session recovery uses the existing liveness oracle and reap authority.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). The reservation is a deterministic resource invariant within the session admission authority, not a guess about message meaning. The scheduler consumes the typed refusal; it does not add a competing message gate. Its plain-notice classifier only chooses wording and never controls whether a job fails or a user message is blocked.

## 4b. Judgment-point check

No static heuristic decides among competing user intentions. Urgency comes from the job's declared priority. The capacity threshold is a bounded host resource policy; the 10 and 30 minute clocks are notice ceilings, not a semantic judgment about an error string.

## 5. Interactions

The scheduler releases a refused run's multi-machine claim as `waited`; a queued retry enters normal admission and claims again. A cron trigger that starts the same job removes its wait entry. The 15 second poll admits one job per tick, and existing `maxParallelJobs` remains in force. The dead-session sweep only reclaims sessions proven absent; it does not perform boot-only reconciliation of live rerouted sessions. The notice send checks its persisted episode before marking delivered.

## 6. External surfaces

Telegram sees fewer per-job alerts and, for persistent blockage, one Attention message. Real failure messages are shorter and never expose a raw command or error. A direct conversation spawn may be refused at five of six slots. No new operator action, route, or URL is added. The user can close an unneeded conversation from existing phone surfaces. The job capacity episode is durable state, written by the scheduler.

## Operator surface

No dashboard renderer or new operator action is changed. Existing conversation management is the surface for closing an unneeded conversation.

## 7. Multi-machine posture

Machine-local by design: capacity and memory pressure are truths about this host. The existing job claim mechanism prevents two machines from starting the same recovered job, and its completion now records `waited` for a refused attempt. The notice uses this machine's Attention hub; existing one-voice ownership remains with the Telegram adapter and scheduler's job claim. Episode state stays with the machine whose job was refused; no topic transfer or generated URL is involved.

## 8. Rollback cost

A code revert restores prior cap and alert behavior. The added `job-capacity-episode` state is ignored by old code and can be cleared after rollback; no migration is required. Job claim records with result `waited` remain completed and do not hold a lease.

## Second-pass review

Concur with the review. The reviewer found and verified fixes for overlapping queue admissions, transient skip retention, per-job alert clocks, and clearing a capacity wait after a real spawn error.

## Class-Closure Declaration

`unbounded-self-action`: guard. The capacity controller polls every 15 seconds while blocked, admits at most one waiting job per poll after room opens, and sends at most one persisted episode alert. Under sustained saturation it launches no jobs and stops notifying after that one alert. The self-action convergence ratchet models this brake across restart; the live scheduler tests verify retry pacing, priority, and one-message delivery.
