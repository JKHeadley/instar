# Full-suite Failure Follow-up — Exact Session Delivery

Complete overview: https://echo-studio.dawn-tunnel.dev/docs/721c80e1-7375-4e61-b6ec-ba9728ce5698. This is diagnosis of the fixed318922be1 candidate, not a release claim.

## Phase 1 — Identification

The exact candidate's full test:all stopped in unit testing:3 failed,73679 passed,24 skipped. Integration and E2E did not run. Original /tmp/n73-test-all.log remains unchanged (SHA256 e3b68c559df7a00ca056194baced6cf2a4bf55ff97994e6a56b610288bb78aa3). Reproducing just the three failed files gives3 failed/40 passed in1.70 seconds; full reproduction output is .instar/n73-verification/failure-reproduction.log.

Expected boundaries: a read-only pre-injection error can be retried without typing; a physical or unclassified delivery error cannot establish that nothing happened. Observable audit-loss warnings do not require raising the silent-fallback baseline. A remediation test for stuck queues must return the actual typed retryable delivery contract.

## Phase 2 — Isolation

1. message-router.test.ts calls actual MessageDelivery with getForegroundProcess throwing. That read occurs in checkInjectionSafety before sendKeys. The caller's generic catch now correctly treats an unclassified delivery exception as unknown; the module can safely convert this known read-only preflight failure into an explicit queued result. Generic promise failures and physical write failures must remain terminal unknown.
2. The exact20-line fallback scanner reports494 at upstream0e1ba833c and495 at318922be1. The only added hit is MessageRouter.auditRefusal's outer catch: it resets refusalAuditReady and emits a warning once until recovery. The warning is already observable and the delivery outcome remains on the message. A source-local exemption will explain that behavior; baseline494 stays unchanged. A real filesystem-error regression will verify warning coalescing, recovery reset and durable message status.
3. runbooks/messaging-delivery-failed.test.ts stubs {success:false,reason,action:'queued'} via an unsafe cast. DeliveryResult actually requires phase, failureReason and shouldRetry. Missing shouldRetry reaches the newly explicit terminal branch and removes both messages from the stuck queue, so durable verification correctly reports healthy. The fixture must model a genuine pre-injection retryable refusal, preserving its verify-failed assertion.

## Phase 3 — Fix

Implemented only the identified boundaries: MessageDelivery catches its known read-only preflight errors and returns a typed retryable refusal before sendKeys; the caller retains terminal unknown handling for unclassified exceptions. Added a side-effect-then-throw regression proving that distinction. Audit catch has a source-local exemption explaining its existing coalesced warning, with a real filesystem-error test proving warning/recovery behavior and durable outcomes. The runbook mock now satisfies DeliveryResult, explicitly sets shouldRetry:true, and independently checks both messages remain queued. Baseline stays494. Root concurrence is required before normal commit; full suite, push and restart remain unauthorized.

## Phase 4 — Verification

All three failed files passed together with two focused delivery suites:5 files,99 passing tests. The three original files account for44 passing tests. Actual authenticated HTTP integration:15 passing. AgentServer lifecycle and wiring:7 passing. Normal Node24 build passed. Relevant edge cases prove a read-only preflight error types nothing, an unclassified error after a write remains terminal unknown without retyping, a transient audit loss warns once until successful recovery and warns again on recurrence, and a genuine retryable runbook failure retains two queued messages.

Evidence paths under .instar/n73-verification: failure-fixes-unit.log, failure-fixes-integration.log, failure-fixes-e2e.log, failure-fixes-build.log. Original full-suite log hash remains unchanged. Full test:all has not been rerun; its original failed result is preserved. The next complete-suite candidate still requires root's separate reserved slot. Physical live rollout remains untested.

## Corrective Review

The existing independent source/artifact reviewer concurred after reading this narrow corrective delta: the catch is limited to read-only preflight; physical/unclassified failures remain terminal unknown; tests strengthen no-typing/durable queues. The reviewer did not run tests. Root subsequently reviewed the actual path/full delta and validation, concurred, and authorized normal trace/commit. No new reviewer agent was created.

Root focused review independently confirms the source catches only liveness/foreground/human-input/line-count reads before formatting/injection; physical/generic errors stay terminal unknown. It accepted the unchanged baseline with tested observable warning and the typed queue fixture. Authorization is normal commit only; complete-suite rerun/push/restart remain outside this step.
