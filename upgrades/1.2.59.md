# Upgrade Guide — NEXT (autonomous mode delegates to native /goal)

<!-- bump: minor -->
<!-- minor = new capability, backward compatible -->

## What Changed

**New: where the framework has a native /goal loop, autonomous mode hands the finish-line to it.**

Phase 2 of `docs/specs/goal-completion-evaluator.md`. When an autonomous job is started with a
completion condition AND the framework provides native /goal (Claude Code >= 2.1.139), instar
now **injects `/goal <condition>` into the session** — using its core session-input mechanism
(`SessionManager.sendInput` / tmux send-keys, the same way it injects any message) — and marks
the job `goal_mode: native`. The framework's own /goal loop (with its own independent evaluator)
then drives completion, and instar's stop-hook **defers** the continue/stop decision to it
(approves each turn so native /goal stays in control). Where native /goal is absent, instar's
own completion evaluator (shipped previously) drives — works everywhere.

instar stays in charge of what native /goal doesn't cover: it still enforces **emergency-stop**
and **duration expiry** on a native-goal job by injecting `/goal clear` first, then standing the
job down. Multi-topic orchestration, cap/quota, and messaging remain instar's.

- Endpoints: `POST /autonomous/native-goal/set {topicId, condition}` (inject + mark native),
  `POST /autonomous/native-goal/clear {topicId}`.
- `setup-autonomous.sh` auto-detects Claude Code >= 2.1.139 and activates native /goal when a
  condition is set; otherwise falls back to instar's own evaluator.

## What to Tell Your User

When the tool I'm running already has its own "keep going until done" feature (Claude Code and
Codex both added one called goal), I now hand my finish-line straight to it instead of running
my own judge on top — no double-checking, and I use the tool's native machinery. Where the tool
doesn't have it, my own judge still does the job. Either way I keep the safety controls (stop
everything, time limits) and the ability to run several jobs at once. Nothing to set up.

## Summary of New Capabilities

- Native /goal delegation: instar injects `/goal <condition>` into the session and lets the
  framework's loop own completion (`goal_mode: native`).
- `POST /autonomous/native-goal/set` and `/autonomous/native-goal/clear`.
- Auto-detection of Claude Code >= 2.1.139 in `setup-autonomous.sh`.
- Stop-hook defers completion to native /goal while still enforcing emergency-stop + duration
  (clears the native goal first).

## Migration Notes

Existing agents receive the updated hook + setup via
`PostUpdateMigrator.migrateAutonomousStopHookTopicKeyed` (marker bumped to the native-/goal
signature). No action required.

## Evidence

- **Hook (behavioral):** `autonomous-completion-condition.test.ts` — `goal_mode: native` defers
  (approves/exits, job retained, native /goal stays in control); emergency-stop and duration
  expiry still clear state + exit in native mode.
- **Integration:** `autonomous-sessions-api.test.ts` — `native-goal/set` injects `/goal
  <condition>` into the topic's session (verified via the recorded `sendInput` call) and flips
  `goal_mode: native`; `native-goal/clear` injects `/goal clear`; 404 on unknown topic.
- tsc clean; 174 affected tests green.

## Note on approach

The original spec sketched Phase 2 via a `ThreadGoalSlot` provider primitive. The shipped
approach instead drives native /goal by **injecting the slash command** through instar's
existing session-input mechanism — simpler, and the correct use of a capability instar already
has (rather than treating "no programmatic /goal API" as a blocker). Same intent (delegate to
native /goal where present), better mechanism.
