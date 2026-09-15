# Owned Telegram canary cleanup phases — side-effects review

Governing approved/converged spec: docs/specs/telegram-message-origin.md. Fresh
helper-created worktree fix/telegram-canary-cleanup-phase from canonical
https://github.com/JKHeadley/instar.git at 15cd5876d6d285a39fc105aeb57e5fde705ad540,
v1.3.1238. Existing approved private overview is linked in that spec.

## Evidence and intended outcome

Independent tracing found all six checks completed in about 318 ms, followed by
synchronous native watcher shutdown. One success spent 1298 ms closing observer
watchers and 3150 ms closing reader watchers; a failed cycle stalled at observer
close until both six-second attempts timed out. A separate production Boot trace
measured 5763 ms and 1470 ms in those closes, then 3 ms in runtime close. Logs:
/tmp/echo-review-canary-direct.log and /tmp/echo-review-network-lifecycle-close.log.

The current six-second timer includes cleanup and is not a hard total duration
bound because actual termination remains awaited after timeout. The approved
spec does not prescribe six seconds. The existing controller declaration requires
sequential bounded attempts, verified cleanup ownership, a cleanup-failure latch,
and startup/recurrence floors. Preserve six seconds for contract checks and use
a separate explicitly chosen 30-second cleanup deadline justified by these timings.

## Principle check and side effects

This changes diagnostic health, not credentials, delivery permission, retry custody,
or source authority. Health stays non-passing until all cleanup is verified.
Over-block: malformed protocol rejects the attempt and permits at most one retry.
Failed or unverified cleanup latches unavailable health even if checks succeeded;
actual source readers retain their own authority. Under-block: early success messages, duplicates, late results and missing
cleanup must never establish passing health. Ownership remains held while cleanup
is unresolved. At most two workers run sequentially and recurrence remains
completion-relative; restart waits 60 seconds.

The additional cleanup time can delay diagnostic completion and close(), but never
permits overlapping workers or healthy status before teardown. Deadlines are
bounded observations, not promises that an unabortable OS close returns by then.
Signals expose only fixed phases/reasons, never fixture content or paths.

Machine-local by design: each canary owns a private fixture and process resources;
no network transport or remote authority is created. Rollback restores the older
probe accounting and needs no stored-data migration. Existing-install awareness
will receive a guarded update alongside generated instructions.

Class unbounded-self-action: preserve existing registered owned-canary controller,
single-flight ownership, cleanup-failure latch, two-attempt limit, and schedule floors.
Update its declaration to state the separate contract and cleanup bounds.

## Validation

The protocol-compatibility regression failed against the previous parent using
the new checks-first fixture: that parent could accept the new early check result
without understanding its separate cleanup message. The old production worker
reported after its own finally block; its actual defect was classifying timely
checks as failed while native watcher teardown consumed the shared deadline.
The corrected protocol passes 25 boundary cases, including delayed timer callbacks,
late termination and removal, duplicate messages, cancellation after a real worker
starts, and no automatic scheduling after a cleanup failure. Twelve existing real
worker/native-lane cases, six scheduling cases, and six installed-migration cases
also pass (49 focused cases). Build and lint pass. An initial test-source quote
error was corrected before the real-worker suite ran successfully. The actual
operator HTTP health test passes (69.7 seconds), including startup wait, fresh
owned proof, authority-reader invalidation and no origin-row side effects.
All three production Boot cases pass (133.5 seconds): default native resolver
wiring, real owned checks with source failure/restoration, and resource shutdown
after failed profile enrollment. Full-suite and CI release validation remain
outstanding, separately after the first-priority local-refusal release.

Independent reviewer review_local_refusal: concur with the runtime protocol and
23 initial cases. Separate monotonic deadlines, normal exit before proof, joined
termination/removal, single-flight ownership and cleanup-failure latch hold. The
two recommended additional boundary cases are now included and pass. Final
review also concurs with the guarded awareness migration, controller declaration,
and 145-second successful-path wait (60 + 2 * (6 + 30) = 132 seconds plus margin).
The reviewer requested the protocol/latch wording corrections now applied above.

Tracked adjacent watchdog false interrupt: topic-69507. The conversation watchdog
sent SIGINT to a legitimate long-running Vitest process in the separate primary
release validation. This canary repair does not alter that watchdog; the current
release validation uses a bounded supervised test job with durable logs and exits.
