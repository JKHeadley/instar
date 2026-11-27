# Side-Effects Review — Circuit-Breaker Fixture Isolation And Final Harness Review

**Date:** 2026-11-23
**Author:** Echo
**Second-pass reviewer:** /root/main_search_failure_review

## Summary of the change

This test-only successor isolates fake-CLI admission state in the circuit-breaker integration fixture. It uses the existing scoped home-directory spy and process-local singleton reset pattern. Both original factory/circuit assertions remain. A new regression saturates an unrelated PRIVATE ledger, then verifies one fake rate-limit spawn, circuit-open refusal of a second provider, zero owned holders afterward, and unchanged unrelated file bytes. A new production-server lifecycle test checks the limiter over HTTP with the real factory. No production source is modified.

This artifact also records a fresh review of the complete inherited test harness. The earlier trace's artifact digest became stale when the release-note correction edited its artifact. The documentation-only follow-up trace did not attest to the inherited harness. Those historical artifact and trace bytes are preserved. This new artifact is independently read in its final form, then a new trace binds the reviewed paths and current artifact digest in the successor commit. It does not retroactively manufacture concurrence for old traces.

## Decision-point inventory

No production judgment, authorization, dispatch, account or capacity policy changes. The fixture changes only the default admission STATE LOCATION for harmless stand-in subprocesses. The normal test-runner admission remains enforcing and uses normal HOME. The inherited real-model setup retains checksum identity, bounded preparation, existing lock implementation and local-only suite loading.

## 1. Over-block

No production block/allow surface. Test setup fails if its owned path is wrong; this prevents accidental live-ledger coupling from silently returning. The inherited model setup deliberately fails on missing or changed assets instead of skipping semantic assertions.

## 2. Under-block

No production block/allow surface. This does not alter live host capacity, historical holders or rate-limit policy. The controlled regression proves the fixture coupling mechanism, not the exact contents of the historical host ledger. Detailed original search errors remain unavailable; ACT-517 tracks raw-artifact retention separately. Other failures can still be found by complete verification.

## 3. Level-of-abstraction fit

The coupling belongs in test fixture initialization, not production admission or breaker logic. The real provider factory continues to nest spawn admission inside the circuit breaker. A scoped home lookup and singleton reset are already used by other fake-CLI tests in this repository.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. No production information-flow authority is added or removed. Test state ownership is a hard deterministic invariant. The real capacity and account-breaker authorities remain intact, including their error types and release behavior.

## 4b. Judgment-point check

No new static heuristic at a competing-signals production decision point. There is no cap override, fake admission success, new priority lane or safety bypass.

## 5. Interactions

The integration fixture resets the process-local semaphore before constructing providers and restores its home spy afterward. It resets the circuit breaker between cases. Only owned ambient IDs are acquired and released; the test never edits the operator's ledger. The actual provider wrapper releases its own slot on the fake rate-limit exception. The server lifecycle closes owned resources before restoring mocks and deleting its directory. Unchanged unit coverage protects the real wrapper's acquire/release and refusal behavior.

The inherited model harness was re-read as part of this final review: tests/setup/real-embedding-cache.mjs, tests/setup/real-embedding-model.globalSetup.ts, vitest.config.ts, vitest.integration.config.ts, vitest.e2e.config.ts, tests/helpers/realEmbeddingProvider.ts, tests/unit/real-embedding-test-cache.test.ts, tests/unit/vector-search.test.ts, tests/integration/hybrid-search.test.ts and tests/e2e/hybrid-search-lifecycle.test.ts. The real-model checksum cache, recoverable lock, bounded pre-worker acquisition and real local-only pipeline are unchanged. The inherited real subprocess callback waits in tests/unit/grok-build-adapter-policy.test.ts and pane readiness in tests/e2e/session-management-e2e.test.ts are unchanged. The corrected release fragment and its explicit required summary section were also re-read. All production sources and both combined parent repairs remain unchanged.

## 6. External surfaces

No product behavior, API response contract, live config or account state changes. The fake CLI writes one counter under its test directory. The inherited machine-local verified model cache is unchanged. The original verifier tree is untouched. No operator-facing action is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design. Each test worker owns temporary admission and fake subprocess state. It must not coordinate these fake calls with live machines. No transferable agent state, user notices or user URLs are introduced. Inherited real model assets remain independently provisioned per machine with identical checksums.

## 8. Rollback cost

Revert this test-only successor to restore the old fixture. No migration, live restart or production state repair is needed. Historical traces remain as historical evidence; the new trace may be superseded only by another genuine review of its final artifact.

## Second-pass review

**Reviewer:** /root/main_search_failure_review

The reviewer re-read the inherited harness and diagnosed the factory ordering independently, then explicitly concurred with the corrected integration fixture and new production-server lifecycle test. This final artifact is frozen before its separate final-artifact concurrence is requested. That actual verdict and the digest reviewed are preserved under .instar/state/build/review.json. The new trace is emitted only after that concurrence. No old artifact or trace is rewritten to simulate review.

## Conclusion

The controlled selected baseline reproduced the capacity-versus-rate-limit failure inside an owned temporary ledger. The corrected focused sequence passed six unit tests, three integration cases and one production-server lifecycle case, with zero skips, zero recorded unhandled errors and zero exits. Its raw output, JSON and error reports are preserved. Build and normal commit outcomes are recorded separately with the candidate. Publication belongs to the Chief of Staff and complete exact-head verification belongs to throughput. This artifact makes no complete-green or live-recovery claim.

## Class-Closure Declaration

unbounded-self-action: n/a. This is test fixture initialization, explicit test calls, teardown and a review artifact. It introduces no autonomous controller, retry spawn, restart loop or production judgment gate. No installed prompt, hook or skill is changed.
