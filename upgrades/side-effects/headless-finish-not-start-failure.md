# Side-Effects Review — a headless job that finishes quickly is not a failed start

**Version / slug:** `headless-finish-not-start-failure`
**Date:** `2026-11-03`
**Author:** `Echo`
**Tier:** 1 (narrow classification fix; a revert fully undoes it). Size: 1 source file (~20 lines) + 4 tests. Effort: no spec rounds; one commit attempt planned.

## Summary of the change

On the fresh Ubuntu proof server (topic 136880, agent nimbus, 1.3.1632–1.3.1634), every short scheduled job (health-check, commitment-detection, feedback-factory-process, llm-decision-grading; 18–36 s each, transcripts show they finished their work) was logged "exited on its own … Died DURING STARTUP", recorded `process-exited-during-startup`, and after three of them the start-failure tracker dropped the machine from placement ("dropping it from placement until one starts") and raised the "This machine cannot start sessions" attention item. A single-machine agent then had no placement-eligible machine.

Cause: the monitor classifies any self-exit inside the 120 s startup window as a startup death. Headless one-shots (`claude -p`, `launchLane: 'headless'`, `completionMode: 'exit'`) finish BY exiting, often inside that window. Every spawn path sets `remain-on-exit failed`, so a failed exit keeps its pane and status (read as `pane_dead_status`), while a clean exit (0) removes the session; the classifier read the missing status as unknown and counted it.

Fix: `SessionManager` remembers which sessions had `remain-on-exit failed` set successfully. A self-exit with no retained failure status from such a session, when the session is a headless one-shot, is a clean finish: `endedReason: 'process-exited'`, outcome `completed`, and it no longer feeds the start-failure tracker. Everything else is unchanged: a headless session whose pane kept a failure status (e.g. "Not logged in", exit 1), a session where the option could not be set (died before it, or tmux refused), and every interactive session (a clean exit at an update or trust prompt is still a failed start) are still counted.

## Decision-point inventory

- How a self-exit inside the startup window is classified — modify — headless clean finishes are completions.
- Placement eligibility (start-failure tracker) — unchanged logic; it simply stops receiving false failures.

## 1. Over-block

None. The change only removes false positives.

## 2. Under-block

A headless session that exits 0 without doing its work (if `claude -p` ever exited 0 on a sign-in or trust problem) would no longer count toward the placement drop. Today `claude -p` exits non-zero for "Not logged in", so that path is still counted; interactive sessions, where clean exits at prompts happen, are untouched. A headless session that died before `remain-on-exit` could be set is still counted (no evidence of a clean exit).

## 3. Level-of-abstraction fit

The classification lives where the exit is observed (the monitor's self-exit branch), using evidence the same class already collects (`pane_dead_status` under `remain-on-exit failed`). The tracker and placement code are untouched.

## 4. Signal vs authority compliance

The start-failure tracker turns this classification into a placement decision (authority). The fix makes its input truthful; it adds no new blocking logic. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

`removeDeadJobPane`, the reap-log `exited` row and `sessionComplete` behave as before; the `exited` row now says `process-exited` for these jobs. The retained-set entry is cleared wherever the exit-code map is cleared, so no state leaks across sessions.

## 6. External surfaces

Fewer false "This machine cannot start sessions" attention items and placement drops; reap-log reasons change for short headless jobs.

## 7. Multi-machine posture

Machine-local by design (process and tmux state of this machine's own sessions); the placement signal it feeds is already pooled by the capacity heartbeat. No new state.

## 8. Rollback cost

Revert the commit. No data or config migration.

## Evidence

- Unit: `tests/unit/session-manager-is-session-alive-async-tristate.test.ts` adds four cases (clean headless finish → `process-exited`/completed; headless failed exit → still a startup death; option not set → still a startup death; interactive clean vanish → still a startup death). Related suites pass: start-failure-placement, reap-log, dead-job-pane-cleanup (real tmux).
- Live: nimbus logs and transcripts, 2026-11-03 22:55–23:15 UTC (jobs that finished in 18–36 s, then `[start-failure] … dropping it from placement`).
