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
outstanding. This repair now precedes the local-refusal release because its
known canary defect blocks that candidate's full validation.

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


## Release dependency and shared fixture corrections

The separate local-refusal candidate's frozen full run ended normally with
51,936 passing tests and one failure: the real detector HTTP health fixture
observed ownedContracts.state=fail while config and noticePolicy were healthy.
All 14,014 input hashes were unchanged. This matches the independently measured
old canary cleanup failure class; that run did not expose per-attempt phase
timing, so it is not new proof of the exact timing of each failed attempt.

The canary commit was rebased unchanged onto v1.3.1239. An independent range-diff
review confirmed equivalence and no dependency on local-refusal accounting.
Fourteen files receive previously reviewed fixture corrections: awaited real
Boot cleanup has a 30-second budget with existing restorations in finally, and
the phone fixture explicitly asserts initial/post-save display convergence
within 20 seconds with safe health metadata on failure. Its body budget is
60 seconds. The two detector fixtures already had bounded cleanup; their
canary-specific 145-second observation is preserved. The HTTP body remains
180 seconds; the Boot body is 240 seconds to cover sequential recovery waits
and its explicit awaited in-body close.
Only the cleanup hunk is transferred to the late-capacity lifecycle fixture;
no local-refusal accounting test or runtime change is imported.

Reverse closure order, propagation of cleanup errors, delivery assertions,
operator scope checks, and production authorization/read deadlines remain
unchanged. Longer fixture waits still fail at their bounds. Independent reviewer
review_local_refusal concurred with the actual transfer and rebase. Build passes
on v1.3.1239. Initial combined focused validation passed all 55 tests in eight
files (normal exit 0, 2026-09-15T08:55:49Z).

A class-wide test audit found healthy-readiness waits shorter than two real
refresh opportunities: two completion-relative five-second intervals plus two
two-second reads can consume 14 seconds before scheduling margin. Seven files
now allow 20 seconds for healthy config/display/authorization/policy readiness.
The shared helper retains monotonic time and real timers for fake-interval lease
tests. Unavailable/revocation checks, delivery deadlines, and independent
enrollment-only probes are unchanged. The opt-out branch allows 20 seconds for
a new parsed snapshot while its unreadable branch keeps seven seconds. Only the
canary Boot body needs expansion: 145 + 20 + 8 + 20 seconds of sequential waits,
with allowance for setup and explicit in-body close, fits 240 seconds.

Independent reviewer review_local_refusal concurred with the actual seven-file
diff and owning-body budget audit. Final readiness-focused validation passed
all 36 tests in seven files (normal exit 0, 2026-09-15T09:06:33Z), including the
real canary lifecycle, policy, enrollment, dashboard rejection, production Boot,
and fake-interval lease consumer. Full lint passes. Full local suite and CI
remain required before merge; no deployment is claimed.

## Full-run watchdog fixture correction

Frozen candidate d10015e35060ff41ec56c2d24cad48e8a258fd85 completed the aggregate
suite normally on 2026-09-15T10:09:41Z: 51,969 tests passed and one failed.
All 14,018 tracked input hashes were unchanged. The canary production Boot
lifecycle and real HTTP detector health both passed (154.9 and 91.4 seconds).
Dedicated integration and E2E phases were not reached because the aggregate
failed. GitHub CI passed, including integration, build and 3,234 E2E tests;
build and E2E checkout logs verify merge f4f24dbd9721fe4d9487bc4693cdab7189e21d9a,
whose parents are current v1.3.1239 main and d10015e35. Those results do not
establish a passing full local run.

The single local failure was the watchdog real-esbuild fixture observing no
protected service after a fixed 100ms post-spawn sleep. This installation's
esbuild entrypoint is a Node shim that subsequently starts the native service;
its spawn event does not establish native-process readiness. Installed version
0.21.5 matches the fixture and discovery has no elapsed-time filter. This proves
the fixture lacks readiness synchronization, not the exact timing of its failed
attempt. The installer may instead replace the entrypoint with a native binary
on another platform. The audit found no other real esbuild spawn-plus-100ms
fixture in the test population.

The correction polls actual production process discovery for up to five seconds,
accepting only the spawned PID or its verified descendants. It detects early
exit, preserves the watchdog judge/signal assertions, and verifies both exit
and signal liveness. The test body allows 15 seconds for readiness plus a final
in-flight bounded process snapshot. Cleanup ends the owned stdin, awaits closure,
and uses strict process-table reads to verify captured owned resources are gone.
A bounded fallback rechecks each owned identity before stopping descendants
before their wrapper; uncertainty or incomplete cleanup fails the test. No
production watchdog, classifier, deadline, permission, or signaling policy is
changed. This also removes the former unawaited wrapper-only SIGKILL cleanup.

Reviewer review_local_refusal drafted the correction outside the frozen tree;
the primary independently reviewed ownership and cleanup, strengthened the root
liveness fence and final assertions, and the reviewer concurred with those
adjustments. After the frozen run ended and hashes were verified, focused
validation passed all 11 tests across the real-process integration fixture and
classification boundaries (normal exit 0, 2026-09-15T10:10:22Z). The corrected
candidate still requires full local validation and fresh CI before release.


## Remaining cleanup failure and bounded diagnostics

Frozen candidate 5d8a3bea87905b163a4348b64734bc56a37f4b63 completed the aggregate
with 51,970 passing tests, then dedicated integration with 4,207 passing tests
and one real detector HTTP failure (2026-09-15T11:27:28Z). All 14,018 tracked
input hashes were unchanged; dedicated E2E was not reached. CI passed against
the corresponding merge tree, which does not override the local failure. The
canary latched cleanup unavailable after one attempt while both actual authority
readers were healthy. The previous fixed `cleanup` label cannot identify the
first failing step. This remaining failure blocks release.

Three bounded direct probes and one actual production-Boot HTTP lifecycle passed
without reproducing it. Direct watcher closures took roughly 4.0, 12.5 and 6.6
seconds; the Boot probe took 1.49 seconds, with immediate parent termination and
9ms fixture removal. These observations locate latency in those successful
probes only; they do not prove the cause of the full-run failure.

The existing degradation reason now distinguishes fixed cleanup faults and stages:
acknowledgement, natural worker exit, parent termination and fixture removal. The
first fault is retained when later deadline or cleanup failures follow. No paths,
exception text, worker payloads, credentials or timestamps enter those labels.
Health schema/reasons, authority, protocol, resource ownership, retries, and
6s/30s deadlines remain unchanged. Thirty focused boundary tests pass, including
negative and late acknowledgements, abnormal exit versus error, failed termination,
late final cleanup, first-fault preservation, and reporter redaction. A completed
cycle report remains suppressed after close. Independent reviewer
review_local_refusal concurs with the runtime and test diff. The next dedicated
integration run is diagnostic; this addition does not claim to repair the still
unreproduced failure.


## Pool fixture listener ownership correction

The diagnostic candidate 0c327ce4f passed dedicated integration: 4,208 tests in
520 files, including real detector HTTP health (83.6 seconds). All 14,019 tracked
input hashes were unchanged. This did not reproduce the earlier cleanup fault.
The required full local run was then started on the same frozen candidate.

Fresh CI 34965209260 failed Node 22 shard 1 during pool-view-link-alive beforeAll:
the real holder AgentServer could not bind fixed port 47262 (EADDRINUSE). Its
9,450 tests passed, but one suite failed. Job 104367926455 checkout logs verify
merge 886d8ea6ec0be058a632f8da520771fdd6c49f6e, with parents main v1.3.1239 and
0c327ce4f. The source fixes holder/front ports at 47262/47261 without owning them
before listen. The competing process cannot be identified from that CI error.
The in-progress local full run was cancelled through its owned supervisor on
2026-09-15T12:06:12Z, after 499 seconds, because this known fixture correction
requires a new candidate. All 14,019 hashes were verified unchanged and its
owned process group had no remaining members. That cancelled run is not a pass.

The four related real-AgentServer pool fixtures (view link, reconciler, poll
cache, and placement transfer) now bind port zero. A shared test helper reads
the actual bound TCP listener after awaited start and rejects an absent or
non-TCP address. That listener remains reserved through the fixture lifetime;
there is no probe-and-release race, random port guess, or retry masking a bind
failure. The holder URL is established before signed mesh proxy wiring, and
all front/wired/dark URLs are established before their requests. SessionManagers
do not launch sessions in these fixtures. Existing authentication, signed proxy,
privacy/no-store, offline 503, ownership/transfer, and wired-versus-dark assertions
and awaited cleanup remain unchanged. No production server behavior changes.

This fixes the test resource-ownership layer and creates no diagnostic or
authorization signal. It neither over-blocks legitimate production work nor
weakens production checks. Rollback changes only test fixtures. The shared port
47261 also appeared in the reconciler fixture; the narrow pool fixture population
now contains no fixed 47xxx listener assignments. Existing pool streaming
fixtures already use OS-assigned listeners and remain unchanged.

Reviewer review_local_refusal prepared the five proposals outside the frozen
tree; the primary independently reviewed them, removed extra blank lines, then
applied them only after cancellation and input/ownership verification. Focused
dedicated E2E validation passed all 14 tests across the four actual server
fixtures (6.68 seconds, normal exit zero). Full local validation and fresh CI
on the corrected candidate remain required.
