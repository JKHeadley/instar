# Side-Effects Review — automatic kills signal only what the agent can prove it started

**Version / slug:** `test-instance-foreign-kills`
**Date:** `2026-09-30`
**Author:** `Echo (builder)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Round 3, after Astra's round-2 review (four must-fixes: M1 unreadable identity
read as a dead lifeline; M2 and M3 retained dead tmux panes; M4 overreaching
claims). The kill paths the reviews named now check ownership through one
small shared check before they signal, in the cases the tests below exercise.
Where a check cannot prove ownership, the path logs or reports and does not
signal.

Round 3 changes:

- `processIdentity.checkRecordedProcess`: an unreadable start time (ps denied,
  timed out, unparseable) is `gone` only when `kill(pid, 0)` returns ESRCH;
  otherwise `unproven`, so a live lifeline lock is kept (M1). In
  `acquireLockFile`, if the holder's identity turns unreadable during the
  SIGTERM grace, the new lifeline neither sends SIGKILL nor takes the lock
  (found by the round-3 second-pass review).
- `PipeSessionSpawner.killPipeSession`: reads `#{pane_dead}`. The process
  group is signalled only for an owned pane tmux reports live; an owned dead
  or unreadable pane gets only `kill-session -t <session_id>`. The fallback
  SIGKILL of the bare pane pid (when the pgid read failed) is removed (M2).
- `OrphanProcessReaper`: only live panes (`pane_dead=0`) map a pid to a
  session. The start time read at classification is carried on the orphan and
  must still match right before SIGTERM; null sends nothing and the tmux
  session is left alone. Session ownership is re-checked before the terminal
  `kill-session`. The operator-requested external kill is a separate mode of
  `killProcess` (M3).

- `src/core/processIdentity.ts` (new, ~60 lines): `processStartMs(pid)` reads
  `ps -o lstart=`. `checkRecordedProcess({pid, procStart, startedAt})` returns
  one of four verdicts: `same` (the start time matches), `gone`, `reused` (the
  live process started after the record was written), or `unproven`.
- `src/lifeline/lifelineLock.ts` (new; `acquireLockFile` moved here from
  `TelegramLifeline.ts`): the lock records `procStart`. Takeover signals are
  sent only on `same`, and identity is proven again before SIGKILL. On
  `reused`, the new lifeline takes the lock without a signal. On `unproven`,
  it respects the lock. `provenLifelineRecords()` selects the `lifeline
  restart` targets.
- `src/lifeline/startupMarker.ts`: the marker records `procStart`.
- `src/cli.ts` (`lifeline restart` fallback): targets come from
  `provenLifelineRecords(lock, marker)`, and SIGKILL goes only to targets
  that are still `same` after the grace period. The round-1 keyword check is
  removed.
- `src/threadline/PipeSessionSpawner.ts`: `new-session -P -F '#{session_id}
  #{pane_pid}'` records the incarnation. `killPipeSession` signals the group
  and runs `kill-session -t <session_id>` only while the named session still
  lists that exact id and pid; otherwise it signals nothing. `spawn()` replaces
  a same-name session only when it is recorded in `activeSessions`, and
  otherwise refuses.
- `src/core/SessionManager.ts`: new `ownsLiveTmuxSession(name)`. It reads the
  live session's `INSTAR_SESSION_ID` (every spawn path sets it) and checks
  that this agent's state holds a record with that id for that tmux name.
  `spawnTriageSession` refuses to kill an occupied name without that proof.
- `src/monitoring/OrphanProcessReaper.ts`: a historical-name match becomes
  `instar-orphan` (auto-kill eligible) only with `ownsLiveTmuxSession`.
  Without it, the process is classed `external` and only reported.
  `killProcess` records the start time before SIGTERM and sends SIGKILL only
  if it is unchanged.
- Tests: the broad `cleanupTmuxSessions('akit-integ-'/'akit-sched-')` calls are
  removed. `scheduler-basic` waits for in-flight spawns before cleanup (a
  late spawn leaked a dead-pane session). The regression test is rewritten with 7 real-tmux cases, both sides
  of each decision, with teardown in `finally`. There is a new unit test with
  real child processes for the lifeline identity.

## Decision-point inventory

- Lifeline restart target selection — modify — keyword → proven incarnation.
- Lifeline lock takeover — modify — any live pid → proven incarnation; reused → silent takeover; unproven → respect.
- Pipe kill / pipe spawn over an existing name — modify — name → recorded session id + pane pid; foreign name → refuse.
- Triage spawn over an existing name — modify — name → `ownsLiveTmuxSession`; foreign → refuse (throw).
- Orphan auto-kill eligibility — modify — historical name → name + live `INSTAR_SESSION_ID` match.
- Delayed SIGKILL escalations (reaper, lifeline) — modify — `kill(pid,0)` → same start time.

---

## 1. Over-block

- A legacy lifeline lock or marker, written before this change and so with no
  `procStart`, is never signalled by `lifeline restart`. At startup, a legacy
  lock whose live pid started before the lock was written is respected, not
  taken over. The first restart after the update normally goes through
  launchd's `kickstart -k`, which does not use these paths. Once a lifeline
  from this version is running, its records carry `procStart`.
- A process whose start time `ps` cannot read is not signalled. For the
  lifeline lock it counts as gone only on a confirmed ESRCH; a live holder
  whose start time cannot be read keeps its lock, so a new lifeline refuses to
  start until `ps` works again.
- Pipe spawner: a live owned pane whose pgid cannot be read gets no process
  signal; `kill-session` still hangs up the pane.
- Orphan reaper: an owned orphan whose start time cannot be read is skipped
  (reported as "Skipped orphan"), not killed.
- Triage: if a session record was purged while its tmux session lived on, the
  triage name stays occupied and the spawn throws. `TriageOrchestrator`
  already handles a failed spawn. That is better than killing an unproven
  session.
- Orphan reaper: an orphan whose record was purged, or whose tmux env lacks
  `INSTAR_SESSION_ID` (a very old session), is only reported. The operator
  can still use the explicit external-process API.
- Pipe spawner: a pipe session from before a server restart, which is no
  longer in `activeSessions`, blocks a new pipe spawn for that thread. The
  caller then falls through to the normal A2A path, as it does for any
  `spawned:false`.

## 2. Under-block

- Start-time resolution is 1 s. A pid reused within the same second as the
  original start would pass. That is not a realistic collision.
- Two SessionManagers sharing one agent state dir are treated as one agent
  and may clean up each other's sessions. That is the same agent, which is
  intended.
- The final ownership check and the signal are separate calls, a few
  milliseconds apart. The reaper's terminal `kill-session` goes by name after
  an ownership re-check.
- Only the paths named here were changed. Other kill paths (for example the
  SessionWatchdog, and SessionManager's own passes) were not re-audited in
  this change.
- This change does not identify what killed the six builders. Those deaths
  remain unattributed, and these paths are not excluded as a possible cause.

## 3. Level-of-abstraction fit

There is one shared primitive for pids (`processIdentity`) and one for
sessions (`ownsLiveTmuxSession`, which uses the `INSTAR_SESSION_ID` every
spawn already sets). The pipe spawner uses tmux's own unique session id. No
new subsystem, store or loop is added.

## 4. Signal vs authority compliance

- [x] No — no block/allow surface on information flow. These checks narrow an
  irreversible action (a signal) to proven targets. Each one removes reach and
  none adds authority.

## 4b. Judgment-point check

The checks are deterministic safety floors on a SIGKILL. They are not
heuristics at a competing-signals decision point.

## 5. Interactions

- The SessionWatchdog already checks the parent pid, command and incarnation
  before its descendant signals, and this change leaves it untouched.
  SessionManager's own passes iterate its own records.
- The reaper's `trackedNow` path to `terminateSession` is unchanged.
  Ownership proof only gates the non-tracked, historical-record path.
- `TelegramLifeline.releaseLockFile` still compares pid only when removing its
  own lock file (a file, not a signal). That is unchanged.
- `acquireLockFile` behavior for a dead pid (take over) and a fresh proven
  holder (respect) is unchanged.

## 6. External surfaces

- New optional JSON fields: `procStart` in `state/lifeline.lock` and
  `state/lifeline-started-at.json`. Readers ignore unknown fields, and
  `readStartupMarker` keeps its existing validation.
- A new `spawned:false` reason from the pipe spawner, and a new triage spawn
  error message.
- Orphan reaper reports can now list a process as `external` with the reason
  "ownership unproven".

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN. Pids, start times and tmux sessions are per-host, and
every check is on the host that would send the signal.

## 8. Rollback cost

Revert and ship a patch release. The new JSON fields are additive, and older
code ignores them. No migration is needed.

---

## Conclusion

Clear to ship pending review. In the cases the tests exercise, the paths
Astra named signal only a proven incarnation, and the positive cleanup cases
still work. The limits in section 2 remain.

---

## Second-pass review (if required)

**Round 3 reviewer:** independent reviewer subagent (general-purpose,
read-only). **Verdict: Concur.** M1-M4 closed in the code read; no automatic
path read signals an unproven process. Its minor points: (a) identity turning
unreadable during the lifeline SIGTERM grace fell through to a takeover —
fixed in this round, with a test; (b) the reaper reads `procStart` just after
the ownership check, not from the original `ps` scan (documented limit);
(c) the integration test's teardown killed detached children on an `alive`
check only — it now also requires the recorded start time.

**Round 2 reviewer:** independent reviewer subagent (general-purpose, read-only).
**Verdict: Concur with the review** (round 2). Astra's round-2 review then
found M1-M3 below, so this verdict did not hold; the round-3 fixes await
Astra's next review.

- Round-2 reviewer's claim (superseded): all six must-fixes are closed in the
  touched code. No touched path lets a
  name, keyword or bare pid alone authorize an automatic signal. The lifeline
  restart and takeover signal only on `same`, and SIGKILL re-checks. Pipe
  teardown needs an exact id+pid match and kills by id. Triage throws on a
  session it does not own. The reaper's name-only matches are report-only,
  and its SIGKILL re-checks the start time.
- `ownsLiveTmuxSession` checks the id against a regex before
  `StateManager.getSession`, so its `validateKey` cannot throw. All four spawn
  paths set `INSTAR_SESSION_ID`.
- The over-block and under-block lists are accurate.
- Minor residuals, none blocking. After proving ownership, the reaper kills
  the tmux session by name, which leaves a window of milliseconds. Its first
  SIGTERM goes to a pid from the same scan. A wedged legacy lifeline is left to
  launchd's `kickstart -k`, as section 1 says.

---

## Evidence pointers

- `tests/integration/foreign-process-survives-test-instance.test.ts`: 7/7
  pass. We restored each old behavior in turn: the reaper name match, the
  round-1 `PipeSessionSpawner.ts`, no triage guard, and the pre-fix
  `tests/helpers/setup.ts`. Each makes its matching case fail (1, 2, 1 and 1
  failures).
- `tests/unit/lifeline/lifeline-lock-identity.test.ts`: 7/7 pass. With
  `checkRecordedProcess` changed to accept any live pid, 3 fail. The legacy
  "respect" case does not discriminate on its own, because a fresh child cannot
  carry a 5-minute-old lock. Its verdict is covered by the `checkRecordedProcess` case.
- Round 3: `tests/unit/lifeline/lifeline-lock-identity.test.ts` adds a `ps`
  that always fails on PATH: a live holder is `unproven` and keeps its lock; a
  holder confirmed dead (ESRCH) is `gone` and the lock is taken over.
- Round 3: a holder that ignores SIGTERM, with `ps` failing after the first
  identity check: `acquireLockFile` returns false, sends no SIGKILL, and the
  lock is unchanged. This case fails against the round-2 `lifelineLock.ts`.
- Round 3: the integration file adds a real retained dead pane
  (`remain-on-exit`, its pane process killed by exact pid): `process.kill` is
  never called and the owned session is removed. With the round-2 spawner this
  case fails. The live-pane positive case now also asserts the pane process
  exits. 8/8 pass.
- Round 3: `tests/unit/orphan-reaper-pane-identity.test.ts` (scripted ps/tmux,
  stubbed `process.kill`): a foreign pid reusing a dead or indeterminate
  pane's pid is not an orphan and gets no signal; the same pid in a live owned
  pane is reaped (SIGTERM then SIGKILL, ownership re-checked before tmux
  cleanup); a changed or unreadable start time sends nothing; the operator
  kill still works. All six fail against the round-2 reaper. PID reuse itself
  is simulated, not reproduced.
- Round-1 live check: a foreign `claude -p … fix the lifeline` process survived
  the `lifeline restart` fallback.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `n/a` (negative declaration)
- **`reason`** — No new trigger or loop. The change only narrows which
  pid or session existing kills may signal, and adds ownership proof before
  each one.
