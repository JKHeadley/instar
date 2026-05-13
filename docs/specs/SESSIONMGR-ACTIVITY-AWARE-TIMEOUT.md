---
title: "SessionManager activity-aware timeout-kill"
slug: "sessionmgr-activity-aware-timeout"
author: "echo"
status: "approved"
date: "2026-05-13"
owning-repo: "instar"
owning-layer: "session lifecycle"
review-convergence: "2026-05-13T03:25:00Z"
review-iterations: 1
review-completed-at: "2026-05-13T03:25:00Z"
review-report: "upgrades/side-effects/sessionmgr-activity-aware-timeout.md"
review-external-models: []
approved: true
approved-at: "2026-05-13T03:25:00Z"
approved-by: "justin"
spec-class: "trivial-fix"
spec-class-note: |
  This is a minimum-surface-area bug-fix spec. The change tightens the
  precondition on an existing kill authority by consulting two existing
  detectors. No new gates, no new authorities, no new signals. The full
  /spec-converge multi-reviewer pipeline is intentionally not used —
  the change is too small to benefit from it and the side-effects review
  artifact at upgrades/side-effects/sessionmgr-activity-aware-timeout.md
  is the single source of truth. Justin verbally approved the work in
  topic 9529 in the same breath as the diagnostic ("yes please proceed").
---

# SessionManager activity-aware timeout-kill

> *A four-hour-old session producing tool calls every few seconds is not a zombie. The wall-clock kill needs to know the difference.*

## Problem statement

`SessionManager` enforces a wall-clock timeout on every tmux session: when `(Date.now() - session.startedAt) > maxDurationMinutes + 20%`, the session is killed. The default `maxDurationMinutes` is 240; the kill fires at 288 minutes.

Wall-clock age is not a sufficient signal of "this session is stuck." Long-running autonomous flows produce work for hours:

- Multi-phase `/instar-dev` builds driving several PRs to merge.
- Spec-convergence loops with internal + external reviewer rounds.
- Multi-hour `/loop` tasks that poll external state.
- Manual sessions where the user is actively engaged across a long pairing window.

When the timeout fires on a session like this, the in-flight work is interrupted, AND any background sub-agents spawned by that session are reaped along with it. This was observed twice within 24 hours on topic 9529 — both times the parent session was driving an `INSTAR-JOBS-AS-AGENTMD` Phase 1 build and was killed at the 288m mark, both times losing its background Phase 1b sub-agent.

## Proposed design

Tighten the precondition on the existing timeout-kill path:

- **Before:** `kill IF (elapsed > limit) AND NOT protectedSession`
- **After:** `kill IF (elapsed > limit) AND NOT protectedSession AND trulyIdle`

`trulyIdle` is defined by the existing infrastructure — `captureOutput` returning text that matches `IDLE_PROMPT_PATTERNS` AND `hasActiveProcesses` returning false (no non-baseline child processes). These are the same two signals the idle-detection block at lines 504+ uses.

Sessions that are over the age limit but still working fall through to the existing idle-detection block. If they ever DO go idle, that block catches them; the worst-case retention beyond the age limit is `IDLE_PROMPT_KILL_MINUTES`, which is already the established budget for "session has stopped working."

A new per-session log marker (`overAgeButActiveLogged: Set<string>`) keeps the deferred-kill warning to once per session.

## Decision points touched

- `SessionManager.monitor.timeout-kill` — modify. Same kill authority; tighter precondition by consulting two existing detectors. No new gate, no new signal, no new blocking authority.

## Open questions

None. The change is minimal-surface-area and the rollback is byte-identical revert.

## Out of scope

These are tracked as follow-ups in `upgrades/NEXT.md`:

- Commitment-registry consultation before any timeout-kill (consult the integrated-being commitment ledger and defer the kill if open commitments exist).
- Orphan-handoff manifests on kill (when a session is killed with background sub-agents in flight, write a recovery manifest per agent so the next session can resume).
- Resume orientation that surfaces orphan-handoff manifests on session respawn.

Each is its own substantial change with its own decision-point surface; they belong in their own `/instar-dev` cycles.
