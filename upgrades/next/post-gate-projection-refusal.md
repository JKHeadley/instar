<!-- bump: patch -->

## What Changed

A scheduled job with a gate that was running in its session form (a script job with its script runner off or on hold) was refused on every fire. After the gate, the scheduler compared the live job with the temporary session copy of it, which can never match, and reported `post-gate-definition-changed`. It now compares with the definition from before that copy was made. A job really edited during its gate is still refused. Refusals now name their cause: a new `definition-changed` skip reason, or `disabled`, `job-missing` or `portable-integrity`. A portable integrity failure is only recorded when the portable check failed. `definition-changed` also counts toward the alert for jobs that have gone quiet.

## What to Tell Your User

Some of my scheduled background jobs had stopped running since the last update, even though they looked fine, including the ones that work through feedback and turn it into fixes. They are running again now, so anything that was waiting on them will start moving.

## Evidence

From 2026-11-05T16:00:02Z, Echo logged 206 refusals: feedback-factory-triage 80, -process 48, -execute 45, -action-list 4, llm-decision-grading 29, with no real run of those jobs afterwards. `tests/unit/job-cost-runner/JobScheduler-post-gate-definition.test.ts` passes 14 of 14 with this change; on the previous scheduler it fails.
