---
title: Direct Local Verify tests in local push smoke
slug: direct-local-verify-smoke
status: approved
approved: true
approved-by: Chief of Staff, direct-test and wiring scope approval 2026-11-26
parent-principle: Testing Integrity
eli16-overview: docs/specs/direct-local-verify-smoke.eli16.md
review-convergence: "2026-11-26T20:28:08.402Z"
review-iterations: 2
review-completed-at: "2026-11-26T20:28:08.402Z"
review-report: "docs/specs/reports/direct-local-verify-smoke-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
---

# Direct Local Verify tests in local push smoke

The fast local push check currently expands a verifier change through the shared HTTP routes to more than a thousand tests. The normal breadth limit then leaves all testing to shared verification. Add a smaller local diagnostic for changes confined to Local Verify. Select tracked Vitest test files that directly import changed verifier source, changed tests in the same area, and the existing route and peer wiring tests. Include the ladder audit when its shared registry changes. The configured Vitest inventory continues to decide which files may run.

Keep the current transitive selector for changes outside the supported scope or when the direct sample cannot be supported. A recognised change must include code under `src/localVerify/`. The declared companion patterns are in `scripts/lib/pre-push-scope.mjs`. The mandatory tests are `tests/integration/local-verify-routes.test.ts` and `tests/integration/local-verify-peer-routes.test.ts`, plus scoped tests in the diff. A change to `src/data/feature-ladders.json` requires `tests/unit/feature-ladders-coverage.test.ts`. A diff containing `src/server/routes.ts` uses the existing transitive mode. Any nonignored working-copy change, a missing required test or an unreadable candidate discard the proposed sample. An incomplete report from Vitest inventory itself stops the local check as an indeterminate result. Pass all direct candidates to case collection. After inspecting the counts, pass only the bounded sample to execution. If collection reports a different inventory, stop the local check and retain that evidence. Existing file and case limits remain. If the direct candidates exceed the case budget, retain every changed and wiring test and the required ladder check. Add complete optional files, preferring unit tests with a stable path tie-breaker, up to the existing case cap. If required files cannot fit, use the existing path for an oversized local set. Both the first run and any focused retry must report the exact selected files and case counts before accepting a zero-exit result as a local success. Required and retried files must report at least one test outcome of passed or failed. The test reporter does not certify that the test body called an assertion. A wiring file with every assertion skipped cannot clear. Full shared verification remains required and executes the full lane inventory.

## Decision points touched

| Decision | Type | Basis | Evidence |
| --- | --- | --- | --- |
| Use the direct sample only on the declared source scope | invariant | basis: enumerable-domain | evidence: scope, fallback and wiring tests |
| The sample cannot confer a merge verdict | invariant | basis: enumerable-domain | evidence: the hook has no verdict writer and full shared checks are unchanged |
| Collection, first run, and retry each reconcile their own expected inventory | invariant | basis: enumerable-domain | evidence: all candidates at collection, the bounded sample on first run, and original counts for the focused retry |

## Open questions

*(none)*

## Evidence

On candidate 894feaab, the legacy selector reported 1,084 affected files for 21 changed files. The configured file inventory took 0.6 seconds and the direct dependency scan took 2.4 seconds. It selected 60 files. Exact collection found 1,402 cases across those 60 files in 35.5 seconds, with no missing or extra files. The existing local case cap is 1,000, so the direct route kept 1,000 cases across 38 complete files.

The full shared verifier uses the existing test lanes and does not read the local smoke decision. The diagnostic selector is bounded to Local Verify source in this first rollout.

## Maturation plan

- **ladder:** local-verify-direct-smoke
- **test-agent-live:** Replay the named-retry diff and test missing files, changed case counts and skipped wiring checks.
- **dev-agent-live:** Measure local discovery, collection, and execution on development pushes.
- **fleet:** Apply the diagnostic only to the declared Local Verify scope after the shared gate.
- **graduation criterion:** Publish the matched diff comparison and verify that local results cannot clear the full shared gate.
- **dark-window:** None. Use the scoped diagnostic when the repository update lands.
