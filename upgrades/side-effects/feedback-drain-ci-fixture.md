# Side-Effects Review — feedback drain CI fixture

**Version / slug:** `feedback-drain-ci-fixture`
**Date:** 2026-10-30
**Author:** Echo
**Second-pass reviewer:** not required (Tier 1)

## Summary of the change

The integration fixture in `tests/integration/feedback-factory-process-job-body.test.ts` uses a random failure-file name for each invocation. This removes cross-case state when the operating system reuses an ephemeral port. The API reference also documents the Codex continuation endpoints after the first CI pass exposed a route-coverage shortfall. The ELI16 note and internal release fragment document both changes. No runtime code or installed file changes.

## Decision-point inventory

No production decision point changes. The test's success/failure assertion now reads the record belonging only to that invocation.

## 1. Over-block

No production block/allow surface. A successful script run still has to exit normally and leave no failure file at its unique path.

## 2. Under-block

The fixture still relies on the job script to write its own failure record. A script that silently misreports a failure could pass; existing failure cases exercise that contract.

## 3. Level-of-abstraction fit

The isolation belongs in the test fixture, where per-case temporary state is allocated. The production job script remains the authority for writing a failure record.

## 4. Signal vs authority compliance

No brittle signal gains blocking authority. The test checks an invocation-specific output artifact, following [signal versus authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check (Judgment Within Floors standard)

No LLM judgment point changes. The failure-file path is test plumbing.

## 5. Interactions

The test server may reuse a port, but that no longer reuses an artifact path. Other tests and the installed job are unchanged.

## 6. External surfaces

No API, network, user, or agent-installed behavior changes. The public API reference now describes existing continuation routes.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator-facing text changes. The internal release fragment says why a red CI result can disappear after this fix.

## 7. Multi-machine posture (Cross-Machine Coherence)

The test file is portable across operating systems. Random UUIDs avoid reliance on a particular machine's ephemeral-port allocation.

## 8. Rollback cost

A revert restores the old flaky fixture. No data migration or agent state repair is needed.

## Conclusion

Tier 1: a one-line test isolation fix plus a short API reference correction, with no production behavior change. One review round and two commit/gate attempts; the second was required by the first GitHub docs-coverage failure.

## Second-pass review (if required)

Not required for a Tier 1 test fixture change.

## Evidence pointers

- PR #2451 GitHub Integration Tests failure at `feedback-factory-process-job-body.test.ts:210`.
- Focused integration test and exact-commit verifier for this fix.
- `node scripts/docs-coverage.mjs --check` passes with route coverage at 55%.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
