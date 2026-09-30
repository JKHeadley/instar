# Automatic kills signal only processes and sessions the agent can prove it started

## What Changed

An investigation into six `claude -p` builders SIGKILLed on the Mac Studio
(2026-09-29/30) did not identify their cause. It did find automatic kill
paths that picked their target by name, keyword or bare pid. None of those
proves the target is the agent's own. Each path now proves ownership first,
and when it cannot, it does not signal:

- New `src/core/processIdentity.ts`: a recorded pid counts as the same process
  only while its start time (`ps -o lstart`) matches the recorded one.
- `instar lifeline restart` fallback (used when `launchctl kickstart` fails):
  `lifeline.lock` and the startup marker now record `procStart`. The fallback
  signals the lock holder and the marker pid only when each is proven to be
  that same process, and it proves this again before SIGKILL. The old
  `pkill -f '<agent>.*lifeline'` and the round-1 "command contains lifeline"
  check are both gone. Legacy records without a start time are never
  signalled.
- Lifeline startup takeover (`acquireLockFile`, now in
  `src/lifeline/lifelineLock.ts`): a stuck holder is terminated only when
  proven. A pid that started after the lock was written counts as reused, and
  the lock is taken without signalling anyone. If ownership is unproven, the
  lock is respected.
- `PipeSessionSpawner`: records tmux `#{session_id}` + pane pid at creation. It
  kills only that exact session, by id, and never a same-name replacement or a
  stale pid's group. It refuses to spawn over a `pipe-<threadId>` session it
  did not start.
- `SessionManager.spawnTriageSession`: it replaces an existing session under
  the triage name only when `ownsLiveTmuxSession()` proves that session is its
  own. Proof means the session's `INSTAR_SESSION_ID` names this agent's record
  for that name.
- `OrphanProcessReaper`: auto-kill requires `ownsLiveTmuxSession()`. A process
  in a session that only reuses a recorded name is reported as external. The
  delayed SIGKILL checks the start time again, for the operator API too.
- Tests: `createTempProject().cleanup()` removes only sessions named after its
  unique temp dir. The broad `cleanupTmuxSessions('akit-integ-'/'akit-sched-')`
  calls are removed. `scheduler-basic` now waits for spawns that are still in
  flight before cleanup. Its every-second cron could land a spawn after
  cleanup and leak a dead `instar-test-*-job-fast-test-*` session, which was
  seen twice during a full `npm test` run here.

## Evidence

- `tests/integration/foreign-process-survives-test-instance.test.ts` (real
  tmux, 7 cases). The orphan pass reaps an owned orphaned session. A foreign
  `claude`-shaped process survives, and so does a foreign process in a session
  that reuses a name the instance recorded. Fixture cleanup removes the
  instance's own sessions and nothing else. Triage replaces its own session and
  refuses a foreign one. The pipe spawner kills its own session, leaves a
  same-name replacement and a stale pid alone, and refuses to spawn over a
  foreign session. We restored each old behavior in turn: the reaper's name
  match, the round-1 spawner, no triage guard, and the old helper. Each one
  makes the matching case fail.
- `tests/unit/lifeline/lifeline-lock-identity.test.ts` (real child processes).
  A stale lock whose pid now runs a foreign command mentioning "lifeline" is
  neither a restart target nor signalled at startup. The own proven holder is
  a target and is terminated when wedged. Making the identity check accept any
  live pid fails 3 cases.
- These tests show that the changed paths do not signal unproven targets. They
  do not show what killed the six builders.

## What to Tell Your User

My automatic clean-up of stuck sessions and processes now only stops things
I can prove I started myself. Before, a few repair paths went by a name or a
process number, and on a busy machine those can end up belonging to some
other program. If I can't prove something is mine, I leave it running.

## Summary of New Capabilities

- None new. Lifeline restart and takeover, pipe-session and triage cleanup,
  and orphan cleanup now stop only processes and sessions they can prove they
  started.
