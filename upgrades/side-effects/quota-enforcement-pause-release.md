# Side-Effects Review — quota-enforcement scheduler pause releases on recovery

**Version / slug:** `quota-enforcement-pause-release`
**Date:** `2026-09-24`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see bottom)`

## Summary of the change

`SessionMigrator`'s enforcement tiers (`enforced_pause` at ≥90% 5-hour,
`enforced_kill` at ≥95%) called `pauseScheduler()` and nothing ever called
`resumeScheduler()` for them — only the account-migration paths resume. A
paused scheduler skips every trigger silently (skip-ledger only, no event), so
a brief spike froze every scheduled job until a server restart. Originating
agent, 2026-09-24: brake at 04:32Z (21:32 PDT), readings back under threshold
by ~07:38Z, jobs dark until a manual restart at 16:43Z — ~12h, blocking an
operator-approved trial. The notice said "Manual intervention required" and
never reached the operator.

The migrator now records that IT took the pause (`enforcementPaused`, in
memory) and `releaseEnforcementPauseIfRecovered()` resumes the scheduler when
the 5-hour rate (if known) is below `fiveHourPercent − 5` (hysteresis; 83% at
default) AND weekly is below `weeklyPercent`. Called at the top of
`checkAndMigrate` (before the cooldown) and from `QuotaManager` on every
collection, before the estimated-data early return. Emits `enforced_resume` →
one notification. Notice text no longer claims manual intervention.

## Decision-point inventory

- **Modified:** the quota-enforcement scheduler pause (a gate) gains a release
  condition. The per-job quota gate (`canSpawnSession` → tracker thresholds by
  priority) is unchanged and still screens every trigger after release.

---

## 1. Over-block

Removes an over-block: the permanent pause. Nothing newly blocked.

## 2. Under-block

After release, jobs run only if the per-job gate admits them, so a scheduler
released at e.g. 80% still sheds low-priority work per the tracker thresholds.
If quota re-spikes, the next `checkAndMigrate` re-pauses (the pause→kill
escalation path is untouched). An unknown 5-hour reading with healthy weekly
counts as recovered — deliberate: a paused scheduler produces no turns, so
waiting for a fresh reading can re-create the permanent stall; the per-job
gate still carries the protection.

## 3. Level-of-abstraction fit

The release lives with the only component that knows it took the pause (the
migrator), so an operator or migration pause is never released by it. The
quota poll is the existing cadence that already drives enforcement.

## 4. Signal vs authority compliance

The pause is an existing authority driven by numeric thresholds; this adds its
symmetric release on the same numeric inputs with hysteresis. No brittle
judgement added. Release loosens toward the pre-existing per-job gate, never
past it.

## 5. Interactions

- Migration paths call `resumeScheduler()` themselves; releasing a flag that a
  migration already cleared is an idempotent `resume()`.
- `resume()` also re-activates failure-alert delivery and drains the queue —
  the same effects as every other resume.
- Cooldown: release runs before the cooldown check so a recovered reading
  inside the cooldown still releases.
- The 95% escalation bypass is untouched.

## 6. External surfaces

One new user notification ("Scheduler resumed — quota recovered") through the
existing batched quota notice path, at most once per enforcement episode. The
kill notice's wording changes from "Manual intervention required" to "resumes
on its own once quota recovers".

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: each machine's scheduler and quota poll are local;
the pause and its release were already per-process.

## 8. Rollback cost

Revert the commit: the pause returns to permanent-until-restart. No state,
config or migration involved (the flag is in-memory).

---

## Second-pass review

Independent reviewer subagent, 2026-09-24: **Concur with the review.** It raised two minor gaps, and both are fixed in this change:

1. The migration paths that resume the scheduler did not clear `enforcementPaused`, which could lead to a redundant resume and a false "Scheduler resumed" notice. Every migrator resume now clears the flag. This is covered by a new test: a successful migration after an enforcement pause clears the flag, and no later notice follows.
2. The release call sat before `checkAndMigrate`'s own migration-in-progress guard. It has been moved after that guard.

The reviewer also noted that the scheduler's `paused` flag is one shared boolean, and the migrator is currently its only caller. The doc comment now says so, and states that a future operator pause needs its own flag.

## Follow-up (CI: silent-fallback ratchet)

The catch around `resumeScheduler()` in the release originally only logged the failure. It now reports through `DegradationReporter`, because a failed release leaves the scheduler frozen, which is exactly the condition that must not stay silent. The flag stays set, so the next quota collection retries the release.
