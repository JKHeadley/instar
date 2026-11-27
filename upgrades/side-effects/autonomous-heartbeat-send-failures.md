# Side-Effects Review — autonomous heartbeat: failed sends explain themselves, are spaced, and stop on a gone topic

## Summary of the change

Tier 1 (small, reversible by revert; no config, state format, or route change). Files: `src/monitoring/autonomousHeartbeatSendError.ts` (new, pure), `src/monitoring/AutonomousProgressHeartbeat.ts`, `src/commands/server.ts` (heartbeat wiring only), `src/testing/selfActionRegistry.ts` (two entries), two unit test files, release fragment, ELI16. About 330 added lines, most of them tests. Effort: no spec review rounds (Tier 1), one second-pass review.

Root cause, from the Studio's feature-evidence log (Nov 20–27): 107 "send failed" rows, 100 of them a `TypeError`, all from build 1.3.2010 between 2026-11-24 23:17 and 2026-11-25 00:00 UTC, on topics 147616, 130715 and 144319, one per topic per minute. The same topics posted normally right afterwards. A `TypeError` here is what Node's `fetch()` throws when the local POST /telegram/reply request breaks before any answer (reproduced in the unit test: a closed port gives `TypeError: fetch failed` with cause `ECONNREFUSED`). There was no fault specific to a topic shape. The defect was retry amplification: a failed send rolls back its reservation, which is correct because it must not consume budget, but the rollback meant the next one-minute tick retried at once. The Studio's server log no longer reaches back to Nov 24, so the reason the local route was unreachable for 43 minutes cannot be recovered. With this change the next occurrence records its cause code.

Changes:
1. The evidence row for a failed send now carries `errorName`, a scrubbed one-line `errorMessage` (at most 160 chars), `httpStatus` when the route answered, and `causeCode` when fetch itself failed. The note text is never recorded.
2. A per-topic, in-memory retry wait after a failed send, bound to the run that failed: 5m, 10m, 20m, then 30m at most. It resets on success, on a new run id, or when the topic leaves the active run set.
3. A refusal whose route error says the topic can no longer receive (thread not found/deleted/closed, chat not found, with status 4xx/5xx other than 409/429/503) marks the topic unreachable for that run. One error row and one `held` row are written, then the topic is re-checked at most once an hour (`UNREACHABLE_REPROBE_MS`), because a closed topic can be reopened and a missing chat can be a fixable membership problem. A re-check refused the same way writes no new row. A success, or a new run id, clears the mark.

Ladder note, stated honestly: the fleet error rate reads a 3-day window, so the Nov 24 burst ages out by about 2026-11-28 00:00 UTC even without this change. On the current build (1.3.2072) the measured failure rate was already 5 of 357 rows. This change keeps the next outage from becoming a burst, and it makes each failure explain itself.

## Decision-point inventory

- Heartbeat predicate `#8b` (new): skip a topic while it waits out its retry spacing, or for the rest of the run once it is marked unreachable. This only delays or withholds a progress note the heartbeat itself would have retried. It does not block any other sender.
- `isHeartbeatTopicGone`: a deterministic classifier over the route's own error text.

## 1. Over-block

A topic refused once by a transient error now waits 5 minutes instead of 1 before the next try. The note is a backstop shown after 30 or more minutes of silence, so a few minutes' delay is acceptable. A topic falsely classified as gone is retried hourly instead of every few minutes for the rest of that run. The classifier requires the route to have answered (not a transport failure), the status not to be 409/429/503, and Telegram's own deleted/closed wording. A new run (even back to back, without the topic leaving the active set), a successful hourly re-check, or a server restart gives the topic its normal cadence back. Normal replies and other senders are untouched.

## 2. Under-block

A topic that is gone but refused with wording outside the pattern is treated as transient and retried at most every 30 minutes, which is bounded. A restart clears the in-memory waits, so each topic gets one immediate try after boot, which is the same as before.

## 3. Level-of-abstraction fit

The retry policy belongs in the heartbeat, which owns its own reservation rollback. The reply route is shared by every sender and should not learn heartbeat-specific spacing. The classification regex mirrors the one `sentinelConsolidatedSend.ts` already uses for the lifeline topic.

## 4. Signal vs authority compliance

The heartbeat is a signal producer: a progress note. The new logic only reduces how often the heartbeat itself retries. It gains no authority over any other component's messages or sessions. Evidence rows are signals for the maturation ladder.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The retry spacing is a deterministic brake on a self-triggered retry, and "topic gone" is an enumerable error vocabulary from Telegram.

## 5. Interactions

- Reservation rollback is unchanged: a failed send still does not consume budget.
- The one-voice ProxyCoordinator lease: the wait check runs before the lease is taken, so a waiting topic never holds the lease.
- Suppression evidence: the new reasons `send-retry-wait` and `topic-unreachable` go through the existing change-of-reason dedup in server.ts. That writes one `held` row per reason transition, not one per tick.
- Other topics are independent: the state is keyed per topic, so a failing topic never delays another.

## 6. External surfaces

`status()` (and GET routes that serialize it) gains `sendRetryWaitingTopicIds` and `unreachableTopicIds`. Both are additive. Feature-evidence rows for `monitoring.autonomousHeartbeat` gain `errorMessage`, `httpStatus` and `causeCode` fields and a new `held` reason. Users see fewer repeated attempts. No message text changes.

## 6b. Operator-surface quality

No visible operator surface changes.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. Each machine's heartbeat sends only for topics it owns (`isLocalTopicOwner`), so retry spacing and the unreachable set describe this machine's own send attempts. If a topic moves to another machine, the new owner starts with a fresh try, which is correct because its route is a different process. The change emits no new user-facing notices, holds no durable state, and generates no URLs. Evidence rows already reach the fleet ladder through the shared evidence log.

Status surfaces: the two new `status()` fields are this machine's view only.

## 8. Rollback cost

Revert the commit. The state is in memory, so there is nothing to migrate or repair.

## Conclusion

Safe to ship as Tier 1. The defect was retry amplification of a short local outage, plus evidence that could not explain itself. Both are fixed and covered by tests that fail on the old code.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent, fresh context, not the author (2026-11-27).

Round 1: concern raised. (1) The unreachable mark was keyed by topic, not run, and never expired, so a back-to-back new run or a reopened topic stayed silent for the whole run. (2) The gone-topic registry entry did not model the run boundary. (3) Minor, not a regression: the local fetch and `response.text()` have no timeout. Applied: both marks now carry the run id and are dropped when it changes; a gone topic is re-checked hourly; a success clears both marks; the registry entry is a rate-floored eternal sentinel on `UNREACHABLE_REPROBE_MS`; three new tests cover these cases. Item 3 was left as is, because the route's reply body is a small JSON and the existing behaviour is unchanged.

Round 2: Concur with the review. Both marks are bound to the run id and cleared on a new run; a gone topic is re-checked at most hourly and reported once per run; a success clears both marks; the lease is always released; the registry entry uses the real 60-minute constant (979 tests across the three files pass).

## Evidence pointers

- `tests/unit/autonomousHeartbeatSendError.test.ts`: real fetch to a closed port reproduces the `TypeError` and its `ECONNREFUSED` cause; classifier boundaries.
- `tests/unit/AutonomousProgressHeartbeat.test.ts`, "failed sends are spaced, gone topics are dropped": the 43-minute, three-topic outage gives 4 tries per topic instead of 43; over 4 hours a gone topic is tried once plus 3 hourly re-checks, with one error row; a back-to-back new run gets a fresh try; a reopened topic posts at its re-check; a transient failure in one run does not delay the next. The spacing tests fail on the pre-change code.
- `tests/unit/self-action-convergence.test.ts`: the two new registry entries settle.

## Class-Closure Declaration (display-only mirror)

- `defectClass`: `unbounded-self-action`
- `closure`: `guard`
- `guardEvidence`: enforcementType `ratchet`, citation `tests/unit/self-action-convergence.test.ts` (registry entries `autonomous-heartbeat-send-retry`, `autonomous-heartbeat-gone-topic`). How it is caught: under a refusal that never clears, the retry entry drives the real `sendRetryWaitMs`, so tries are never closer than the 5-minute floor and never exceed elapsed/5m + 1. A one-minute retry like the one before this change breaks that floor. The gone-topic entry drives `UNREACHABLE_REPROBE_MS`, so re-checks of a closed topic are never closer than an hour.
