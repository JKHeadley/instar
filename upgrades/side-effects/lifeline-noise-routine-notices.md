# Side-Effects Review — Lifeline noise: routine job finishes and "not sure" stop notices

**Version / slug:** `lifeline-noise-routine-notices`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent, see below`

## Summary of the change

Tier 1: a revert fully undoes it; no stored state changes shape. Two notices
that reached the Lifeline topic on normal events are narrowed.

1. `ReapNotifier` (per-topic mode): an unbound reap (no conversation) with reason
   `sentinel-complete`, not mid-work and with no queued resume, is no longer added
   to the Lifeline notice. Its `reaped` row in the reap-log is unchanged.
   Topic-bound reaps, mid-work reaps, queued-resume reaps and every other unbound
   reason notify as before. The legacy `perTopic:false` rollback path is untouched.
2. `StopNotifier`: `escalate` (the stop gate's "not sure") is log-only. The
   `shadow + continue` notice goes to the run's own topic, names the run by the
   goal in `.instar/autonomous/<topic>.local.md` (only when `active: true`, not
   paused), and quotes its last message (the hook's last `agent` turn; the stop
   reason only as a fallback when it reads as a sentence, never a bare code like
   `end_turn`). With no resolved topic or no live goal it
   is log-only. The lifeline `SentinelNotifier` sink for stop notices is removed;
   `server.ts` now sends with `telegram.sendToTopic` and writes the same
   `stop-notify` rows to `logs/sentinel-events.jsonl`.

Also: `liveAutonomousRunGoal()` in `AutonomousSessions.ts`, the evaluate route
passes `topicId`/`runGoal`/`lastActivity`, the CLAUDE.md template sentence plus an
idempotent in-place migration of the installed sentence, and amendments to both
driving specs (NOTIFY-ON-STOP-SPEC Layer B; reap-notify R1.1).

Size: 6 src files, about 120 lines of src. Effort: one design pass, no spec rounds.

## Decision-point inventory

- `ReapNotifier.trackAffected` unbound branch — modify — adds the routine-completion exclusion.
- `isNotifyWorthyStop` — modify — `escalate` leaves the notify set.
- `StopNotifier.maybeNotify` — modify — adds the named-run gate; changes the destination.
- Stop gate decision itself — pass-through — unchanged; nothing here blocks a session.

## 1. Over-block

Nothing is blocked; these are notices. Cases now quieter that someone might want:
a job that ran far past its expected time and then completed (still in the
reap-log, still visible via the job's own run history); an `escalate` on a run
that really did stall (the gate had no evidence, so the user could not act on it
either; it is in sentinel-events and the stop-gate DB); a stall whose run file was
removed or set `active: false` before the stop was judged.

## 2. Under-block

A `continue` on a named run can still be a false positive from the gate; the
30-minute per-session dedup and the unattended gate bound it. A reap whose reason
is `sentinel-complete` but whose work was in fact unfinished relies on the
mid-work stamp from the kill chokepoint; if that stamp misses work, the notice is
missed (the same exposure the per-topic path already has).

## 3. Level-of-abstraction fit

Both changes sit in the existing notifier decision layers that already own
"should the user hear about this". The reap filter is beside the existing silent
cases (`recovery-bounce`, operator kills). The stop gate stays the authority on
the stop; StopNotifier only decides whether to tell the user.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The notifiers decide only whether a message is sent. Nothing gates a session,
a reply, or a kill.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. `sentinel-complete
&& !midWork && !resumeQueued` is an enumerable "normal finish" invariant, and the
named-run test is a file-state fact, not a judgment.

## 5. Interactions

- **Shadowing:** Layer A (autonomous terminal exits) still announces every run
  end in its report topic, so removing the lifeline `escalate` notice does not
  silence a finished autonomous run.
- **Double-fire:** a named-run stall notice and a Layer A notice could both land
  in the same topic only if the run hit a terminal condition at the same stop; the
  stop gate's `continue` and the autonomous hook's terminal exit are different
  turns, so this is not expected; both would be accurate.
- **Races:** the run file is read once per evaluation; a run ending at that moment
  yields either a named notice or log-only, both acceptable.
- **Feedback loops:** a notice in the run's topic is a bot outbound message, which
  does not trigger a session; only a user reply does.

## 6. External surfaces

Telegram: fewer Lifeline messages; stall notices move to the run's own topic.
Logs: `stop-notify` rows keep their kinds (`escalated`, `escalation-sent`,
`notify-error`) and add `escalation-suppressed` for log-only outcomes. The
reap-log is unchanged. CLAUDE.md: the two sentences that describe lifeline reap
notices (the Reap-log section and the Mid-Work Resume Queue section) are updated
in the template and patched in place on existing agents.
No operator-facing actions.

## 7. Multi-machine posture

Machine-local by design: each machine notifies for sessions it runs and reaps
(the reap notifier and stop gate are already per-machine; the reap-log has the
existing `scope=pool` merged read). The topic send goes through that machine's
Telegram adapter like every other per-topic notice. No new durable state, no URLs.

## 8. Rollback cost

Pure code change; revert and ship a patch. The CLAUDE.md sentence would keep the
new wording until a later migration, which is harmless. `monitoring.notifyOnStop.enabled:false`
still turns the stop notice off live.

## Conclusion

The two Lifeline messages came from normal events: a job on a five-minute
schedule ending normally, and the stop gate's default "not sure" answer. Both
now stay in the logs. The one stop notice that can be acted on is kept,
attributed to a named run with its last message, and sent where a reply reaches
the run. This narrows NOTIFY-ON-STOP-SPEC Layer B, stated in the spec amendment.

## Second-pass review

**Reviewer:** independent general-purpose subagent, two rounds

Round 1 raised two concerns. (1) The migration patched only the Mid-Work Resume
Queue sentence; the Reap-log section's own sentence (templates.ts) was left stale
on existing agents. Fixed: a second idempotent replacement plus a test. (2) The
notice's "last message" came from `stopReason`, which the hook fills from the
harness `stop_reason` first, so it could quote `end_turn`. Fixed: the route uses
the last `source:'agent'` turn the hook always appends, falling back to the stop
reason only when it reads as a sentence; the integration test now sends
`stopReason: 'end_turn'` and asserts it is not quoted. Everything else (topic id
types, stateDir paths, the shadow-deferred path, async send errors, sanitization,
reap filter scope) checked out.

Round 2: Concur with the review; both concerns are fixed.

## Evidence pointers

Studio, 2026-11-01: reap-log 19:00–22:20Z had 71 `sentinel-complete` reaps of
unbound `job-health-check-*` / `job-feedback-factory-execute-*` sessions, all
`midWork:false`, notices to the lifeline topic 40387. Stop-gate DB last 24h:
391 allow, 52 escalate, 1 continue, 9 fail-open; sentinel-events shows the
escalate notices. Tests: `tests/unit/StopNotifier.test.ts`,
`tests/unit/reap-notifier.test.ts` (routine-completion suite),
`tests/unit/autonomous-run-goal.test.ts`, `tests/unit/stop-notifier-wiring.test.ts`,
`tests/unit/PostUpdateMigrator-resumeQueueSection.test.ts`,
`tests/integration/stop-notify-named-run-route.test.ts`; existing reap-notify
integration and e2e lifecycle tests pass unchanged.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "narrows when two existing notifiers send; adds no new loop, retry or self-triggered action"}`
