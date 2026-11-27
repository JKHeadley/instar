# Side-Effects Review — constitution check asks review and fit in one call

**Version / slug:** `conformance-review-one-call`
**Date:** `2026-11-27`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

`POST /spec/conformance-check` and the CLI helper `runConformanceCheck` made two model calls whenever a spec names a parent principle: `StandardsConformanceReviewer.review()` (standards the spec may break) and then `judgeFit()` (does the spec indisputably fit its named principle). The second call re-sent the whole spec plus the provider's fixed preamble. Measured on the Studio usage ledger, pool scope, 7 days to 2026-11-27 14:01 UTC: 566 fit calls, 12.2M tokens (about 21,500 per call, about 35 dollars list-equivalent), on GPT-6.2 Astra through Codex.

New `reviewWithFit()` asks both questions in one call (`buildCombinedPrompt`, `parseCombinedResponse`) and the two callers use it when a parent is named. `buildCombinedPrompt` derives from the review prompt: the trusted standards block and every instruction stay identical, only the output contract changes, and the fit task is inserted before the untrusted spec block, which stays last. When the reply has no usable fit half (call failed, reply cut off or malformed), the fit question is asked again in its own `judgeFit()` call, so the fit verdict never fails open more often than before. `judgeFit()`, `buildFitPrompt()` and `review()` are unchanged.

## Decision-point inventory

- The fit verdict (`report.fit.verdict` fit|weak|none), read by spec approvals and the traceability gate: same values, same field, same fail-open rule. Only the number of calls that produce it changes.
- The findings list: same parser (`parseConformanceResponse`) on the `findings` array of the combined reply.

## 1. Over-block

None added. Every degrade path still fails open: findings degrade to an empty report; the fit half falls back to its own call and then to the old fail-open "fit".

## 2. Under-block

The risk is a weak/none fit lost because the combined reply did not parse (independent reviewer, finding 1). Closed: a missing fit half triggers the separate fit call, exactly the old behaviour. Tests: "a cut-off combined reply never loosens the fit" and "a failed combined call still gets the fit from its own call" (unit), "one call does not loosen the check" (integration, weak and none through the route).

## 3. Level-of-abstraction fit

The change sits in the reviewer, the one place both prompts are built and parsed. Routes only choose `reviewWithFit` when a parent is named.

## 4. Signal vs authority compliance

No authority changes. The review stays signal-only; the fit verdict keeps exactly the authority it had.

## 4b. Judgment-point check

The same two model judgments, made in one call. No new deterministic rule decides anything.

## 5. Interactions

- `specConstitutionCheckLedger` reads `degraded`, findings and `checkedAt`: unchanged shape. The report and the fit now share one `checkedAt`.
- The pre-commit gate and `src/commands/spec.ts` read the same report shape.
- Prompt injection: the spec stays inside its fence after every instruction. The prompt swaps search only after the trusted standards list ('first') or from the end ('last'), so neither a spec nor a rule that quotes a template line can move them (unit tests). A drifted review template falls back to the two calls with a logged error.
- `llmBenchCoverage`: `StandardsConformanceReviewer` now teaches the closed fit verdict, so its entry changes from a "no closed vocabulary" argument to its contract test.
- Metrics: the `StandardsConformanceReviewer/fit` attribution now appears only on fallback calls. Nothing registers or requires it (reviewer grep of src/data and tests).

## 6. External surfaces

No route, config or response-shape change. The check returns about 14 seconds sooner when a parent is named.

## 7. Multi-machine posture

Machine-local, as before: each server runs its own checks and keeps its own records.

## 8. Rollback cost

Revert the commit; no state or migration.

## Conclusion

Same results contract, one call instead of two. Ship once the Chief of Staff standing review concurs, since this feeds spec approvals.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent, 2026-11-27
**Verdict: APPROVE WITH NITS**, no blocking finding. It traced every branch (no provider, unresolved parent, throw, unparseable, normal) against the two-call path on main 2fb06861. Dispositions:
1. Should-fix, a cut-off reply could turn weak/none into a fail-open fit (standards-conformance.ts, combined parse). Fixed: separate fit call on a missing fit half, fit asked first in the reply, two tests.
2. Should-fix, `llmBenchCoverage.ts` called the component vocabulary-free. Fixed: contract test entry, and the name leaves the shrink-only argued-false baseline in `tests/unit/parser-contract-classification-ratchet.test.ts` (caught by the rule 7 whole-file run).
3. Nit, the drift throw became a quiet degrade. Fixed: prompt built before the call; drift logs and uses two calls.
4. Nit, 'first' swaps could match the trusted standards text. Fixed: search starts after the list; unit test with a quoting rule.
5. Nit, parent resolution duplicated. Fixed: shared `resolveParentArticle`.
6. Nit, fit failures less visible in per-feature metrics. Accepted: the per-report `fit.degraded` stays, and fallback calls keep the `/fit` attribution.
7. Nit, test gaps. Added the cut-off reply and unresolvable-parent route tests; the fence-escape gap predates this change and is shared with both old prompts.

## Evidence pointers

- `tests/unit/standards-conformance-gate.test.ts`, describe "reviewWithFit".
- `tests/integration/standards-conformance-gate.test.ts`, "one call does not loosen the check" and "an unresolvable parent makes one plain review call".
- `tests/e2e/standards-conformance-gate-lifecycle.test.ts`, fit verdict alive through the real route.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a token-cost change; the new tests are the regression guard).
