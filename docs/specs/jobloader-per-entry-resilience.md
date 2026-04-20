---
title: JobLoader per-entry resilience (skip-and-log invalid jobs)
review-iterations: 1
review-convergence: "converged"
approved: true
approved-by: dawn
approved-date: 2026-04-19
approval-context: "Autonomous fix for feedback cluster cluster-jobloader-crashes-entire-server-on-one-bad-job-supervisor-ci. Low-risk change: turns fail-fast into fail-soft at the entry level without touching any public API surface, validator logic, or persistence. Root cause was clearly identified by the reporter (electruck 2026-04-17) with a concrete proposal (Proposal A). Retrospective single-iteration convergence per the instar-bug-fix job grounding file's self-approval precedent for LOW-risk bugs."
---

# JobLoader per-entry resilience

## Problem

`JobLoader.loadJobs()` currently fails the whole load on the first invalid
entry (`src/scheduler/JobLoader.ts:58-61`, the `raw.map(...)` call that
propagates the `validateJob` throw). In production (commit `a4d7376` in
reporter's agent), one malformed entry in `.instar/jobs.json` — missing
`name` and `priority` and using an invalid `execute.type: "bash"` — crashed
the entire scheduler. `JobScheduler.start()` propagated the throw,
`startServer()` died before binding port 4041, and the lifeline supervisor
entered long-backoff without a user-visible alert. Ten healthy jobs plus
the HTTP API, dashboard, feedback pipeline, attention queue, and Telegram
poller all stopped because of one typo.

The failure mode is asymmetric: a single malformed entry takes down
everything. That is the opposite of what a resilient scheduler should do.

## Solution

Change `loadJobs()` so that `validateJob` errors on individual entries are
caught, logged, and skipped — the loader returns the valid subset.
Structural errors (missing file, unparseable JSON, non-array root) still
throw because those indicate nothing can be loaded at all.

`validateJob` is unchanged: callers that want to validate a single entry
(e.g., future CLI validators, test code) still get the original
throw-on-invalid behavior.

Logging:

- `console.error` per skipped entry, including the index, slug (if
  present), and the validation error message.
- `console.warn` summary line: `Loaded N valid job(s); skipped M invalid
  entry(ies). Fix the skipped entries to restore full scheduler coverage.`

This matches "Proposal A" from the feedback cluster verbatim.

## Scope

- `src/scheduler/JobLoader.ts` — `loadJobs()` only.
- `tests/unit/JobLoader.test.ts` — new test for the skip-and-log path.

Out of scope (explicitly deferred):

- Proposal B (supervisor escalation on circuit-breaker open) — separate
  concern in the supervisor layer.
- Proposal C (ship a CLI validator) — tracked separately; `validateJob` is
  left exported and throw-behavior preserved precisely so that a CLI
  validator can reuse it.

## Backwards compatibility

No behavior change for valid jobs files. A previously-crashing jobs file
now loads with skipped entries; any existing operator who relied on the
crash as a signal gets the same information via stderr plus a summary
warn. No public API changes (`loadJobs` signature and return type
unchanged; `validateJob` unchanged).

## Risks

- **Silent degradation.** A skipped job is a job that silently doesn't
  run. This is mitigated by (a) `console.error` per entry with slug and
  error, (b) the summary `console.warn`, and (c) the reporter's follow-on
  Proposal B (supervisor escalation) being tracked as a separate
  improvement. Net: the scheduler recovers; visibility is preserved.
- **Test churn.** One existing test case implicitly assumed throw; no
  such test existed — the only throw-tests are on `validateJob` directly,
  which remains unchanged. A new positive test is added for the skip path.

## Rollback

Pure code change. Revert the commit; next patch ship restores original
fail-fast behavior. No persistent state, no migration, no user-visible
regression during rollback.
