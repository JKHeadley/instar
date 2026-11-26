---
title: Local Verify unit snapshot RPC recovery
slug: local-verify-vitest-snapshot-rpc
status: approved
parent-principle: Testing Integrity
approved: true
approved-by: Echo, after external findings were addressed and independent source review concurred
eli16-overview: local-verify-vitest-snapshot-rpc.eli16.md
review-convergence: "2026-11-26T17:03:20.596Z"
review-iterations: 3
review-completed-at: "2026-11-26T17:03:20.596Z"
review-report: "docs/specs/reports/local-verify-vitest-snapshot-rpc-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
---

# Local Verify unit snapshot RPC recovery

PR 3916 reached the unit report with no named assertion failure and one trusted-reporter error, `[vitest-worker]: Timeout calling "snapshotSaved"`. Vitest 2.1.9 awaits this worker-to-coordinator RPC after finishing snapshot processing. The bundled RPC library has its own 60-second clock. A unit test or teardown timeout setting does not adjust this clock. The retained run cannot identify the triggering file or prove what delayed the reply.

On the supervised Local Verify unit lane, permit one repeat using the same test selection, configuration, and execution options if it exited 1 without a signal or named failures and the trusted reporter recorded exactly that one error. Keep first and retry reports at distinct paths. Require the merge worktree to be clean immediately before the retry. This rejects changed tracked snapshots and newly generated untracked snapshots. The existing final dirty-worktree check still applies. Require a readable first report with test files and no recorded failures. Use the normal lane budget for the redo, bounded by the existing total gate deadline. If a first part uses the recovery, preserve the remaining ordinary unit time for its rest by deducting only ordinary execution from that allowance. One retry is allowed across all parts of the unit lane.

The retry must produce fresh normal passing evidence and a trusted reporter count of zero. Apply ordinary verdict checks to the resulting report. A missing retry report, repeat timeout, malformed reporter output or other unhandled error must not gain a pass. A retry assertion failure remains subject to the existing assertion and flaky-isolation rules. Log the retry with the unit part identifier and retain original diagnostics when the run fails. Other lanes and the test configuration are unaffected.

Evidence consists of the retained PR 3916 process failure record for attempt `22848a324815167a9bad9b77dfc1ec88`, the Vitest 2.1.9 worker implementation, and controlled replay through `tests/unit/localVerify/orchestrator.test.ts`. The replay gives the orchestrator the recorded exit and reporter message alongside a test report without failures. It tests clean recovery, repeated timeouts, a real failing assertion, missing retry evidence, unrelated or mixed errors and a changed snapshot baseline. Separate controlled-clock cases produce a first-part timeout followed by a second qualifying timeout and a retry that hits the total gate cap. They verify one retry per lane, preservation of the ordinary rest allowance, and no extension of the total gate deadline. The replay tests the retry decision and does not reproduce the original scheduling stall. Rollback is a code revert. There is no data migration or new authorization. A retry runs on the same machine under the existing suite reservation and configured total gate bound.

## Decision points touched

| Decision | Classification | Basis | Evidence |
| --- | --- | --- | --- |
| When a unit run may retry | invariant | basis: enumerable-domain | evidence: the pinned reporter supplies a version, count and bounded list, and the incident identifies one exact error. |
| What evidence can pass a retry | invariant | basis: external-constraint | evidence: Local Verify requires a complete lane inventory and a bounded attempt for every pass. |

## Open questions

None.

## Maturation plan

- **ladder:** none. This repairs the existing Local Verify lane without a configuration flag.
- **test-agent-live:** run the controlled orchestrator replay and the Local Verify lifecycle suite on the isolated candidate.
- **dev-agent-live:** verify the release on Echo’s test line and retain the first recovery event and its verdict.
- **fleet:** distribute through the existing Instar release process after ordinary verification.
- **graduation criterion:** require clean recovery in the replay and preserved failures for repeated or mixed errors, failed assertions, dirty snapshots, malformed evidence and the deadline.
- **dark-window:** none. The exact recovery condition applies when an updated verifier encounters the recorded worker error.
