# The feedback drain earns its fleet move on real numbers — Plain-English Overview

> The one-line version: the feedback drain could "pass" its readiness bar with a single good run, and about one run in eleven was recorded as failed only because the server was too busy to answer the job's first question. Now the bar needs 7 days of mostly-successful runs plus merged fixes, and a too-busy server is recorded as a skipped run instead of a failure.

## The problem in one breath

The feedback drain is the part of Instar that takes incoming bug reports, groups them, decides which are ready, and hands them to the fixer. Its maturity ladder said it was ready to go to every agent. Two reviewers (Claude Opus 5.5 and GPT-6-Astra) refused: the bar it passed was "at least one finished run in the last day", read only from the last run, so one good run was enough. Meanwhile its job history for Nov 4–11 showed about 9% of runs failing (9 of 38 on Nov 11), nearly all with "drain status unreadable: HTTP unreachable (timeout)". The job asks its own server for the drain status before starting a run and gave up after 10 seconds. On a busy machine the server can take longer than that, so no drain run ever started and the job called it a failure.

## What already exists

- **A durable record of every drain run.** The drain keeps each run and how it ended in its own database, kept for 30 days. It survives restarts. In the last 7 days it holds 257 finished runs: 253 succeeded, 2 had nothing to do, 2 were abandoned.
- **A durable record of every fix PR.** The fixer writes "PR opened" and "PR merged" lines to its audit log. 23 PRs have been opened so far; none has merged at its approved head yet.
- **A way for a job to mark its own run failed** (it writes a reason to a per-run file the scheduler reads). There was no matching way to mark a run skipped from a session-run job.

## What's new

1. **A real readiness bar.** To move to every agent the drain now needs: at least 200 finished runs in the last 7 days, at least 97% of them succeeded (read from the run database, so a restart does not reset it); at least 3 feedback PRs merged at their approved head in the last 30 days; and the existing check that the readiness judge's error rate stays at or below 5%.
2. **The job tolerates a busy server.** The first status read now waits 10 s, then 20 s, then 30 s, with short pauses between. Only a read that times out all three times stops the run, and that run is recorded as skipped ("server too busy"), not failed. A refused connection, a wrong answer, or a broken drain still fails exactly as before.
3. **Skipped runs are recorded as skipped.** A session-run job can now write a reason to a second per-run file and the scheduler records the run as `skipped`: it does not count as a success, does not count as a failure, leaves the failure streak and the last error where they were, and does not clear a pending failure alert or count toward the "job went silent" watch. The cheap script version of the job reports `skipped status-busy` the same way.

## Safeguards

- Skips cannot hide a slow server from the bar. A skipped run starts no drain run, so it adds nothing to the 200-run minimum: a server too busy most of the time keeps the drain from passing.
- A failure always wins: if a run wrote both a failure and a skip, it is recorded as failed.
- Only a timeout counts as "busy". A server that is down still fails the run.
- The drain stays on for the development agent only. Nothing in this change turns it on anywhere else.

## What you need to decide

Nothing. This raises the bar the drain must clear before it moves, and makes the job's record honest. Expect the ladder to show it holding until fix PRs start merging.
