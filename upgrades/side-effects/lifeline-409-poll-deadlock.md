# Side-Effects Review — a stale 409 count no longer stops a machine from polling after it regains the lease

**Version / slug:** `lifeline-409-poll-deadlock`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 4 files, about 80 lines (28 in `src/`). `src/lifeline/pollDecision.ts` gains `hasRecent409()` and `RECENT_409_WINDOW_MS` (120s). `src/lifeline/TelegramLifeline.ts` records when the last 409 arrived and feeds `decidePollAction` a time-bounded "recent 409" instead of the raw counter. When poll-follows-lease stops the poll because the lease was lost, it clears only `conflict409StartedAt` (a standby is not in a 409 fight), keeping the count and its time; a new 409 restarts `conflict409StartedAt` whenever it is unset. Effort: no spec round (Tier 1), one second-pass round that changed the design (see below), first commit attempt.

Found live on the two-server takeover drill (topic 137054, 2026-11-06 00:01Z): after a link cut both machines polled and got 409s; on heal fresh-2 stood by; when fresh-1 was powered off fresh-2 took the lease but never polled again. `consecutive409s` is only reset by a successful poll, and since #2759 the START gate holds while it is above zero, so the machine could never make the poll that would reset it. The watchdog's `conflict409Stuck` exit-for-restart is the only way out and it is skipped on Linux (separate defect, tracked below). Messages went unanswered for the whole outage.

## Decision-point inventory

- `decidePollAction` START gate (`src/lifeline/pollDecision.ts`) — pass-through; the rule is unchanged ("hold while another machine is polling"). Only its input changes.
- `recentLocal409` / `anotherMachinePolling` inputs (`TelegramLifeline.reconcilePolling`) — modify: count > 0 AND last 409 within 120s, instead of count > 0.
- Lease-loss STOP branch (`TelegramLifeline.reconcilePolling`) — modify: also clears the watchdog's conflict start (`conflict409StartedAt`); the 409 count and its time are kept.

## 1. Over-block

No issue identified. The change only removes a hold; it rejects nothing new.

## 2. Under-block

The START gate can now start a poll while another machine is still polling, if no 409 arrived here for 120s. That can only happen when this machine was not polling (409s arrive only to a poller), and in that case the old counter was not evidence either. A lease that flaps back within 120s of a 409 still holds, as before. If another machine really is polling, the new poll gets a 409 within one long-poll and the existing backoff and reclaim path takes over, exactly as on a first start. The lease decides who should poll; the 409 signal is a backstop.

Still missed: the Linux systemd unit has no `INSTAR_SUPERVISED=1`, so the watchdog restart backstop never fires on Linux. Not needed for this fix, but a real gap of its own. <!-- tracked: topic 137054, feedback fb-8af3913e-254 "Linux lifeline self-restart never fires" -->

## 3. Level-of-abstraction fit

Right layer. The pure decision stays a pure truth table; the bug was the lifeline feeding it an unbounded memory as if it were a current signal. The freshness rule lives next to the decision as a pure helper so it is tested on both sides of the boundary.

## 4. Signal vs authority compliance

Complies. The 409 count is a signal; the lease intent from the server is the authority on who polls. This change stops a stale signal from overriding the authority forever.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The 120s window is a freshness bound derived from an invariant (the longest 409 backoff is 60s, so a live conflict always lands a fresh 409 inside 120s).

## 5. Interactions

- `LifelineHealthWatchdog` `conflict409Stuck`: reads `conflict409StartedAt`. Clearing it on lease-loss stop means a standby no longer trips "409 stuck" for a poll it is not running. That is correct: before, a standby kept requesting restarts every 30s (seen in the drill journal). Because the count is kept, the 409 handler now also sets the start time when it is unset, so a new fight after standby is still timed.
- The 20th-409 reclaim path and backoff are unchanged.
- Boot hold (`bootHoldStep`) unchanged; the boot-expired start does not consult the 409 gate.
- Self-triggered control: the start is still single-flight (`pollStartPending`), still waits the 20s debounce, still re-checks the lease intent after the flush, and a fresh 409 still holds. Steady state: one start attempt per lease-awake transition; no new loop.

## 6. External surfaces

User-visible: a machine that takes over after a link cut now answers messages instead of staying silent. No new route, config key or file.

## 7. Multi-machine posture

Machine-local BY DESIGN: the 409 count is this machine's own observation of its own polls. The fix exists for multi-machine operation: it lets the lease holder poll. No notices, no durable state, no URLs. No status surface changed.

## 8. Rollback cost

Revert the commit. No state, migration or config involved.

## Conclusion

Ship. Narrow input fix; the decision rule and its other guards are unchanged; covered by drill-shaped tests that fail without the fix.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent, 2026-11-05 16:12 PST
**Round 1: Concern raised.** The first version reset `consecutive409s` on the lease-loss stop. That throws away fresh 409 evidence: a lease that flaps away and back after the 20s debounce would start a second poller while the peer was still polling, the case #2759 exists for. The time bound alone fixes the deadlock. The reviewer suggested keeping the count and time, clearing only `conflict409StartedAt`, and setting it again on a 409 whenever it is unset. It also confirmed 120s is longer than any gap between 409s while polling (60s backoff cap, 60s getUpdates timeout), that 401 and force-mute stops are covered, and that the watchdog is not harmed. It asked for tests on the flap-back hold, the 409-after-standby watchdog timing, and a stale count after a 401.
**Resolution:** adopted exactly as suggested; all three tests added. The watchdog test fails without its one-line change; the drill test fails without the time bound. 62/62 pass across the four lifeline poll test files.
**Independent read of the artifact: concur after revision** (the design now matches the reviewer's recommendation).

## Evidence pointers

- `tests/unit/lifeline-poll-start.test.ts` — "409s from an earlier poll do not block the next start" (drill, flap-back hold, stale count, 401 stale count, fresh 409 hold) and "the watchdog still times a new 409 fight".
- `tests/unit/pollDecision.test.ts` — `hasRecent409` both sides of the window.
- Drill log: `.instar/vm-test/takeover-drill-137054/fresh-pair/run8-stageB-rerun.log` (agent home), journal lines `conflict409Stuck ... unsupervised; skipping exit`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (TypeScript runtime logic; no prompt, hook, config, skill or standards text).
