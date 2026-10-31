# Side-Effects Review — queue pace (measure every work queue; bounded triage tuner)

**Version / slug:** `queue-pace`
**Date:** `2026-10-30`
**Author:** `echo`
**Second-pass reviewer:** `required — independent subagent (see Second pass below)`

## Summary of the change

An hourly ledger measures each work queue (feedback triage, feedback fixes, maturation fixes,
commitments, evolution actions): items in, done, left for other reasons, open; a disjoint verdict;
the bottleneck from service-written evidence. A tuner may ask the triage service for extra ticks when
the worker itself is the limit, inside every existing limit. A `GET /queue-pace` route, a console
Pace card, a board pace line, and heal-exhausted-only notices. Spec: `docs/specs/queue-pace.md`
(converged, 6 rounds).

## Decision-point inventory

Verdict, bottleneck kind, tuner extra tick, escalation raise/clear — all invariant (deterministic
over recorded evidence; `unknown` on any doubt, which only stops the tuner).

## 1. Over-block

The tuner never blocks anything. Notices could fire wrongly only after 24 h of heal exhaustion on
fully covered data; person-bound work never raises one.

## 2. Under-block

The tuner acts only on positive `worker` evidence; if the daily call cap binds first (likely for a
large backlog), it never acts and the card names the cap. Snapshot-only transitions are marked
incomplete and excluded from tuning.

## 3. Level-of-abstraction fit

Reads existing owners; the only owner change is triage writing its own tick/refusal rows and exposing
quota/calls accessors. The tuner calls the service's existing `acceptTick()` entry.

## 4. Signal vs authority compliance

The ledger is a signal. The tuner's authority is bounded to adding service ticks the scheduled job
could already have run, under the service's own gates; it never raises a limit.

## 4b. Judgment-point check

No model judgement; deterministic.

## 5. Interactions

Extra ticks share the triage service's single flight, rate limit, quota pause and daily call cap with
the scheduled job; a busy service is a skip. SelfActionGovernor class `queue-pace-extra-run`
(observe-only) counts the tuner's decisions; `feedback-triage-tick` keeps counting calls.

## 6. External surfaces

New read route (Bearer), console card, board line, CLAUDE.md template section and migration. Extra
triage ticks spend triage model calls inside the existing daily cap; tuner ships off on the fleet and
dry-run on dev.

## 6b. Operator-surface quality

Answers "is this pile shrinking?" in one plain line per queue; work waiting on the operator is shown
neutrally.

## 7. Multi-machine posture

Rows keyed per machine and owner; feedback queues measured on the operated host; commitments and
evolution per machine; pool read merges; tuner only on the operated host
(`physical-credential-locality`).

## 8. Rollback cost

`queuePace.enabled: false` (read live) stops everything; `queuePace.tuner.enabled: false` stops extra
ticks. Logs/state are safe to delete (ledger restarts with a baseline row; tuner fails closed for the
day).

## Class-Closure Declaration

- **Class:** `unbounded-self-action`
- **Closure:** `guard` — ratchet `tests/unit/self-action-convergence.test.ts` (controller
  `queue-pace-extra-run` registered in `src/testing/selfActionRegistry.ts`).
- **Convergence argument:** at most `maxExtraRunsPerDay` (≤12) extra triage ticks per local day, at
  least 10 minutes apart, each reserved durably before the call; any step-down starts a 6 h cooldown;
  notices are one deduped condition per machine and queue, raised only after self-heal is exhausted.

## Second pass

(see appended reviewer response)

### Second-pass reviewer response (independent subagent, 2026-10-30 22:27 PDT)

Concern raised (five items); the reviewer confirmed every safety boundary in code (tuner acts only
when enabled, live, owner serving, quota margin held, cap not projected, fresh worker re-check;
missing/corrupt state fails closed; `acceptTick()` is the only action; no HTTP route can forge worker
evidence; ledger crash order row-then-state; route auth/503/clamping; notices never for
person/cap/quota; governor observe-only; services unchanged with the feature off; migration sniff
guard).

**Resolutions (all applied, with tests):**
1. Dry-run notices no longer mark the live notice state open: dry-run decisions run on a separate
   shadow state, so the first live raise after `notices.dryRun: false` still fires (new test: 40 h
   dry-run then live → exactly one raise).
2. The tuner writes no audit row on an agent where it was never on (new test: dark agent → no file).
3. The tuner audit is read once per local day (count kept in memory) and rows older than 30 days are
   dropped on that read (new test).
4. The governor's verdict is honoured: asked before anything is reserved; a non-allow verdict skips
   the tick and is audited (`governor-held`).
5. A peer's free-text bottleneck detail is never relayed; the pool view re-words it from its kind.

Concur with the review (after the fixes above).
