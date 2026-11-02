# Side-Effects Review — Lifeline lock judges a holder by its heartbeat

**Version / slug:** `lifeline-lock-heartbeat`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (concurred)`

## Summary of the change

Fixes issue #2485. `acquireLockFile` treated any holder that had held the lock for
over 5 minutes and showed `ps` state `S` as wedged, then killed it. A healthy idle
Node process is in `S` nearly all the time, so any second lifeline start killed a
healthy lifeline. Reproduced on v1.3.1576: an idle Node process with a 6-minute-old
lock was killed.

- A new lock carries `heartbeatMs: 30000`, and its holder touches the file's mtime
  every 30 s (`startLockHeartbeat`). Such a holder counts as wedged only when the
  mtime is over 5 minutes old and does not move during a 45 s second look. The look
  counts polls rather than a wall-clock deadline, so a clock jump cannot shorten it.
- Lock creation is atomic (hard link of a fully written temp file, exclusive create
  as the fallback, for the lock and the mutex alike). An unreadable lock over 30 s old
  is now replaced instead of blocking every later start; it names no process, so nothing
  is signalled. Removing a lock judged stale happens only under a short takeover
  mutex and only while its content is still what was judged.
- `quiesceEverything` stops the heartbeat before releasing the lock.

Files: `src/lifeline/lifelineLock.ts`, `src/lifeline/TelegramLifeline.ts`,
`tests/unit/lifeline/lifeline-lock-identity.test.ts`,
`docs/specs/lifeline-version-skew-recovery.md`, plus this artifact, the ELI16 and the
release note.

Tier 1: 4 source/test/spec files, about 300 lines, one review round. A revert restores
the old behaviour: old code ignores `heartbeatMs` and the mtime. Proportion: 4 build
passes and 3 review rounds, which is above Tier 1's usual size. The first takeover design failed a
real 20-process race, and review found two real faults in code that can kill a process.

**Decision points touched:** the "may this process signal the lock holder" decision.

## Decision-point inventory

- `acquireLockFile` wedged test — modify — `ps` state → heartbeat age, for holders that
  heartbeat. Zombie/stopped and identity checks unchanged.
- Takeover of a stale lock — modify — unconditional rename-over → mutex plus content check.

## 1. Over-block

A starter now exits where it used to take over in three cases, all correct: a healthy
idle holder; losing a same-instant race; another starter holding the mutex. A starter
that loses exits cleanly and launchd retries it, as it did before.

A holder whose event loop runs but whose Telegram polling is stuck now keeps its lock.
Before, a second start would have killed it, by accident of the same bug. The lifeline's
own watchdog and the out-of-process fleet watchdog (which force-restarts through launchd,
without using this lock) own that case.

## 2. Under-block

- **A holder from before this change** has no `heartbeatMs` and keeps the old state test,
  so a second start can still kill it. This is deliberate: it is the only evidence
  available for such a holder, and removing it could bring back the 2026-05-20 loop. It
  ends when that lifeline next restarts onto this code.
- **A crashed starter's mutex** blocks takeovers for at most 30 s, then ages out. Two
  starters clearing an aged mutex at the same instant could still race; that needs a
  crash, or a starter suspended over 30 s while holding the mutex, followed by a
  same-instant restart. A resumed starter only releases a mutex that is still its own.
- **Without hard links** the exclusive-create fallback is not atomic about content: a crash
  mid-write leaves an empty lock or mutex. Both age out at 30 s.
- **A corrupt lock with a live holder** is replaced after 30 s, which can leave two
  lifelines until the next restart. Outside tampering could cause it, and so could a sync
  merge conflict, because `.instar/lifeline.lock` is tracked and auto-committed in some agent
  homes (not confirmed that sync ever leaves conflict markers). A corrupted lock also stops
  the live holder's heartbeat. Accepted: the alternative is an agent that can never start
  again. Untracking the lock is filed separately.
- **A lock overwritten from outside.** `.instar/lifeline.lock` is tracked in some agent
  homes, so a git pull could replace it with another machine's content. The heartbeat
  then skips the lock (it never touches one it does not own) and a later starter can
  treat the foreign pid as gone. That hazard exists today and this does not change it.

## 3. Level-of-abstraction fit

Right layer: the lock is the single-instance authority and the holder is the only process
that knows it is alive. The heartbeat measures the event loop, not polling; polling health
already has its own watchdogs and this does not duplicate them.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`. Compliant, and stricter than before.
This is a kill authority, so it should not rest on brittle evidence: a one-instant `ps`
reading is replaced by a sustained absence of a positive signal that the holder itself
emits, confirmed by a second look. Identity is still proven before any signal. Every
uncertain read (mtime unreadable, identity unreadable) respects the lock, with one exception:
a lock whose content cannot be read, once over 30 s old, is replaced. It names no process, so
nothing is signalled.

## 5. Interactions

- **The 2026-05-20 incident** still recovers: `quiesceEverything` stops the heartbeat and
  releases the lock synchronously before its first await, so a shutdown that wedges leaves
  no live lock, and a lock left behind goes stale and is taken over.
- **`ServerSupervisor` preflight** deletes a lock file whose mtime is over 10 minutes old.
  It looks at `<stateDir>/state/lifeline.lock`, while the lock lives at
  `<stateDir>/lifeline.lock`, so today it never fires. The heartbeat makes that check
  correct if the path is ever fixed. Filed separately through feedback.
- **Other readers** (`LifelineProbe`, `connectEnable`, `OriginInstallation`,
  `provenLifelineRecords`) read `pid`, `procStart` and `startedAt`. The added field and
  mtime changes do not affect them.
- **`LifelineProbe` message:** unchanged.

## 6. External surfaces

None user-visible apart from the fix. Lock files gain one JSON field, and a `.takeover`
file exists for a few milliseconds during a takeover. No new routes or config. Mtime
touches do not change content, so an agent home that tracks the lock sees no new commits.

## 7. Multi-machine posture

Machine-local by design: a lock guards one process on one machine, and pool-wide Telegram
ownership is decided by the serving lease, not this file.

## 8. Rollback cost

Revert and release. Locks written by the new code remain valid for the old code, which
ignores the extra field. No migration or state repair.

## Evidence pointers

- Issue reproduction on shipped v1.3.1576: killed at 6 minutes, left alone at 1 minute.
- Unit tests on both sides of each decision, including a holder whose heartbeat moves
  during the second look.
- Real race, 20 processes starting at once on the built code. Shipped code: 20 of 20 won,
  with no lock and with a dead holder, 5 rounds each. First version of this fix: 2 winners
  in 2 of 5 dead-holder rounds, which is why the mutex exists. Final code: exactly 1 winner
  in all 40 rounds. The race is now a test.

## Second-pass review

First pass raised three concerns, all addressed. The reviewer verified the first two by running them and the third by reading:

1. Takeover had no hard-link fallback, so on such a filesystem a dead lock blocked every
   later start (a regression). Fixed with one shared exclusive create; test added.
2. The second look used a wall-clock deadline, so a simulated clock jump killed a healthy
   holder after 4 s. Now counted polls; test added.
3. This artifact omitted the hard-link dependency, suspended starters and clock jumps. Added.

The reviewer also found the mutex cleanup paths, the SIGSTOP branch, quiesce ordering and the
other lock readers sound.

Second round: the reviewer re-ran these checks after the fixes and confirmed all three closed.
It raised three small items, all addressed: valid non-object JSON in a lock caused a permanent
lockout (now treated as unreadable, test added), and two wording fixes in this artifact.
