# Side-Effects Review — Global session capacity for scheduled jobs

**Version / slug:** `job-alert-global-cap`  
**Date:** 2026-11-03  
**Author:** echo  
**Second-pass reviewer:** independent Codex reviewer

## Summary of the change

Tier 1, reversible correction after live evidence on Studio: twenty running conversations caused Health Check to fail at the global session limit before the reroute gate. A typed global refusal now enters the capacity episode. The session manager lends one bounded place to a scheduled job when memory is below the high tier; pending admissions are counted so simultaneous jobs cannot both borrow it. The scheduler suspends old failure reminders during that wait. Approximately eight files and 130 changed code and test lines, plus short release artifacts; one design pass, one reviewer pass, and one commit planned.

## Decision-point inventory

- `SessionManager.spawnSession` owns the soft and hard session limits and emits the new typed refusal. Its pending counter closes simultaneous admission races.
- `SessionManager.confinedRerouteCapacity` reports saturation from the global limit as well as the reroute lane, so the existing job queue waits rather than retrying a known-full host every poll.
- `JobScheduler` recognizes the typed global refusal and uses the existing durable capacity episode. It suspends a stale per-job failure reminder until a real retry result arrives.

## 1. Over-block

If memory is high, the borrowed place closes even when a critical job is waiting. This is deliberate: the rerouted lane's existing memory gate would refuse the same launch, and adding a session under high pressure would recreate the host risk. When another scheduled job is running, the loan is unavailable until that job finishes. A conversation remains possible under the existing operator path.

## 2. Under-block

The one-job loan does not force a running conversation to end. A host already at the hard absolute limit or above the memory threshold still cannot start a job; the episode's ten-minute critical or thirty-minute other notice remains the alarm. The global refusal class covers this admission point; unrelated real spawn errors continue through the failure path.

## 3. Level-of-abstraction fit

The session manager already owns admission and memory pressure. It makes the bounded loan decision there, while the scheduler owns retry order and notices. A class, rather than the changing error text, tells the scheduler to wait. The queue and alert logic from the preceding release are reused.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). The new refusal is a structural resource signal from the existing admission authority. The scheduler does not infer capacity from a string or create another independent gate. The one-place loan is a bounded resource invariant, conditioned on the existing memory tier and absolute limit, rather than a judgment about a conversation's importance.

## 4b. Judgment-point check

The job's declared scheduler provenance is the only eligibility signal. Job priority remains with the scheduler queue. No semantic text classifier decides whether to stop a session, admit a job, or alert Justin.

## 5. Interactions

Pending headless launches count during admission; this is conservative until each launch settles. One pending or running scheduled job owns the loan. The reroute lane still limits subscription sessions and refuses under high memory pressure. Capacity waits release their machine claim and regain it at retry. A prior failure reminder stops during a capacity wait; if the later spawn really fails, normal alert state starts again.

## 6. External surfaces

Health Check and other scheduled jobs can now wait silently at the global session limit. There is no new topic or message format. The existing episode notice remains in Attention. Direct `/sessions/spawn` calls cannot claim the scheduled loan by merely supplying a job slug; the scheduler trigger marker is required.

## Operator surface

No new control is added. Existing conversation management remains available if Justin chooses to close one.

## 7. Multi-machine posture

Machine-local by design: session count and memory pressure are measured per host. The existing multi-machine job claim and wait-release path determine where a retried job can run. The notice uses the existing one-voice Telegram path; no state is moved between topic owners.

## 8. Rollback cost

Reverting this correction restores the previous global admission rule. The typed error has no persistent format, and the already existing capacity episode state is compatible with the previous release. No migration or cleanup is needed.

## Second-pass review

Concur with the review. The reviewer checked the typed refusal, the simultaneous-loan race, the absolute and high-memory limits, and the old failure reminder behavior. Tests cover direct-spawn refusal, a single scheduled loan, high pressure, simultaneous requests, and typed-versus-text scheduler handling. No concrete regression was found in this diff.

The full verifier exposed one stale end-to-end assertion in `tests/e2e/job-run-history-lifecycle.test.ts`: it required a numeric success rate even when all runs were still pending. The existing API contract returns `null` until a run completes. The assertion now checks both states against that contract; no production stats behavior changed.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: guard`, `enforcementType: ratchet`, citation: `tests/unit/job-capacity-episode.test.ts`. A global-cap refusal enters the existing durable capacity episode. The tests require silence for individual refused jobs, at most one episode notice, and one queued retry per poll after capacity returns. Pending admission counts allow only one borrowed scheduled slot, so repeated polling cannot create an unbounded launch burst.
