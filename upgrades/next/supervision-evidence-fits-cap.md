# Script jobs with many warnings no longer fall back to expensive sessions

<!-- bump: patch -->

## What Changed

After a script job runs, the scheduler builds a short summary (at most 2,000 characters) for the result reviewer. When a job reported many conditions, such as the health check on a server with a dozen warnings, the summary went over the limit, the scheduler treated that as a broken script, and held the job. A held job runs as a full AI session instead of its script. The summary is now packed to fit: the result, named readings and outside confirmation are always kept, warnings are listed while they fit with a plain count of any left out, and the free-text tail gets the room that remains. A summary with warnings left out is never treated as enough for routine closure. Scripts that really break the contract are still refused as before. A job already held for this reason stays held until its hold is released with a recorded reason.

## What to Tell Your User

- **Cheaper health checks**: "The health check was sometimes stuck running as a full AI session when the server had many small warnings. It now stays on its cheap script route."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Job evidence packed to its size limit with an explicit omitted count | Automatic |

## Evidence

Tests: `tests/unit/job-supervision-evidence.test.ts` — 100 anomalies fit under the cap with `anomalies-omitted` and routine closure refused; the live health-check shape (12 anomalies, 5 fields, long tail) keeps every anomaly and shortens the tail. Both fail on the old code and pass now (7/7). Adjacent supervision tests 19/19.
