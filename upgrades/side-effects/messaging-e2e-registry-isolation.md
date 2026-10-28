# Side-Effects Review — Messaging E2E registry isolation

**Version / slug:** `messaging-e2e-registry-isolation`
**Date:** 2026-10-27
**Author:** Echo
**Second-pass reviewer:** Independent Codex review agent (`/root/priority_review`)

## Summary of the change

Tier 1, four files, roughly 65 changed lines. The multi-agent messaging E2E fixture uses a temporary process-local registry, unique agent names, an isolation assertion, and more useful failure output. This is a test-only change. It adds no production decision point.

## Decision-point inventory

No production decision point is added or modified. The test's existing assertion that sends return 201 passes through unchanged.

## 1. Over-block

No block/allow surface — over-block not applicable. The new first assertion fails if the test accidentally discovers any live agent, which is intentional for this fixture.

## 2. Under-block

No block/allow surface — under-block not applicable. Other E2E files might still use a shared registry; this change addresses the multi-agent messaging file whose failures were observed.

## 3. Level-of-abstraction fit

The test fixture owns isolation. It uses the existing `INSTAR_TEST_REGISTRY_DIR` primitive shared by AgentRegistry and AgentTokenManager; production registry routing is unchanged.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). No blocking authority is added. The E2E assertion produces a test failure signal for CI and Local Verify to judge under their existing merge policy.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The assertion checks an exact test fixture invariant.

## 5. Interactions

The environment override is set before test servers and token creation and restored after both server teardown attempts. Registry paths resolve lazily. Unique names prevent collision with shared drop-message files. Separate Vitest workers have separate process environments; the temporary directory is unique per worker. The test does not alter verifier scheduling or slot admission.

## 6. External surfaces

No production external surface or operator action changes. CI failures in three send tests now include the HTTP response body. The fixture uses ephemeral local state only.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each test process creates its own temporary registry on its runner machine. There are no user-facing notices, durable state to transfer, or generated URLs.

## 8. Rollback cost

Revert the test and documentation commit. There is no production migration or agent state repair.

## Conclusion

The test can continue to exercise real messaging while avoiding contention with the machine-wide agent registry. Build passes; full E2E and Local Verify remain the merge gates.

## Second-pass review

**Reviewer:** Independent Codex review agent (`/root/priority_review`), 2026-10-27
**Independent read of the artifact:** concur. The registry and token paths honor the process-local override; teardown restores it, and the note accurately describes the test-only surface.

## Evidence pointers

Shared E2E file failed on unrelated PR #2381 and throughput PR #2400 with HTTP 400; `tests/unit/message-router.test.ts` also logged a shared registry lock failure. `npm run build` passes on this branch.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
