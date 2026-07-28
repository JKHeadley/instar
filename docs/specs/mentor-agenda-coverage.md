---
title: Mentor agenda coverage — stop re-driving already-verified tasks
slug: mentor-agenda-coverage
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-self-review-2026-05-31
approved: true
approved-by: Echo under the 12h autonomous deploy mandate (self-approved; flagged in PR). Diagnosed live (mandate task 6 — optimize the mentor-onboarding job): the mentor was re-assigning its exhausted 6-task agenda on a loop, making the mentee re-verify the same capabilities every ~15 min with almost no new findings.
approval-note: >
  The mentor's Stage-A composer judges "already covered" only from the bounded
  `threadlineHistory` window (last ~8 turns). Once an assignment scrolls out of
  that window the item looks fresh again, so the mentor re-drives it — Codey kept
  re-verifying Project Map / Reap-Log / etc. in a cycle (observed: Reap-Log
  assigned 14×, Project Map 10×). This computes a compact coverage list
  (`recentlyDrivenAgenda`) from the mentor's own recent sent prompts — which
  survives the window — and feeds it to Stage A so it PREFERS not-yet-driven items
  and chooses observe-only when the whole agenda is covered, instead of re-cycling.
second-pass-required: false
second-pass-status: n/a-contained-mentor-task-selection-change-both-sides-unit-tested-no-runner-wiring-needed
eli16-overview: mentor-agenda-coverage.eli16.md
---

# Mentor agenda coverage — stop re-driving already-verified tasks

## The issue, grounded (mandate task 6 — optimize the mentor job)

The Framework-Onboarding Mentor drives the mentee through its
`mentor.onboardingAgenda` (a list of "Verify the X" tasks). Stage A
(`buildStageAContext` in `src/monitoring/MentorStageA.ts`) decides the next action,
and its prompt says: pick "the NEXT agenda item not already covered **in the
conversation above**." But "the conversation above" is the bounded
`threadlineHistory` (last ~8 turns, capped at 6 KB). Once an assignment scrolls out
of that window, the item is no longer visible as "covered" → Stage A re-assigns it.

Observed live (driving Codey): the mentor cycled the same 6 agenda items
repeatedly — Reap-Log assigned 14×, Project Map 10×, Attention Queue 9× — so Codey
kept re-verifying already-checked capabilities and produced almost no new findings
(the gate fail-open #629 came from a FRESH verify; re-verifying yields little).

## Fix

Give Stage A a compact coverage list that survives the window:

- **`buildConversationSurface`** now computes `recentlyDrivenAgenda` — the agenda
  items whose leading stem (the part before any `(`, e.g. "Verify the Project Map")
  appears in the mentor's recent sent prompts (`mentorSent`, already passed in). No
  new state, no runner wiring — derived from existing data.
- **`buildStageAContext`** adds a "Recently driven" block (shown only when
  non-empty) and steers the LLM: prefer an agenda item NOT in that list; do not
  re-assign a recently-driven item; if EVERY agenda item is recently driven, choose
  observe-only instead of re-cycling. When nothing has been driven (fresh start),
  the original "next agenda item" steering is unchanged.

As the recent-sent window scrolls, an old item ages out of `recentlyDrivenAgenda`
and becomes drivable again — a natural cooldown that still permits periodic
re-verification without the every-tick re-cycling.

## Safety / blast radius

Contained, mentor-only. `recentlyDrivenAgenda` is a SUBSET of `onboardingAgenda`,
so it is already covered by `surfaceText` → no new leak surface (the
`detectStageALeak` two-hats detector is untouched). When the coverage list is empty
(no agenda, or nothing driven yet), behavior is byte-for-byte unchanged. Only
mentor-enabled agents are affected, and only in which agenda item Stage A prefers.
The empty tool grant, the spawn path, and history-bounding are unchanged.

## Migration parity
N/A — code-only, compiled into `dist`; ships in the normal release. No
agent-installed file / config / template change → no `PostUpdateMigrator` pass. (My
agent's own `mentor.onboardingAgenda` was separately widened from 6→12 items via a
live config edit; this PR is the structural fix so the mentor stops re-cycling
whatever agenda it has.)

## Agent Awareness
N/A — internal mentor task-selection; no new endpoint or capability.

## Test plan
Unit (`tests/unit/MentorStageA.test.ts`, +4): `buildConversationSurface` flags
driven items (and not undriven ones) from `mentorSent`; `buildStageAContext` lists
the driven items + steers to prefer fresh ones; the all-covered case steers to
observe-only; the no-coverage case omits the block (unchanged). The existing
agenda-steering test was updated to the new wording. `tsc --noEmit` + `npm run lint`
clean; all 31 MentorStageA tests pass.
