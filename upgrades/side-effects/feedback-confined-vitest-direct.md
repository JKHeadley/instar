# Side-Effects Review — direct confined Vitest launch

**Version / slug:** `feedback-confined-vitest-direct`  
**Date:** 2026-11-03 PST  
**Author:** Echo  
**Second-pass reviewer:** `feedback_direct_vitest_review` (independent subagent)

## Summary of the change

Tier 2 repair under the approved feedback triage and execution spec. Three trusted executor command sites change from `npx vitest` to the installed `./node_modules/.bin/vitest`: the full confinement canary, the base/head named regression checks, and the related-test gate. Existing unit harness expectations change with them. No sandbox allowance, timeout, pass criterion, approval, or merge rule changes. The affected production worker spent 20 minutes inside `npm exec` without a Vitest child; a direct launch reached the expected old-code failure in 10.3 seconds under the same sandbox policy. The governing executor spec was already converged and approved; this repair adds no spec review round. Commit/gate attempts: 0 at drafting.

## Decision-point inventory

- Confinement canary `base-unit-smoke` — modified command invocation, same must-succeed authority.
- `verifyFix()` base/head and related checks — modified invocation, same fail-closed verification authority and 20/45-minute limits.
- Independent reviewer, exact-head verification, and merge gates — passed through unchanged.

## 1. Over-block

If the trusted dependency cache lacks `node_modules/.bin/vitest`, the command now exits as a failed check instead of asking `npx` to find or fetch another copy. That is the desired fail-closed result: the executor must test against its pinned local dependencies. A legitimate fix cannot pass with a missing tool; dependency preparation must repair the cache first.

## 2. Under-block

Vitest itself can still hang or a test can loop. The existing wall-clock and output caps still stop those runs. This change does not repair test files that write to denied paths; the separate test-cache repair in PR #2683 addresses the reproduced paths. It also does not assert that `npx` was the only cause of the observed stall; the evidence shows a direct launch works under the same confinement while the prior launcher did not.

## 3. Level-of-abstraction fit

The trusted executor constructs these commands and links a trusted dependency cache into each fresh clone. Choosing its already installed test executable belongs at that layer. No worker-controlled command or sandbox policy changes.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`, this adds no detector or authority. The existing canary and `verifyFix()` remain the sole authorities for their checks. An exit code, timeout, or output cap still produces the same failure path; no brittle heuristic gains blocking power.

## 4b. Judgment-point check

The command path is a deterministic tooling choice. It does not replace the model's triage judgment, the independent code review, or the operator's exact-head approval.

## 5. Interactions

The canary and both verification phases use the same local executable. `CANARY_VERSION` rises from v3 to v4 so existing installations invalidate their full-gate stamp and rehearse the new launch path. Each fresh base/head/gate clone receives a trusted `node_modules` symlink before the validated change set is copied; the change-set walk skips root `node_modules` and tooling-path changes are held, so worker changes cannot replace the binary in these clones. Existing cache redirects and filesystem denials remain. PR #2683 changes where test helpers and Vitest write disposable output, not which binary is executed.

## 6. External surfaces

The feedback executor may now advance worker fixes that were previously timed out before tests started. This can create more review PRs, subject to all existing safety gates. No API shape, user-facing message, GitHub permission, or outbound network access changes. The installed executable is from the pinned dependency cache and can run without an npm registry lookup.

## 6b. Operator-surface quality

The release note explains the practical impact in plain language. A failed direct launch still reports a bounded check failure; there is no new operator control or status label.

## 7. Multi-machine posture

Machine-local execution by design: each lease holder prepares its own dependency cache and confines its own tests. A released package carries the same command on every machine. This change emits no notice, holds no new durable state, and generates no URL. Existing owner epochs and merge records continue to coordinate attempts across machines.

## 8. Rollback cost

Revert the three command sites and unit expectations in a patch release. No migration or persistent-state repair is needed. An in-flight attempt may still fail on its own recorded limit; later attempts use the reverted command after update.

## Conclusion

The direct launch removes an avoidable package-manager step from a trusted, bounded check without weakening any safety gate. The real sandbox replay reached the old-code assertion in 10.3 seconds. Build, lint, the two focused executor unit files (155 tests), and the full unit suite (56,601 passed, zero failed) passed. The independent reviewer found that the first draft left the canary stamp at v3, which would have skipped the new smoke on existing installations. Bumping it to v4 and adding an old-stamp regression closed that issue. Integration, E2E, exact-head local verification, and CI are required before merge.

## Second-pass review

**Reviewer:** `feedback_direct_vitest_review`  
**Independent read of the artifact:** concur after one correction.

The reviewer confirmed the v4 stamp forces the full smoke, the trusted dependency link cannot be replaced by a worker change set, the sandbox and time/output limits stay intact, and the existing independent review and exact-head merge gates remain. The reviewer did not rerun tests; test receipts are assessed separately.
