# Side-effects review — scheduler-never-run-window

**Change:** the startup missed-job sweep no longer treats every job with no
`lastRun` as overdue. A new `JobState.firstSeenAt`, stamped once at
registration, lets it apply the rule its own comment already described: a
never-run job is missed only if it has existed longer than one of its own
intervals.

**Motivation:** ACT-724 defect (a) — a hand-built future-dated reminder job
discharged itself on the next boot. This is the prerequisite for the ACT-724
standard proper (dated commitments materializing one-shot reminders); that
standard is NOT in this change.

---

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

**One real, deliberate narrowing.** A never-run job that has existed for *less*
than one interval is no longer triggered at startup. It waits for its next cron
window instead.

That is the intended behaviour — it is the difference between "scheduled" and
"whenever we happen to reboot" — but it is a genuine behaviour change and the
cost is honest: on a machine that restarts frequently, a newly-added job may now
first run at its scheduled time rather than within seconds of being added.

**Legacy state is also narrowed.** A job whose state predates `firstSeenAt` and
has no `lastRun` is treated as not-missed rather than fired. This affects the
first boot after upgrade only: registration stamps `firstSeenAt` for every job
that lacks it, so from the second boot the rule applies normally. Chosen
deliberately — see §4.

## 2. Under-block — what failure modes does this still miss?

- **A job added while the server was down still can't be dated precisely.**
  `firstSeenAt` is stamped when the scheduler first *sees* the job, not when its
  file was written. A job created during a three-day outage is stamped at boot
  and so waits up to one interval before catching up. Using file mtime would be
  more precise and less trustworthy (mtime changes on unrelated edits, syncs,
  and checkouts). Named rather than silently accepted.
- **Interval is inferred from the next two cron occurrences.** For irregular
  crons (`0 3 1 12 *`, `0 9 * * 1-5`) the gap between the next two runs is not a
  constant period. It is a sound *lower-ish bound* for the comparison here, but
  it is an approximation, and it is the same approximation the pre-existing
  `lastRun` branch already relies on. Not made worse; not fixed either.
- **Nothing yet asserts one-shot semantics.** ACT-724 asks for first-class
  one-shot jobs. This change makes cron-scheduled future jobs safe at boot; a
  true one-shot type (fire once, then retire) is still absent, and the reminder
  feature will need it.

## 3. Level-of-abstraction fit

Right layer. The missing thing was a *fact* ("when did this job start
existing?"), so the fix adds the fact at the point that knows it — registration
— and the decision stays where it was, in the sweep.

The alternative considered and rejected: seeding `lastRun` at registration.
That would have suppressed the symptom with less code, but it lies — it records
a run that never happened, corrupting run history, `runCount` semantics, and any
future "when did this last actually execute?" question. A separate field keeps
"registered" and "ran" as the distinct facts they are. ACT-724's own sketch
floated the `lastRun`-seeding option; this is a deliberate departure from it.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`. The sweep holds real authority — it *triggers
jobs* — and it is deterministic, which is appropriate: "has this job existed
longer than its interval?" is arithmetic over two timestamps, not a judgment.
There are no competing signals to weigh.

**The direction of failure is the load-bearing property.** Every unknown case
now resolves to *not firing*: missing `firstSeenAt`, unparseable `firstSeenAt`,
uncomputable interval. That is the safe direction, and asymmetrically so — a
skipped catch-up costs one delayed run, while a wrongly-fired future job marks
itself delivered and will never fire again, so nobody goes looking for it. A
missed reminder that looks delivered is worse than one that is merely late.

The registration write is wrapped: a bookkeeping failure logs and continues
rather than preventing the scheduler from starting, and the absent field then
degrades to not-firing.

## 5. Interactions

- **The `lastRun` branch** — untouched. Jobs with run history take the identical
  path (`timeSinceLastRun > intervalMs * 1.5`).
- **Priority sorting and trigger limits** — untouched; a never-run job that does
  qualify still enters with `overdueRatio: 1.5` exactly as before.
- **`tests/unit/JobScheduler.test.ts`** — its `beforeEach` pre-seeds `lastRun`
  "so checkMissedJobs doesn't trigger jobs at startup". That workaround is now
  unnecessary but remains harmless and was left alone; removing it is unrelated
  churn in a file this change does not otherwise touch.
- **`tests/unit/job-scheduler-edge.test.ts`** — one existing test asserted the
  buggy behaviour ("triggers jobs that have never run on startup"). It was
  written for a real concern (never-run jobs being skipped forever) and had
  over-corrected. **Updated, not deleted:** it now seeds `firstSeenAt` a day in
  the past so it exercises the scenario it was actually written for, and a
  sibling test pins the other side of the boundary. Called out explicitly
  because editing a test to make a change pass is exactly the move that needs
  scrutiny.
- **StateManager** — `firstSeenAt` is additive and optional; older state loads
  unchanged, and no migration is required.

## 6. External surfaces

- No route, config key, flag, env var, CLI surface, message, or notification.
- `JobState` gains one optional field, persisted in existing job-state files.
  Additive; nothing reads it but the sweep.
- **User-visible behaviour:** the disappearance of unexplained job runs after a
  restart. No new output.
- No timing dependence beyond what the sweep already had.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN** — `machine-local-justification: hardware-bound-resource`.

Job run state is per-machine because job *execution* is per-machine: each
machine runs its own scheduler over its own scoped jobs, and "when did this
machine first register this job?" is inherently a fact about that machine's
scheduler, not a fleet fact. Replicating it would be actively wrong — machine B
adopting machine A's `firstSeenAt` would make a job that B has never registered
appear to have existed for days, re-creating the immediate-fire bug through the
mesh.

This is inherited, not introduced: `JobState` (`lastRun`, `runCount`,
`consecutiveFailures`) is already machine-local for the same reason, and this
field joins it. No new cross-machine surface, no notice, no durable shared
state.

## 8. Rollback cost

**Revert the commit.** Reverting restores the fire-everything behaviour; the
orphaned `firstSeenAt` values in job-state files are ignored by the old code and
harmless. No migration, no data repair, no flag.

## Second-pass review

**Required** — this touches session/job lifecycle (it decides whether a job is
triggered), which is on the Phase-5 trigger list.

Self-review, recorded rather than skipped, with the two things I went looking
for:

1. **Did I make a test pass by weakening it?** One existing test was changed.
   It asserted "any never-run job fires at startup" — the exact behaviour being
   fixed — so it could not survive intact. I preserved its *intent* (a never-run
   job must not be skipped forever) by giving it a past `firstSeenAt`, and added
   the missing opposite-side assertion. The suite ends with strictly more
   coverage of this boundary than it had: 2 tests where there was 1, plus 3 in a
   dedicated file.
2. **Is the new failure direction actually safe?** Every uncertain path leads to
   "don't fire". The worst case is a delayed run; the previous worst case was a
   reminder silently discharging itself early. Verified by test rather than
   asserted: the annual-cron case and the fresh-daily case both stay at zero
   triggers, and the genuinely-overdue case still fires.

Full scheduler suite re-run: 76 tests across 8 files, all green.
