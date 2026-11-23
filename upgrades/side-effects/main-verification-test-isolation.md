# Side-Effects Review — Real Search Test Preparation And Completion Waits

**Date:** 2026-11-23
**Author:** Echo
**Second-pass reviewer:** /root/main_search_failure_review

## Summary of the change

Test-only repair on exact combined candidate 406253d1. Search tests use the existing provider factory seam to load the real checksum-pinned model locally after a bounded pre-worker preparation. The unit, integration and lifecycle configurations wire that preparation. Existing semantic and real SQLite assertions remain. Failed acquisition now fails rather than skips the model-dependent tests. Provider and server resources are disposed. Grok policy tests observe the real child callback, and session readiness waits for the actual pane. Delayed fixtures demonstrated both old timing failures.

## Decision-point inventory

There are no production block/allow, account, lease, dispatch or lifecycle authority changes. Test selection decides whether model preparation is necessary. Checksums and cache completeness enforce test-asset identity. Test completion is asserted from actual callbacks and terminal output, not elapsed time.

## 1. Over-block

No production block/allow surface. A missing or changed model asset fails test preparation visibly. This intentionally prevents an unavailable model from silently suspending semantic coverage. The cache environment override must be an absolute machine-local path.

## 2. Under-block

No production block/allow surface. The saved raw historical errors were deleted, so this repair cannot establish every historical cause. Complete verification can still reveal other failures. Actual remote acquisition is bounded and checked, but focused checks seed from an existing complete installed cache; unit fixtures exercise acquisition failure and corrupt content separately.

## 3. Level-of-abstraction fit

Preparation belongs in test global setup, not a production provider or each suite's initialization hook. The suite uses the existing injection seam with the real Transformers pipeline and production dtype/thread options. The existing proper-lockfile dependency owns concurrent preparation and stale-lock recovery.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. No production information-flow judgment or blocking authority is added. Asset identity is a deterministic test invariant. Existing production authorities are unchanged.

## 4b. Judgment-point check

No new static heuristic at a competing-signals production decision point. Test selection is conservative for full, glob, related and changed invocations; explicit relative and absolute test paths are normalized and covered.

## 5. Interactions

The normal host test semaphore remains in force. Model preparation is wired after the existing dist setup and before workers. It has a 550-second shared acquisition budget, at most 240 seconds of lock retries and a 600-second parent kill bound. Per-file download timeouts use the remaining budget. Heartbeats and stale-lock recovery prevent a killed preparation from permanently blocking later attempts. Completed assets are checksum-verified before use. Grok probes still execute their real binaries with the unchanged production timeout and callback; the test observer does not manufacture output. Session fixtures retain unique owned tmux prefixes and normal cleanup. No normal admission override or duplicate invocation is introduced.

## 6. External surfaces

No product or API response changes and no new operator action. Tests may create roughly 91 MB of reusable machine-local cache under ~/.cache/instar/test-embeddings-v1 or the explicit INSTAR_TEST_EMBEDDING_CACHE override. Only the named model assets are copied from the dependency cache or fetched from HuggingFace. Their content must match the committed checksums. Live agent stores, original verifier trees and operator conversations are untouched.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: this cache is disposable test input held once per test machine, not agent memory or conversation state. Other machines provision their own verified copies using the same hashes. No user-facing notices, transferable durable agent state or generated user URLs are added.

## 8. Rollback cost

Revert this test-only commit to restore the earlier test setup. The verified cache can remain inert; there is no database migration, production state repair or restart. Existing combined repairs remain in the parent.

## Conclusion

The review corrected path selection and replaced a bespoke lock with the existing recoverable lock implementation. Actual baseline and focused results are preserved under .instar/state/build. The missing failure-artifact retention is separately tracked as ACT-517. Complete verification and publication remain external gates owned by throughput and the Chief of Staff.

## Second-pass review

Reviewer /root/main_search_failure_review independently read the implementation and concurred after selector, stale-lock and shared-deadline corrections. No tests or source edits were performed by the reviewer.

## Class-Closure Declaration

No agent-authored prompt, installed hook, skill or production controller defect is changed. This is test infrastructure and fixture code. The preparation is a bounded one-shot child explicitly invoked by a test command, with no self-triggered restart, retry-spawn or recovery controller. unbounded-self-action: n/a.
