# Side-effects review: Telegram transport deadlines

**Author:** Echo
**Second-pass reviewer:** Hooke

## Summary of the change

Fresh Instar worktree fix/telegram-transport-deadlines at origin/main4180b00b2,
version1.3.1232, remoteJKHeadley/instar. Justin authorized remaining delivery
repairs in topic69507. The existing approved/converged Telegram message-origin
contract governs this fix. telegramFetch accepts a validated networkTimeoutMs
and creates the signal at its single native fetch boundary. Internal senders
pass durations instead of arming clocks before review. A dedicated local error
identifies cancellation checked synchronously before native invocation; the
service records known-failed using existing budgets. The callback strips that
proof from any rejection raised after invocation, including reused abort reasons.

## Decision-point inventory

- Network deadline start: modified transport lifecycle invariant.
- Known-unsent versus ambiguous outcome: exact invocation evidence, modified.
- Outbound review, content dedup, origin, ownership and capacity: passed through.
- Recovery pacing, original deadlines and attempt counts: passed through.
- Awareness installation: additive, idempotent existing-agent migration.

## 1. Over-block

An explicit caller cancellation prevents that attempt even when its original
queued intent is still valid. This preserves cancellation and leaves bounded
recovery to the existing outbox. Post-invocation failures deliberately remain
uncertain even if the network might not have transmitted bytes: the local process
cannot prove that. No new content judgment or ownership refusal is added.

## 2. Under-block

The duration covers network invocation through body consumption, not total review
latency or an entire multipart logical operation. Review and recording retain
existing stage limits. Each child receives its own budget. This does not repair
standby relay selection, startup readiness, dead-pane supervisor detection or
installed model retirement; those remain authorized work in topic69507, with the
model/PromptGate source work owned by the coordinated session in topic74958.
<!-- tracked: topic-69507 -->

## 3. Level-of-abstraction fit

The shared egress boundary owns the clock because only it knows when fetch starts.
The durable service owns outcome classification and retry state. Callers supply a
duration, not a pre-expiring signal. Independent caller signals and HTTP/mesh RPC
budgets remain independent. Attachment integrity is checked before the boundary.

## 4. Signal vs authority compliance

Reference: [signal vs authority](../../docs/signal-vs-authority.md).
No message-meaning classifier is added. Invocation, caller-signal state and exact
error provenance are transport invariants. Existing policy retains sole content
judgment. Cancellation is not a new operation-cancellation permission.

## 4b. Judgment-point check

No new heuristic at a competing-signals decision point. The synchronous
pre-invocation boundary provides exact local evidence; every later ambiguous
exception preserves the conservative fence.

## 5. Interactions

No approval caching or duplicate recovery controller. The original operation and
child identity, payload, deadlines and attempt counters remain unchanged. Known
pre-network cancellation after durable dispatch intent retains its charged
attempt, like invalidated credential capacity. A crash before outcome persistence
still recovers as uncertain. Each child combines its new network deadline with
the unchanged caller signal. The deadline remains attached through receipt reading;
clearing a timer at headers would create another unbounded wait. Non-managed
requests without a duration preserve their original signal. Invalid durations are
refused before any origin mutation. The local proof error is wrapped if fetch
itself rejects with either that cancellation error or OriginCapacityUnavailable,
preventing recycled abort(reason) from granting a resend. Actual capacity refusals
before invocation remain outside this catch and retain known-unsent accounting.

## 6. External surfaces

Users can receive replies whose reviews exceeded the old network duration.
No new API endpoint, credential exposure or operator action. Internal TypeScript
callers may pass networkTimeoutMs; it never enters the sealed payload or native
RequestInit. Shared scaffold awareness and PostUpdateMigrator update existing
CLAUDE/AGENTS/GEMINI content once. No config default or durable schema migration.

## 6b. Operator-surface quality

No operator form, dashboard renderer or grant/revoke surface is changed.

## 7. Multi-machine posture

Machine-local by design: the actual sending machine owns each network deadline.
Signed mesh submissions retain source origin and execution-owner authority;
receiver-side preparation completes before the receiver's network clock starts.
No new notices, URLs or replicated state. Existing operation routing and audit
remain authoritative. A token-bearing standby's selection defect is separate.

## 8. Rollback cost

Revert these source changes and publish a new patch; no data cleanup. Rollback
restores premature-expiry behavior, so a correction forward is preferable. Never
clear queued messages or uncertain outcomes as part of rollback.

## Conclusion

The fix belongs at the shared transport boundary and preserves custody and
uncertainty protections. Independent implementation review found no blocker.
At this review checkpoint, full-suite validation remains required before release;
the PR validation record will carry its final outcome.

## Second-pass review

Hooke reviewed the design independently, requiring a fresh clock per child,
response-body coverage, explicit caller cancellation, and demotion of recycled
proof errors after invocation. Implementation review concurs: deadline placement, body coverage, preserved caller
signal, recycled-error demotion and durable outcome accounting match the design.
Hooke independently reviewed the Lifeline case after its 16-case suite passed.
A subsequent provenance audit found the sibling capacity-proof error could also
be recycled as a post-invocation abort reason. The first aggregate run was stopped
deliberately to correct it. A parameterized regression reproduced that defect;
the boundary now demotes both proof types after native invocation. Hooke reviewed
the correction and renewed code concurrence. The corrected transport suite passed
17 cases. A subsequent aggregate found four existing notice-fixture startup races;
it was stopped before editing. Those fixtures now await real display/policy and
reserved-notice readiness before fault injection, including the initial boot in
the recovery-budget test. Hooke verified that every existing fault assertion and
cancellation case remains intact and renewed concurrence. Further full-run results and corrections are recorded below.

## Evidence pointers

- Initial regression run: 8 failures, 3 passes against unchanged source.
- Corrected real-session fixture: 13 focused tests passed; expanded 16-case
  transport suite subsequently passed, including multipart, network timeout, and the actual Lifeline sender.
- HTTP adapter, signed mesh, migration and awareness tests passed (200 cases
  across pipeline run excluding the new production recovery case).
- Production restart recovery passed after waiting for the real configuration
  observer to become ready (a later revision can invalidate the boot snapshot).
  The test does not replace configuration/ownership authority or force a retry.
- The new capacity-abort regression failed with held instead of outcome-unknown
  before correction (one failure, one pass, fifteen cases skipped).
- Corrected build and lint passed. Five-file transport/service/HTTP/mesh/boot
  checks passed 94 cases. Final boot/notice readiness checks passed 19 cases,
  including all 16 notice-policy cases. Counts overlap on the three boot cases.
- The second aggregate reported four failures caused by fixture readiness
  assumptions and was deliberately interrupted. The intermediate readiness run
  exposed the same assumption in the existing recovery-budget boot case; that
  precondition was corrected too. Both interrupted aggregates remain incomplete;
  the fresh final full run is pending, not reported as a pass.
- The third run passed 1,323 files, including all 19 boot/notice cases, before
  Tinypool exited because its process.js disappeared from the shared agent-home
  node_modules tree. That dependency tree changed during the run and the file
  subsequently reappeared. Exit 1 is an incomplete run, not a test-suite pass.
  The worktree now has private dependencies installed from its unchanged lockfile;
  both other delivery worktrees have independent copies from the identical lockfile.
  The private-dependency build and native SQLite smoke passed. All 5,369 frozen
  source/test hashes remained unchanged. A fourth full run started with the private
  dependency tree (echo-transport-deadlines-test-all-isolated.log).
- That fourth run completed its aggregate with exactly two failures, 3,343 files
  and 51,804 tests passed. Triage-author and scheduler-custody fixtures sent before
  display authority was ready. Dedicated integration/E2E stages did not start.
  The correction adds an opt-in real-display readiness helper to the remaining
  positive boot fixtures; it retries only the exact unavailable-authority error
  for at most 12.5 seconds and asserts required wiring/projection. Real timer
  waits do not advance the lease tests' fake interval clock. Integration notice
  setup also verifies the actual opt-out value and reservation before storage
  destruction. Startup-unavailability, tokenless enrollment, failed authority,
  lease loss and uncertain-delivery assertions remain intact.
- These waits isolate the behavior those tests exercise. They do not fix the
  production gap where a snapshot can be invalidated before boot returns and
  display failure can precede durable admission. The precise watcher/source
  event causing these two failures remains unproven; the initial resolved digest
  assignment itself does not increment the revision. Production readiness and
  retention are tracked separately in the authorized topic-69507 delivery work.
  <!-- tracked: topic-69507 -->
- Corrected ten-file readiness/negative-boundary validation passed all 35 cases
  (echo-origin-readiness-class-targeted.log), including both failed fixtures,
  real lease-loss boundaries, opted-out notices, tokenless enrollment and canary
  startup failures. Hooke independently inspected the helper and every call site,
  and concurred that required DI, exact-error retry, monotonic bounded waiting,
  fake-clock isolation and intentional fault assertions are preserved. Source
  build/lint passed before this test-only correction; normal commit lint runs
  again. The next complete full run is required; no full-suite pass is claimed.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`.
`guardEvidence`: ratchet, tests/unit/telegram-origin/recovery-review-budget.test.ts,
supplemented by real-worker transport-deadlines.test.ts and production-boot tests.
The generic self-action registry does not register ordinary recoverHeld; its test
is not the evidence for this claim. Independent audit corrected that citation.
Recovery still reserves 15 minutes before review, preserves the original maximum
six-hour deadline and existing child-attempt ceiling. Pre-network cancellation
charges the original attempt and cannot reset identity, deadline or pacing. The
control edge is original queued operation -> due recovery -> reviewed send;
the durable interval settles repeated failure and the deadline/attempt limit
terminates it. Unknown outcomes remain excluded from recovery.

The actual recovery-budget test proves at most24 automatic recovery starts per
original admitted operation over its default six-hour lifetime, exact due and
expiry boundaries, competing owners, restart/re-admission persistence and unknown
suppression. The production restart test connects that reservation to paid review;
transport cases retain charged cancellation attempts and uncertainty fences.
This is not a fleet-wide spending cap or a bound on newly created operations.
Hooke independently re-read these concrete tests and concurred with the correction.


## Post-boot outage-fixture verification

The fifth complete aggregate run finished with 3344 passed files and one failed
file: 51805 passed tests and one failed test. The capacity-drain outage case
became suppressed rather than accepted after its initial readiness check. The
original assertion did not include the suppression reason, so its precise cause
is unproven. The dedicated integration/E2E commands did not start after that
aggregate failure. This is not a full-suite pass.

A real compiled bootstrap probe, an instrumented execution of the existing test
file, a predetermined four-run diagnostic batch, and one filename-instrumented
execution all passed. These diagnostics do not replace release validation. The
third fixed diagnostic run captured actual FSWatcher invalidation during an
unchanged positive bot-only fixture before its observer recovered; no exact
filename was captured for that event. The later filename diagnostic did not
reproduce it. This establishes a reachable startup invalidation, not proof of the
original failed capacity case's trigger.

The E2E and HTTP outage fixtures now require one successful, idle, healthy config
observation after Boot returned, within their existing bounded setup wait, before
failing the recording workers once. Real display, policy, notice reservation and
explicit opt-out checks remain. The external fixture policy retains its original
observation/expiry; it is not renewed to pass the test. This establishes an
operating observer, not a guarantee that all future filesystem events have drained.
Startup-negative tests and runtime N6 terminal suppression remain unchanged.
A bounded sixteen-state history plus current source health/policy appears in the
capacity-drain assertion failure so another suppression provides its actual reason.
No production runtime source changed in this correction. Both actual E2E/HTTP
files passed all18 cases (echo-origin-notice-post-boot-targeted.log), including
capacity drain, grant expiry before/after dispatch intent, failed recording workers,
credential rotation, policy revocation and explicit opt-out. Hooke independently
reviewed the actual two-file diff and concurred with the bounded observer
precondition and preserved terminal semantics. A fresh full run is required.
This test-only amendment creates no production autonomous action; the overall
transport repair retains the recovery guard evidence declared above.

## Enrollment startup observation

The sixth aggregate ended with SIGTERM/exit143 before a summary; its initiator is
unproven. It had 3089 passing-file lines and one reported enrollment failure.
A separate exact reproduction failed with only notice-policy/unknown for
operator-alert-destinations: notice-destination-or-policy-unavailable at the
first Boot status. The completion-attainable test now polls real status for at
most12.5 seconds, only for that exact startup observation. Any different or
additional missing obligation fails immediately. No policy is renewed, no
production permission is changed, and missing release evidence still fails
certification. Enrollment plus HTTP/E2E notice tests passed21 cases. Hooke
reviewed the actual amendment and concurred; its suggested state/subject pins
were added. This test-only amendment adds no autonomous production action.
Full combined release validation remains required; no incomplete run is green.

## Seventh aggregate and separate updater fixture correction

The seventh aggregate, at candidate ebfba9244 on released v1.3.1233, completed
with exit1: 3344 passed files, one failed file, four skipped files; 51821 passed
tests, one failed test, 29 skipped tests and three todo. Duration was3191.33s.
All5375 frozen source/test files were unchanged. The dedicated integration/E2E
commands did not start because the aggregate failed. The initial progress counter
included individual passing tests; only these final summary counts are authoritative.

The only failure was `update-checker-apply.test.ts`'s persistence assertion. It
called real `npm view instar version`, then assumed a non-null saved result.
Production correctly returns an unsaved current-version fallback on registry
failure when there is no cache. The precise registry error was swallowed by that
existing fallback; the15006ms duration alone does not establish its cause.
The same file also launched a real rollback install and asserted only result shape.

The original build exhausted its three fix cycles and was terminally escalated
through the normal CLI. Its state, plan and audit were preserved in a read-only
snapshot; counters were not reset and it was not marked complete. Hooke reviewed
the escalation disposition: the independently diagnosed single-file updater
fixture repair is a separate bounded task under existing authorization, not a new
transport fix budget. The build skill excludes single-file edits and does not
explicitly require operator permission for this correction. Further unexplained
or production failures require new reassessment.

Only the updater unit fixture changes: fixed installed/registry versions and
mocked instance exec calls retain real check, persistence and rollback handling.
Assertions now require actual update/changelog persistence, same-version behavior,
offline fallback without invented state, unchanged offline cache, exact failed
rollback invocation and retained metadata, plus no install on refusal paths.
No production updater behavior, timeout or delivery implementation changed.
The first focused run had43 passes and two failures because the new combined
call-count/argument matcher is unavailable in the repository's Vitest version.
Three matcher calls were replaced with equivalent separate count and argument
assertions. The same three updater files then passed all45 tests. Hooke reviewed
the actual correction and the compatibility amendment and concurred. A new full
candidate run remains required. Later green validation will be recorded separately
and cannot retroactively pass an earlier failed run.

Audit erratum: the earlier enrollment-test trace mistakenly cited the nonexistent
`docs/specs/TELEGRAM-MESSAGE-ORIGIN-SPEC.md`. The actual approved/converged transport
spec read and used is `docs/specs/telegram-message-origin.md`. A fresh trace records
the correct path; the original audit record is retained rather than rewritten.
This corrects the citation, not the approved production contract or test behavior.

### Complete local validation and CI portability correction

Candidate7e2eb5900 completed the full local test:all with exit0: aggregate3345
passing files/51825 passing tests (4files/29tests skipped,3todo); dedicated
integration518files/4184tests (2files/12tests skipped); dedicated E2E368files/3232tests
(1file/7tests skipped,3todo). All5375 frozen source/test hashes remained unchanged.
This is separate candidate evidence; the original exhausted build stays escalated.

PR2018 CI run34479109543 then failed three unit shards. Both Node20 and22 exposed
a dependency in the new Lifeline constructor fixture: omitted framework settings
made real loadConfig require an installed Claude CLI. A bounded test-only correction
supplies explicit codex-cli configuration and private fail-on-use provider/tmux
executables, asserts the resolved fixture paths, and proves neither is launched.
Actual configuration loading, Lifeline construction, policy timing and15s/60s
network assertions remain intact. No production prerequisite or live config changes.

Another shard reported pre-network capacity holds in the triage-author and
attachment/companion lifecycle cases, plus source-lock contention and cleanup
ENOTEMPTY in the feedback150k performance case. The annotations establish those
outcomes, not their incidence or one shared cause. Those three files remain
unchanged. All45 cases across them and the corrected deadline unit file passed
locally. That does not count as a clean CI run or a correction of the independent
contention mechanisms; the next candidate still requires clean full validation
and CI. No attempt-limit, capacity TTL, lock bound or failed assertion was relaxed.


### CI hold diagnostics after complete candidate validation

Candidate704b3e65b passed complete local test:all with the same aggregate, integration and E2E counts above; all5375 fingerprints matched. CI34489858714 passed all eight unit shards and Build, then failed one integration and one E2E case. The deterministic-notice HTTP case returned409; the ambiguous batcher-send lifecycle observed zero native calls. Neither assertion retained the underlying reason. The exact HTTP case and all26 HTTP cases passed unchanged locally. This is nonreproduction, not proof of grant expiry or a repaired flake.

The bounded diagnostic change adds the HTTP response body to its existing200 assertion and captures/rethrows the same fixture send error for the existing exactlyone native-call assertion. No timing, grant, recovery bound, send authority or production code changes. Per docs/signal-vs-authority.md, this only surfaces test evidence and has no blocking authority. No over-block, under-block, or new decision interaction is introduced; the existing assertions stay strict. It is test-local on each machine, with no external or migration surface. Rollback removes diagnostic messages. Full candidate validation and clean CI remain required. The original exhausted build ledger remains escalated and unchanged.

Both diagnostic files passed all52 tests in77.19s (`echo-deadline-ci-hold-diagnostics-targeted.log`). This targeted pass does not replace new full or CI validation.
