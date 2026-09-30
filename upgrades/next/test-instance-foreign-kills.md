# Test runs and repair paths no longer signal processes they did not start

## What Changed

An investigation into six `claude -p` builders SIGKILLed on the Mac Studio
(2026-09-29/30) found no test-instance kill path that can reach a process the
instance did not start. It did find three real hazards, and this change fixes them:

- `tests/helpers/setup.ts`: `createTempProject().cleanup()` now removes the tmux
  sessions named after its own unique temp folder. `scheduler-basic` cleaned up a
  prefix the SessionManager never produces, so each run leaked one
  `instar-test-*-job-fast-test-*` session.
- `instar lifeline restart` (the fallback when `launchctl kickstart` fails):
  it now signals only the lifeline's own recorded pids, the `lifeline.lock`
  holder and the startup-marker pid, after checking that each is still a
  lifeline process. Before, it ran
  `pkill -f '<agent>.*lifeline'`, which matched any command line containing both
  words.
- `PipeSessionSpawner`: the process-group kill now happens only while the
  recorded pid is still the session's pane. Once the pane is gone, the pid can
  be reused by an unrelated process. All tmux targets in the file are now exact
  (`=name`).

## Evidence

- `tests/integration/foreign-process-survives-test-instance.test.ts` sets up a
  foreign `claude`-shaped process in its own tmux session on the shared server,
  named like a job session. That process survives a real SessionManager spawn,
  two maintenance ticks and the fixture cleanup. The cleanup also leaves none
  of the instance's own sessions behind. Against the old helper, this test
  fails with the leaked `instar-test-…-job-fast-test` session. Against the old
  spawner, a detached process at a stale recorded pid was SIGKILLed. With the
  fix it survives.
- Live check of `instar lifeline restart` with `launchctl` failing: the lock
  holder was killed. A foreign `claude -p /agents/lrprobe/ fix the lifeline`
  process survived, although the old `pkill` pattern matches it.
- `tests/unit/lifeline/version-skew-recovery.test.ts` pins that the restart
  fallback no longer contains `pkill`/`killall` and signals the lock-holder and marker pids.

## What to Tell Your User

If my lifeline ever has to be restarted by hand and the normal restart
fails, the fallback now stops only the lifeline itself. Before, it could
also stop other programs on the machine whose command line happened to
mention my name and the word "lifeline", such as a coding session working on
it.

## Summary of New Capabilities

- None new. Two repair paths (the lifeline restart fallback and the
  pipe-session timeout) now stop only processes they started themselves.
