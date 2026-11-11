# Side-Effects Review — interrupted script runs no longer become permanent holds

**Version / slug:** `cmt-1610-interrupted-script-run-hold`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1. 4 source files (~250 added lines), 4 new test files. One build pass, no spec review rounds (Tier 1, PR is the review surface).

When the server restarts while a scheduled script job is mid-run, that run stays `pending` in run history forever and its supervision attempt never completes. At the next start, the restart census in `JobScheduler.scriptRunnersActiveFor()` read that as a ledger mismatch and wrote `held_slugs(slug, 'independent-history-mismatch')`. Holds had no release, so the job fell back to its session runner for good (Echo: health-check spawning a Haiku session every 5 minutes since 2026-11-11T06:08Z; llm-decision-grading held since 2026-11-04T01:00Z).

Changes:
- `src/scheduler/JobSupervisionStore.ts`: `settleInterruptedRun()` closes an attempt with no completion as `result=failure, reason=interrupted` (inserts a recovered row if the process died before registration; never touches an attempt that already has a completion). `releaseHold()` removes a hold and writes an audit row to a new `held_slug_releases` table (who, why, original reason and time). `holdReleases()` reads that trail.
- `src/scheduler/JobScheduler.ts`: the census is factored into `supervisionCensus()`. A pending script run that this machine recorded and this process does not own is settled first: history completed as `failure` with error `interrupted: the server stopped before this script finished`, and its attempt closed the same way. Real mismatches still hold. After the census, a hold whose reason is the census reason and whose slug the same census no longer finds mismatched is released with `released_by=census`. `releaseSupervisionHold()` is the explicit release: refused (`cause-unsettled`) while the census still finds a mismatch for that slug, recorded otherwise, and logged as a `job_supervision_hold_released` activity event.
- `src/server/routes.ts`: `GET /jobs/:slug/supervision-hold` (hold + release history) and `POST /jobs/:slug/supervision-hold/release` (`reason` 1–500 chars required; the record names the authenticated principal, `agent`, never a label from the request body).
- `src/core/PostUpdateMigrator.ts`: one CLAUDE.md paragraph ("Held script routes") in the script result supervision section, added to existing agents by a content-sniffed migration; new agents get it through the template, which already renders the section.

## Decision-point inventory

- Script-route admission (`scriptRunnersActiveFor`) — modify — an interrupted run is no longer counted as a mismatch once both ledgers are settled; every other mismatch condition is unchanged.
- Census hold release — add — automatic release of a census hold only when the same census check passes.
- Explicit hold release route — add — authenticated, reason required, refused while the cause persists.

---

## 1. Over-block

Less over-block than before: an interrupted run no longer holds the job. The remaining over-block: an explicit release of a non-census hold (for example `write-failed:...`) is refused when an unrelated mismatching run for that slug exists. That is correct — the slug really does have an unsettled run.

## 2. Under-block

- A run still alive in an *overlapping* server process on the same machine (rolling restart) is not settled: the census defers any pending run younger than its longest possible lifetime (start-offset jitter + the script's hard kill bound of 2 × `scriptTimeoutMinutes` + 1 minute). A deferred job is blocked in memory only, with no durable hold, and a single recheck per job runs once that window has passed (raised in second pass).
- A run recorded with no `machineId` is treated as this machine's. Run history always stamps `machineId` when the scheduler knows it; history rows without one predate machine identity and are local by construction.
- A settle that closed the attempt but whose history write failed is retried on the next census (the store reports an existing interrupted settlement as closed), so it cannot become a new permanent hold (raised in second pass).
- History completed but attempt still `pending` (death between the two completion writes) stays a mismatch and holds, as before. That case is rarer and is a real ledger disagreement; it can now be released with a recorded reason once inspected.

## 3. Level-of-abstraction fit

Right layer. The scheduler owns both the run history and the supervision journal and is the only component that knows which runs this process owns (`activeScriptRunIds`). The store gets plain, single-purpose writes; the decision stays in the scheduler census that already made the hold decision.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface over agent or user actions.

The hold is an existing deterministic safety floor on the script route (fail closed to the prior session runner). This change narrows what counts as a mismatch to exclude a settled interruption and adds a release that requires the same check to pass. No brittle check gains authority; the release path is bounded by the census rather than by a heuristic.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. "Process gone and run never settled" is an enumerable invariant: the run is pending, not owned by this process, and recorded by this machine.

## 5. Interactions

- `JobSupervisionStore.reconcileHistory()` (AgentServer startup, `/jobs/triage`) marks abandoned pending attempts `outcome-unknown`. Either order works: if it runs first, the census settles the `outcome-unknown` row (it has no completion); if the census runs first, history is no longer pending and reconcile skips it.
- `claimable()` never picks interrupted rows (no evidence hash, reason not retryable), so no Jev/replacement call is made for them.
- `supervisionWriteFailed` / `supervisionContractViolated` holds are untouched and never auto-released.
- Job state (`lastResult`) of the interrupted run is not rewritten; only run history and the attempt are settled. The next fire writes fresh job state.

## 6. External surfaces

- Two new authenticated routes under the existing `/jobs/:slug` prefix.
- Run history gains `failure` rows with an `interrupted:` error for runs that were previously stuck `pending`. Failure stats for those slugs rise by the number of interrupted runs (on Echo: 2). That is the truthful count.
- A one-time console line per settled run and per released hold.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: run history, the supervision journal and the hold table are per-machine ledgers under `.instar/ledger/`, and only the machine that started a run can know its process is gone. The census only settles runs whose `machineId` is this machine; another machine's pending run is left alone and still counts as a mismatch. The new routes answer for this machine (a read-only standby answers 409). No user-facing notices, no URLs, no topic-bound state.

## 8. Rollback cost

Revert and ship a patch. The new `held_slug_releases` table is additive (`CREATE TABLE IF NOT EXISTS`) and harmless to older code, which never reads it. Settled history rows stay settled after a revert (older code reads them as ordinary failures, which no longer hold). No agent repair needed.

---

## Conclusion

Clear to ship. Fleet behavior is unchanged except for the same correctness fix: the census already runs on every agent with script jobs (before the development-agent gate is read), and the fix only changes what a restart does to an interrupted run and how a hold can be released. Which runner a fleet job uses is still decided by the existing gates.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (code read, two rounds)
**Independent read of the artifact: concur** (round 2)

Round 1 raised concerns, all resolved in this change:
- A settle that closed the attempt but whose history write failed would have become a new permanent hold → the store now reports an existing interrupted settlement as closed and the census retries the history write (test: "finishes a half-settled run").
- A run still executing in an overlapping server could be settled as failed → runs younger than their longest possible lifetime are deferred, blocked in memory only, and rechecked once (test: "defers a run that may still be live").
- The release route trusted a `by` label from the request body → it now always records the authenticated principal, `agent`.

Round 2 concurred, with a minor note taken: an unreadable census at recheck time now reschedules the recheck (5 minutes) instead of leaving the job blocked until the next restart. Not taken: the deferral window reads the job's current timeout (low risk; a shrunk window only shortens the wait).

---

## Evidence pointers

- Live ledger on the Echo Studio (read-only, 2026-11-11 00:45 PST): `held_slugs` rows `health-check|independent-history-mismatch|2026-11-11T06:08:40Z` and `llm-decision-grading|…|2026-11-04T01:00:56Z`; attempts `health-check-mwbpoq21-6` (registered 06:01:56Z, no completion, outcome-unknown at 06:10:53Z) and `llm-decision-grading-mw1ethcv-5` (expired-unchecked, outcome-unknown, no completion); both runs still `pending` in `job-runs.jsonl`.
- `tests/unit/job-cost-runner/JobScheduler-post-gate-definition.test.ts` planted a census-reason hold with no mismatching run behind it; the census now lifts such a hold, so that test uses a hold reason the census does not own (`write-failed:test-ledger`) to keep its intent (a held job runs as its session).
- Tests: `tests/unit/job-supervision-store-interrupted-and-release.test.ts`, `tests/unit/job-cost-runner/JobScheduler-interrupted-script-run.test.ts`, `tests/integration/job-supervision-hold-routes.test.ts`, `tests/e2e/job-supervision-interrupted-run-lifecycle.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — this is a runtime ledger-logic defect. The census release is a self-triggered action; its convergence: it runs once per server process at the first script admission (control-loop edge: process start), releases at most one row per held slug (steady-state bound: number of held slugs), and only when the same check that wrote the hold now passes, so it cannot oscillate (settling brake: a still-mismatched slug is re-held, never released).
