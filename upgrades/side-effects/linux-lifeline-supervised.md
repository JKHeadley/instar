# Side-Effects Review — Linux lifeline is marked supervised; watchdog self-restarts get a daily cap

**Version / slug:** `linux-lifeline-supervised`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2, driven by the converged spec `docs/specs/linux-lifeline-supervised.md` (5 rounds; report in `docs/specs/reports/`). Four source files:

- `src/commands/setup.ts`: `SYSTEMD_SUPERVISED_ENV_LINE`, added to `buildLinuxSystemdUnit`.
- `src/core/PostUpdateMigrator.ts`:
  - `addSystemdSupervisedEnv`;
  - `migrateSystemdSupervised`, wired right after `migrateSystemdKillMode`.
- `src/lifeline/rateLimitState.ts`:
  - `WATCHDOG_DAILY_CAP = 6`;
  - the storm count now includes the decided restart;
  - malformed history entries now read as corrupt.
- `src/lifeline/TelegramLifeline.ts`: `selfRestartExhausted` and `restartStateCorrupt` reports, each once per process; wires `recordExit`.
- `src/lifeline/RestartOrchestrator.ts`: `recordExit` dependency, called once immediately before exit.

Tests: `tests/unit/linux-lifeline-supervised.test.ts` (new, 17) and `tests/unit/lifeline/rateLimitState.test.ts` (storm test rewritten, cap test added).

Effort: 5 spec rounds against a cap of 6. They went to defects review found in the restart foundation this switches on: no total bound, a storm alarm that could never fire, unvalidated entries. Not to wording.

## Decision-point inventory

- `detectLaunchdSupervised` — pass-through; Linux now supplies signal 1.
- `RestartOrchestrator` exit — pass-through; now reachable on Linux for `watchdog`, `versionSkew` and `plannedUpgrade`.
- `decide` watchdog daily cap — add; an invariant budget on a self-action.
- `decide` storm count — modify; it is a signal only.
- `readRateLimitState` entry check — modify; the existing fail-closed rule now covers each entry.
- Migration "patch this unit?" — add; skips any unit that already names the variable.

## 1. Over-block

A condition that a 7th or later watchdog restart within 24h would have fixed now waits for the window to roll over. That is accepted and reported (spec trade-off, Luna's 2026-10-12 data). A history file written by an older version passes the new entry check. The reviewer verified this against the writer's shape since #1893, and against the real files of echo, sagemind and groky on the Studio.

## 2. Under-block

A restart storm whose restarts are spread out never trips `restartStorm`. `selfRestartExhausted` covers it at the first refused restart, once per process. A process that survives the window rolling over does not report a second exhaustion episode (left behind). Clock skew allows one restart outside the caps per skew event (existing).

## 3. Level-of-abstraction fit

Correct. The variable is the same signal macOS uses, written in the same file type that owns process supervision. The cap lives in the rate-limit decision that already owns the cooldown and the version-skew cap.

## 4. Signal vs authority compliance

Complies. `stormActive` and the two new reports are signals. The cap is a deterministic budget on a self-triggered action: a floor, not a brittle judgment. It holds no authority over messages or user actions, only over whether the lifeline restarts itself.

## 4b. Judgment-point check

There is no competing-signals decision point. The cap is a fixed bound on a self-action (No Unbounded Self-Action); the spec classifies every row as invariant.

## 5. Interactions

- On Linux, `plannedUpgrade` and `versionSkew` restarts now happen. A Linux lifeline loads new code after a major or minor update instead of waiting for a reboot. The existing cap is 3 per 24h, shared by both.
- A watchdog exit tries to stop the server inside the existing 1s quiesce budget. A server that is still up is adopted by the next lifeline, so no second server starts. This is existing macOS behaviour.
- The macOS fleet gains the daily cap. Echo's busiest day had 3 restarts; Luna's loop of 21 is exactly the case being capped.
- `isRestartStorm` (history only) is still ORed with `stormActive`, which is harmless.
- `migrateSystemdStableStart` and setup regenerate the unit from the template, which now carries the line. An operator opt-out belongs in a drop-in, documented in the spec.
- Self-triggered control: a restart that fixes the condition settles in one cycle. One that fixes nothing settles in at most 6 real (exited) restarts per rolling 24h, then raises one report and stays up. The ratchet `tests/unit/self-action-convergence.test.ts` is unaffected: no new controller, and an existing one is now bounded.

## 6. External surfaces

Linux agents:
- restart themselves when stuck, at a cost of one to two minutes without the agent per watchdog cycle;
- load new code after big updates.

All agents raise two new degradation features: `TelegramLifeline.selfRestartExhausted` and `TelegramLifeline.restartStateCorrupt`. Linux unit files gain one line, with a `.bak-<ts>` copy written beside them.

## 7. Multi-machine posture

Machine-local by design (`machine-local-justification: hardware-bound-resource`): each host's systemd supervises the lifeline on that host. The rate-limit file is per agent home. No notices are fanned out across machines; a degradation is raised by the machine that has it. There is no durable shared state and no URLs. No status surface changes.

## 8. Rollback cost

- **Code:** revert the commit.
- **Unit files already patched:** they keep the line, which leaves Linux behaving like macOS. The `.bak-<ts>` copy restores the exact prior file.
- **No data migration:** the rate-limit file shape is unchanged.

## Conclusion

Ship. The change is the parity fix plus the bound that makes it safe to switch on.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent, 2026-11-05 17:00 PST.

**Concern raised:** suppressed restarts use up the new watchdog cap. `initiateRestart` writes the history entry before `requestRestart`, and the orchestrator can then decline to exit (unsupervised, or shadow install updating), but the cap counted every watchdog entry. The consequences:
- A manual or pre-migration Linux lifeline would fill the cap with attempts that never ran.
- It would raise a false `selfRestartExhausted`.
- The supervised service starting later in the same agent home would be refused its first real self-heal for up to 24h.

The reviewer also confirmed:
- no restart loop, and no exit without a respawner;
- the stricter entry check is safe, because the only writer always wrote valid buckets;
- the migration is idempotent and keeps CRLF, the backup and an operator `=0`.

**Resolution:**
- Entries gain `exited`. `RestartOrchestrator` calls a new `recordExit` dependency (`markLatestRestartExited`) once, immediately before `exitFn`, on both the normal and the hard-kill path. The cap counts only `exited: true`.
- The entry is still written at the allowed attempt, so the cooldown keeps throttling unsupervised attempts to one per 10 minutes.
- Tests added: the orchestrator records nothing when suppressed or deferred, and records exactly once before exit; unexited and pre-upgrade entries do not count toward the cap.
- 82/82 pass across `linux-lifeline-supervised`, `rateLimitState`, `rateLimitState-plannedUpgrade`, `RestartOrchestrator`, `version-skew-recovery` and `drift-restart-keeps-server`.

**Independent read of the artifact: concur after revision.** The fix is the one the reviewer proposed.

## Evidence pointers

- `docs/specs/reports/linux-lifeline-supervised-convergence.md`.
- Drill journal (fresh-2, 2026-11-06 00:01–00:04Z): `would restart (trigger=conflict409Stuck) but unsupervised; skipping exit` every 30s.
- Luna history: `~/.instar/agents/sagemind/.instar/last-self-restart-at.json` (21 × `conflict409Stuck` on 2026-10-12).

## Class-Closure Declaration (display-only mirror)

- `defectClass`: `unbounded-self-action`.
- `closure`: `guard`.
- `guardEvidence`:
  - `enforcementType`: `gate`.
  - `citation`: `src/lifeline/rateLimitState.ts#decide` (WATCHDOG_DAILY_CAP) and `tests/unit/linux-lifeline-supervised.test.ts` ("the watchdog restart brake has a total").
  - `howCaught`: the restart loop's edge (watchdog trip → exit → respawn → trip) now has a count bound of 6 per 24h, a steady state of "stay up, one report", and a settling brake. The cap refuses the 7th restart, and the test fails if the 7th is allowed.
