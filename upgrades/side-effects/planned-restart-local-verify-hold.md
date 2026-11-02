# Side-Effects Review — planned restarts wait for local verification

**Version / slug:** `planned-restart-local-verify-hold`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** independent reviewer subagent `/root/restart_second_pass`

## Summary of the change

Tier 1, narrow reversible restart coordination. `PlannedRestartVerifyGuard` reads the existing in-flight verifier marker and restart flag; `ServerSupervisor` and `ForegroundRestartWatcher` defer ordinary planned restarts for a live child; `LocalVerifyService` pauses new work while that request waits. `AutoUpdater` carries its existing force and maximum-deferral decisions across the process boundary. No new merge authority, config, or external API is added.

## Decision-point inventory

- Planned restart consumption in `ServerSupervisor` and `ForegroundRestartWatcher` — modified: a live, recent local-verify child temporarily defers an ordinary planned request.
- New verify admission in `LocalVerifyService` — modified: a recent planned request pauses new starts, giving a pending restart the next turn.
- Updater restart request serialization — modified: an explicit force or reached four-hour ceiling records the existing bypass decision for the other processes.
- Full-suite pass and merge admission — pass-through: a partially interrupted run remains non-authoritative.

## 1. Over-block

A stale marker or dead PID could otherwise hold a legitimate planned restart. The guard requires a live PID and recent start time; the pre-spawn null-PID interval lasts 30 seconds. A recent request cannot hold beyond three hours from request or run start. Only a request with durable proof that it actually waited gets one further hour for delivery. A force request and the updater's four-hour limit bypass the guard. One bounded wait for active tests is an intended maintenance delay; other pending requests and unplanned crash recovery still proceed.

## 2. Under-block

A verifier could start between the consumer's last marker check and its restart action. The queue pause narrows that interval once the flag exists, but no cross-process transaction covers both steps. An invalid or missing marker fails open, so such a run can still be interrupted and retried. An old run intentionally loses the hold at the three-hour ceiling. These cases are observable as interrupted runs and never produce a green result from partial tests.

## 3. Level-of-abstraction fit

The shared guard reads two machine-local lifecycle records and writes one bounded proof sidecar when it actually defers a request; it does not invent another restart controller. The existing restart consumers remain the only actors that consume the flag. The verifier remains the only authority over its queue, and its existing interruption accounting handles a ceiling hit. This uses the current durable marker instead of adding a second ledger.

## 4. Signal vs authority compliance

This is a deterministic lifecycle invariant over enumerated state: a request explicitly marked planned, a recent in-flight marker, and a live child PID. It makes no judgment about message meaning or user intent. It is a bounded safety guard on a disruptive restart, operating inside the existing supervisor and foreground restart authorities. Uncertainty about marker validity fails open to the existing restart path; explicit force always wins. No brittle text classifier gains blocking authority.

## 4b. Judgment-point check

No new heuristic arbitrates competing human intents. `plannedRestart`, `bypassHolds`, PID liveness, and finite timestamps are typed or structural lifecycle facts. The 30-second pre-spawn and three-hour request/run limits are fixed safety bounds; they do not rank a requester's importance or change merge authority.

## 5. Interactions

- **Shadowing:** The guard runs before the supervisor's expiry and restart-count checks. Only a flag proved deferred while its original TTL was live survives for a bounded four-hour delivery window: three hours of possible hold plus one hour to consume it. An ordinary flag that never waited, or had expired before the first observed hold, still expires after one hour. The watcher already treats expiry as a restart request.
- **Double-fire:** Both consumers read the same flag and both apply the same hold. Once the child ends, the existing flag-consumption behavior chooses the winner; the other sees no flag on its next tick.
- **Races:** The verifier writes the marker before spawn and patches its PID. The null-PID allowance covers that bounded setup window; a dead or malformed marker is released. The queue pauses when a pending flag exists.
- **Feedback loops:** No new timer or recurring restart request is created. The existing ticks recheck the unchanged flag. A proven deferred request keeps new verifies paused until it is consumed or its four-hour delivery window closes; the hold on the current child ends at three hours.

## 6. External surfaces

The visible change is timing: planned maintenance can finish a running local PR check before restarting. The request file gains a backward-compatible `bypassHolds` boolean when written by the updater. A machine-local sidecar records a hash of the exact request when it actually waits; an unmatched or old sidecar has no effect. Local audit logs record a pause, and the consumers log one deferral per request. No external service, new user-facing action, schema migration, or direct GitHub write is involved.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** A local restart only threatens a test child on the same host. The marker, flag, pause, and guard therefore belong on that host; peer machines apply the same rule to their own children. This change emits no user-facing notice, stores one bounded sidecar with a request hash and timestamp plus an optional flag field, and generates no URL. Topic transfer does not strand a user action because the already-pending local flag is consumed by its own host.

## 8. Rollback cost

Revert this code and ship a patch. Old consumers ignore the optional `bypassHolds` field and the sidecar file. Existing flag and in-flight files retain their previous format; no migration or repair is required. A rollback would restore the observed risk of losing test minutes during planned restarts until the package reaches each host.

## Conclusion

The bounded guard addresses the two observed interruption paths without changing merge authority or crash recovery. The independent review caught an expiry/ceiling interaction that would have discarded maintenance at three hours, then two stale-request revival paths. Proof must be written for the exact request before its original expiry, and the delivery ceiling is four hours. The remaining race and ceiling behavior are explicit. The reviewer concurs with this revision; final ship judgment follows the remaining test gate.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent `/root/restart_second_pass`
**Independent read of the artifact: concur**

The reviewer independently traced both restart consumers, the proof writer, and the expiry check. They found the original ceiling loss and two over-broad stale-request paths; each was corrected and covered by a regression. On the final revision, the reviewer found no remaining blocking correctness concern. The foreground watcher's prior behavior of acting on expired flags remains explicit in the spec.

## Evidence pointers

- Two PR #2525 interruptions at 2026-11-01 04:48:26 and 04:57:57 UTC in `.instar/logs/local-verify.jsonl`, totaling 782,891 milliseconds of discarded active work.
- `.instar/logs/lifeline-launchd.log` names the planned restart writers at the matching times.
- Focused guard and service unit tests, TypeScript build, focused integration, update-apply E2E, and production-builder E2E passed. After three test expectation/ratchet failures were corrected and passed on targeted rerun, the final full suite was queued for the host test slot at 20:07 UTC.

## Class-Closure Declaration (display-only mirror)

The modified restart controller has a bounded recheck path rather than a new self-trigger loop. `defectClass: unbounded-self-action`; `closure: guard`; `guardEvidence: { enforcementType: ratchet, citation: tests/unit/planned-restart-verify-guard.test.ts, howCaught: one unchanged request may be rechecked on existing ticks, but the request/run age ceiling, dead-PID release, and no new restart production ensure this controller reaches a consumed or expired steady state; the cited tests assert that one deferred request is consumed once after the child ends and that a request beyond the delivery window is discarded }`.
