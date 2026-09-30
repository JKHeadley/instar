# Side-Effects Review — test runs and repair paths never signal processes they did not start

**Version / slug:** `test-instance-foreign-kills`
**Date:** `2026-09-30`
**Author:** `Echo (builder)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Three kill paths are narrowed so that each one can only reach processes its own
caller started:

1. `tests/helpers/setup.ts`: `createTempProject().cleanup()` now kills the tmux
   sessions named `<basename(tempDir)>-*`. mkdtemp makes that name unique, so
   only this project's sessions match.
2. `src/cli.ts` (`instar lifeline restart`): the fallback when
   `launchctl kickstart` fails no longer runs `pkill -TERM/-KILL -f
   '<projectName>.*lifeline'`. It now signals the lifeline's own recorded
   pids: the `lifeline.lock` holder and the startup-marker pid. Each is
   signalled only while `ps` shows its command line contains `lifeline`.
3. `src/threadline/PipeSessionSpawner.ts`: `killPipeSession` now does the
   process-group SIGKILL only when `tmux list-panes -t =<name>:` still lists
   the recorded pid. Every `-t` target in the file is now exact (`=name`, and
   `=name:` for pane commands).
4. `src/core/SessionManager.ts`: the triage respawn's `kill-session` target
   is now exact (`=name`), as the reviewer noted.

A regression test (`tests/integration/foreign-process-survives-test-instance.test.ts`)
covers 1 and 3, and a source-shape unit test covers 2. No decision logic about
*whether* to kill changes; only *which* process may be signalled changes.

## Decision-point inventory

- `lifeline restart` fallback target selection — modify — command-line pattern → recorded pid.
- `PipeSessionSpawner.killPipeSession` group-kill target — modify — adds a pane-still-ours identity check.
- Test fixture cleanup — modify — adds own-name tmux cleanup (test-only).

---

## 1. Over-block

The case the SIGKILL escalation was built for (b2lead) is a stuck old lifeline
holding `lifeline.lock`. That lock holder is signalled directly. The marker
alone would not be enough: it is written before the lock is taken, so in the
stuck case it names a respawn that already exited. A lifeline that holds no
lock and has no live marker could now be missed. Before, the pattern kill
would have found it. Now
the fallback logs "nothing to signal" and goes on to the existing 30 s respawn
poll, which reports the failure. The fallback only runs after `launchctl
kickstart` has already failed. That is an operator-invoked repair, so a clear
failure is better than a guess.

For pipe sessions: if the tmux session has gone but its descendants live on,
the group kill no longer reaches them. That is an accepted cost. Once the pane
is gone, its pid is exactly what we can no longer trust.

---

## 2. Under-block

A reused pid that happens to belong to another process with `lifeline` in its
command line would still pass the lifeline check. That needs an exact pid
collision, not just a pattern match. It is far narrower than before, and it is
the same trust the respawn poll already puts in the marker.

---

## 3. Level-of-abstraction fit

Each fix sits at the call site that picked the target, and each uses the
identity the caller already records: the marker pid, the pane pid, and the
unique temp-dir name. No new layer is added.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

These are kill-target selections, not gates on information flow. Each change
removes reach. None adds authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The pid-identity
checks are safety guards on an irreversible action (a SIGKILL), deterministic by design.

---

## 5. Interactions

- The same command already reads the lifeline marker for its respawn poll.
  The marker pid and the lock-file pid, which `acquireLockFile` also reads,
  are now the kill targets.
- The PipeSessionSpawner `kill-session` still runs afterwards. `=name`
  guarantees it removes only this session and never a prefix match such as
  `pipe-<id>…`.
- Fixture cleanup runs before the temp dir is removed. Tests that also call
  `cleanupTmuxSessions` themselves stay correct, because a second kill of an
  already-dead session is a no-op.

---

## 6. External surfaces

`instar lifeline restart` prints a different fallback message. Nothing else is
visible outside the process.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN. Process IDs and tmux sessions are per-host, and every
fix narrows a per-host kill.

---

## 8. Rollback cost

Revert the commit and ship a patch release. No state, data, or migration is involved.

---

## Conclusion

Clear to ship. The investigation found no SessionManager/test-instance path able
to reach a foreign process (see the ELI16 overview for the evidence). This
change closes the three real foreign-signal hazards the search surfaced and
stops the test-session leak.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only)
**Independent read of the artifact: concern raised, then resolved**

- Concern: `TelegramLifeline.start()` writes the startup marker (line 426)
  before taking `lifeline.lock` (line 440). So in the stuck-lock case the
  marker names a dead respawn, and a marker-only fallback cannot reach the
  stuck lock holder, which is the case the SIGKILL escalation exists for.
  Resolution: the fallback also targets the `lifeline.lock` pid, with the same
  `ps` identity check. Verified live: with `launchctl` failing, the lock
  holder was killed. A foreign `claude -p /agents/lrprobe/ fix the lifeline`
  process survived, although `pgrep -f 'lrprobe.*lifeline'` (the old pattern)
  matches it.
- Minor: `SessionManager.ts` triage respawn `kill-session -t tmuxSession`
  lacked `=`. Fixed.
- Otherwise concurred: the PipeSessionSpawner targets and check are correct,
  the fixture cleanup is scoped to the unique mkdtemp name, and there is no
  SessionManager / test-instance path that signals a foreign process.

---

## Evidence pointers

- Red/green: the new integration test fails against the old `setup.ts`
  (leaked `instar-test-…-job-fast-test`). It also fails against the old
  `PipeSessionSpawner.ts`, where the stale-pid detached process was SIGKILLed.
  With the change it passes.
- Live repro: a `claude`-named process in a separate tmux session survived a
  full `scheduler-basic` run. The run leaked a 14th `instar-test-*` session
  before the fix.
- Kernel log 2026-09-30 03:10-03:50: no jetsam/memorystatus kill.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `n/a` (negative declaration)
- **`reason`** — No new trigger or loop. The change only narrows which pid
  existing kills may signal. `instar lifeline restart` is a one-shot CLI that
  an operator runs. The pipe-session kill still fires at most once per session,
  from its own timeout or shutdown. The triage `kill-session` target only
  gains the exact-match `=` prefix. There is no agent-authored-artifact
  defect.
