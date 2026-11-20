# B-lite trial: bugs-overseer on low effort for 48 hours

Decided by Justin, topic 141868, 2026-11-11 18:40 PST ("B-lite, but lets make it a two day trial instead of a week"). The trial is descriptive only and not controlled.

## Method

- **Why not the cost report:** Instar's cost report (`/jobs/cost`) attributes zero tokens to every job, because the scheduler is never wired to the token ledger. That is filed as a bug.
- **Matching runs to tokens:** `measure.py` pairs each bugs-overseer run, from the lease holder's run history, with the one transcript that starts 0–30 s after the run in the agent's own project. A run with zero or several candidates stays unmatched; nothing is guessed.
- **What "tokens" means here:** the ledger's `totalTokens` for that session, which includes cache reads. Cache reads dominate.

## Before (engine default, 2026-11-10 04:00Z → 2026-11-12 04:00Z)

`before-48h.json`
- 24 runs: 22 success, 0 failure, 2 still pending at read time.
- 21 of the 24 matched a transcript. The other 3 each had two candidates, so they stay unmatched.
- 25.7M tokens in total. The mean is 1.22M per matched run and the median is 1.12M.

## After (low effort): 2026-11-20T21:35:00Z → 2026-11-22T21:35:00Z

Started 2026-11-20T21:35:00Z, when the scheduler loaded the restored bugs-overseer with `thinkingMode: "low"` (the loader's rescan after its instruction file got its YAML header). First low-effort run 22:07Z; runs every two hours at :07. Measure with `measure.py <auth-file> 2026-11-20T21:35:00Z 2026-11-22T21:35:00Z after-48h.json` on the lease holder.


Starts when `thinkingMode: "low"` is set on bugs-overseer (PR #3098 is merged). The Nov 2026 Studio rebuild lost the job and two of its scripts, so the start waits until all three are restored; the start time is recorded here when it happens (commitment CMT-2071). It runs for 48 hours, and then `measure.py` runs over that window into `after-48h.json`. Each run's launch record must show `applied: thinkingMode low`, or that run is excluded and named.

`measure.py` now reads from `localhost:4042`; run it on the lease holder (the Studio's address changed in the rebuild).

## Limits

- This is not a controlled experiment: the two windows see different bug traffic, and the engine version may differ (the launch record names it).
- The job itself differs between the windows. The before window ran the old Studio's bugs-overseer with its two helper scripts (`bugs-intake.mjs`, `bug-topic-close.sh`). Both scripts were lost in the Nov 2026 Studio rebuild (never committed, never synced; searched on every machine) and are being rewritten from the job instructions, so the after window runs the restored job with rewritten scripts. Some of any difference may come from the rewrite, not from the effort setting.
- About 24 runs per side.
- A big drop in tokens with no rise in failures supports trying low effort on more routine jobs. Anything else means stopping there.
