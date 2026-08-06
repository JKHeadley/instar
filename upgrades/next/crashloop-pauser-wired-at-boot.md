## What Changed

**A guard that was written, tested, and never switched on is now switched on.**

`CrashLoopPauser` detects a job that keeps crashing and pauses it, so a runaway job stops burning compute and filling your notifications while someone works out why. It was written, and it had eight passing unit tests. **It was constructed eight times in its own test file and zero times in the running server** — so while a job failed 492 consecutive times, nothing paused it, and a green test suite read as "this guard works."

The remedy was never an implementation. It was one missing construction.

**It ships in dry-run.** Pausing a job disables it, which is real authority, so by default it evaluates on a cadence and logs what it *would* pause without changing anything. Arm it deliberately with `monitoring.crashLoopPauser.dryRun: false` once you have seen a pass or two you agree with.

**It is now a declared guard.** It had been listed as exempt from the guard inventory on the grounds that it was "scheduler-internal mechanics, surfaced elsewhere" — a reason that quietly presumed it was running. Both the exemption and the missing construction were removed together, so `GET /guards` can now report whether it is genuinely on.

**Safety rails, unchanged and now verified end-to-end:** it never pauses a `critical` job, never pauses the built-in deny-list (`session-reaper`, `orphan-reaper`, `infrastructure-auto-fixer`), and never touches an already-disabled job. Slugs you add in config are **unioned** with that deny-list rather than replacing it, so naming one job of your own cannot accidentally make the reaper pausable.

## Evidence

**Reproduction of the defect, on the tree as it stood:**

```
grep -rn "new CrashLoopPauser" src/ tests/
```

**Observed BEFORE:** 8 matches, all in `tests/unit/crash-loop-pauser.test.ts`; **0 in `src/`.** The three
`src/` mentions of the name were two code comments and one `NOT_A_GUARD` exemption entry — no
construction anywhere on the running path. The live consequence, recorded 2026-08-05: a job at a
**492-run consecutive failure streak** with nothing pausing it, while the eight unit tests were green.

**Observed AFTER:** the boot path constructs it on the scheduler-enabled branch, on a 1h cadence with a
10m initial pass, registered in the guard inventory as `monitoring.crashLoopPauser`.

**The load-bearing evidence is not that the new tests pass — it is that they FAIL without the fix.**
The ratchet was proven by injection rather than by assertion:

| injection | expected | observed |
|---|---|---|
| remove the boot construction (the exact pre-B3.1 state) | ratchet fails | **exit 1 — failed** |
| restore the stale `NOT_A_GUARD` exemption | ratchet fails | **exit 1 — 1 failed / 7 passed** |
| control: tree restored | all pass | **exit 0 — 8 passed** |

A test that passes on a fixed tree proves only that it does not fire indiscriminately. These two
injections are what establish it tests the thing that was broken.

**Seeded end-to-end behaviour**, asserted against the jobs file on disk rather than the return value's
account of it: four seeded `tool_use_incomplete` failures → the job is `enabled: false` on disk, carries
a `_crashPauseNote` naming the reason, count, and last error, and a provenance line lands in
`crash-loop-pauses.jsonl`. The hold-back side is covered in the same run — dry-run leaves the file
byte-identical, and a `critical` job crash-looping twenty times, a deny-list job, and a healthy job are
all left enabled.

## Summary of New Capabilities

- `monitoring.crashLoopPauser.enabled` (default `true`) — master switch.
- `monitoring.crashLoopPauser.dryRun` (default `true`) — log intended pauses without disabling anything.
- `monitoring.crashLoopPauser.intervalMs` (default 1h) / `initialPassDelayMs` (default 10m).
- `monitoring.crashLoopPauser.windowHours` / `failureThreshold` / `shortRunThreshold` — detection tuning.
- `monitoring.crashLoopPauser.neverPause` — extra job slugs, added to the built-in deny-list.
- `monitoring.crashLoopPauser` now appears in `GET /guards`.
- `<stateDir>/crash-loop-pauses.jsonl` — provenance for every real pause.

## What to Tell Your User

If one of your scheduled jobs starts failing over and over, your agent will now notice and tell you which one — and, once you arm it, stop running it until you have had a look. Nothing is deleted; the job is disabled with a note saying exactly why and what it was failing with, and you can turn it back on whenever you want.

Out of the box it only watches and reports. Ask your agent to arm it when you are ready for it to act.

<!-- user_announcement
audience: user
maturity: preview
-->
