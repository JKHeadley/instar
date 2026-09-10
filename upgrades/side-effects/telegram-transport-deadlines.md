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
`guardEvidence`: ratchet, tests/unit/self-action-convergence.test.ts plus
real-worker transport-deadlines.test.ts and recovery-review-budget.test.ts.
Recovery still reserves 15 minutes before review, preserves the original maximum
six-hour deadline and existing child-attempt ceiling. Pre-network cancellation
charges the original attempt and cannot reset identity, deadline or pacing. The
control edge is original queued operation -> due recovery -> reviewed send;
the durable interval settles repeated failure and the deadline/attempt limit
terminates it. Unknown outcomes remain excluded from recovery.
