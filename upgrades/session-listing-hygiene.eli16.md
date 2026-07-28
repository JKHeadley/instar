# Session Listing Hygiene — plain-English overview

## What this actually is

When you ask your agent "what sessions are running?" — or open the dashboard — the answer was polluted: on 2026-07-09 the Mac Mini reported 53 sessions, and 52 of them were FINISHED background chores (little 5-minute mentor runs and scheduled job checks) that had already ended but were still sitting in the list. Both machines also run the same scheduled jobs on purpose, so the wall of near-identical names looked exactly like "the same session running twice across my machines" — a scary bug that wasn't actually happening.

This change makes the session list tell the truth in three ways:

1. **The list shows what's RUNNING.** `GET /sessions` now answers with active sessions only. The finished ones aren't deleted from view forever — add `?include=all` and you get the whole registry, exactly as before.
2. **Finished records get cleaned up on a real schedule.** Finished background runs are pruned after an hour, finished conversations after a day, and there's a hard cap of 50 retained records no matter what. Two genuine leaks are fixed: records of FAILED sessions were never cleaned up at all, and a record missing its end-timestamp was kept forever. Every window is tunable in config (`sessions.retention`) if you want longer history.
3. **A REAL duplicate now shouts.** The cross-machine view computes the one case that actually matters: the SAME conversation with a LIVE session on two machines at once. That gets a red "duplicate" badge on the dashboard and a `pool.duplicateTopics` entry in the API. The benign look-alike — each machine running its own copy of a scheduled job — is never flagged, because that's how the system is designed to work.

## What already existed

A cleanup pass already pruned some finished records (jobs after 1 h, conversations after 24 h, cap 50) — but the mentor-run shape slipped into the 24 h bucket, `failed` records slipped through entirely, and the listing itself never distinguished finished from running. The dashboard privately filtered finished rows out of its tiles; the API (what the agent itself and the pool view read) did not.

## The safeguards, in plain terms

- Nothing running is ever touched — only records of sessions that already ended.
- Old machines and new machines can mix during rollout: the merged view filters an old machine's unfiltered answer, so no wall of stale rows sneaks back in.
- The duplicate badge is a signal only. It never kills or blocks anything — the existing safety layers own that.
- Rollback is cheap: config knobs restore any retention window; the listing change reverts with the PR.

## What you actually need to decide

Nothing — defaults are chosen to match the existing behavior everywhere except the two leak fixes and the mentor-run class (24 h → 1 h, the exact accumulation that caused the misread). If you want finished runs kept longer, set `sessions.retention.completedJobTtlMinutes` (or `completedTtlHours` / `maxFinished`) in `.instar/config.json` — it takes effect at the next server restart (the session manager reads its config once, at boot).
