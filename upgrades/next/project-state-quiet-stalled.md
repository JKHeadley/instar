# Projects the tracker could not judge now read "Quiet since …" or "Stalled since …"

<!-- bump: patch -->

## What Changed

`GET /work/projects` (and `/mobile/work/projects`) no longer shows "Not known yet" for a project whose checks run fine but whose judge could not reach a verdict. Those rows are settled from what the checks read: `state: "quiet"` with `stateWords: "Quiet since <time|yesterday|Mon D>"`, or `state: "stalled"` with `"Stalled since …"` once nothing has happened for max(48 h, 2 × the project's check cadence) while a done item is still open. `state: "unknown"` remains only when the checks could not read the project, and its words say why ("Not checked yet: …", "Couldn't check: no check has run since …", "Couldn't check: the last check could not read the project's evidence"). Each row gains `stateSince` (ISO; the last time anything was seen happening, set for quiet and stalled). A judge-given "stalled" now also reads "Stalled since …". `ChiefOfStaffLoop.projectsOverview()` adds `lastProgressAt`, `lastEvidenceChangeAt`, `lastCheckUnreadable` and `cadenceHours` per row. Day words use the agent's `timezone` setting. Display only: no Chief of Staff verdict, check, restart or message changes.

## What to Tell Your User

- **Every project has a clear status**: "Projects I track no longer say 'Not known yet' just because I could not tick off their done list. They now say 'Quiet since …' or 'Stalled since …', and I only say I couldn't check when I really couldn't, with the reason."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Quiet / Stalled since … project states with `stateSince` | Automatic on the Work door's Projects (dashboard, phone, Mac) |

## Evidence

Live Echo on 2026-11-19: 8 of 21 projects read "Not known yet"; each had daily checks that read its conversation and run records (cited evidence ids `run`, `owner-last`, `agent-last`, `tail`) with no verdict because every done item was plain words. Computed from the same live records with this change: 5 read "Stalled since Nov 13/15/17", 3 read "Quiet since 5:30 AM / yesterday / Nov 17". Tests: `tests/unit/work-projects-quiet-stalled.test.ts` (14: thresholds both sides, owner-checked items, older-loop fallback, stale checks, the real loop's `projectsOverview` over an in-memory journal) plus the existing `work-projects-read`, `work-door-project-rows`, `console-project-rows` suites: 70 passed.
