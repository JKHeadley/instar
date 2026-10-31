# Side-Effects Review — Feedback reviewer model routing

**Version / slug:** `feedback-reviewer-model-routing`
**Date:** 2026-10-30
**Author:** Echo
**Second-pass reviewer:** GPT-6 Astra (independent pass; revised diff concurred)

## Summary of the change

Tier 2; six production files (104 added, 33 removed lines), nine test and fixture files (195 added, 9 removed lines), plus governing spec, release and review records. The approved parent spec needed no new convergence round; independent source review ran twice, with one correction round for model fallback and legacy pass reuse. The commit gate passed on the initial branch and again after the corrected fixtures and release fragment. This branch changes the feedback executor's safety-review model choice under Justin's topic 18330 instruction. Triage severity, effort, design need and changed paths select Astra as lead for critical or complex work; Opus 5.5 leads ordinary work, with Sol as its separate Codex safety read. The Claude clean-door accepts an explicit Opus pin, while the feedback executor refuses to call the Claude family without that exact pin. The existing two-family verdict and exact-head merge path stay in force. Source, tests, governing specs, upgrade notes and existing-agent guidance are touched. The branch is not deployed; Echo's current config still disables Claude review.

## Decision-point inventory

- `feedbackReviewLead` — added — classifies the lead model from persisted triage facts and actual changed paths; it never admits a merge.
- `resolveClaudeReviewerModel` — modified — permits one explicit operator-selected Opus pin and still refuses other unapproved overrides.
- Codex reviewer invocation — modified — accepts a restricted Astra/Sol choice and verifies the resolved concrete model before calling the provider.
- `buildFeedbackExecutor.review.run` — modified — orders families by lead and refuses an absent Opus pin, leaving the existing two-family admission authority intact.
- `PostUpdateMigrator.migrateClaudeMd` — modified — adds the new awareness section once to existing agents.

## 1. Over-block

An ordinary issue with missing severity or effort is conservatively sent to Astra and consumes scarcer capacity. A valid Opus review is refused if the agent config has not yet been updated with the exact `claude-opus-5-5` pin. Both are explicit safe-side states. A typo in the pin cannot quietly reopen Fable.

## 2. Under-block

A security-sensitive issue whose triage is wrongly medium/small and whose changed path lacks a security or key segment can receive Opus rather than Astra. The existing two-family review still decides merge safety. The classifier should be assessed on live review records; a serious verdict or unexpected model requires a new head or owner decision, not a silent pass.

## 3. Level-of-abstraction fit

The classifier belongs beside the feedback executor's independent review because it has triage facts and the current GitHub file list. The core model resolver remains the provider-level concrete pin guard. The executor's existing verdict function remains the only automatic merge-review authority; no parallel merger is introduced.

## 4. Signal vs authority compliance

**Required reference:** [signal-vs-authority](../../docs/signal-vs-authority.md)

- [x] No — the heuristic chooses a review signal consumed by the existing merge gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] Yes, with brittle logic.

The Opus-pin check is a hard invariant before an irreversible merge: an unapproved model must never stand in for the named reviewer. A missing pin leaves the PR open. The risk classifier itself never approves or merges a PR.

## 4b. Judgment-point check

The critical/complex split is a conservative model-capacity floor, not the final judgment on whether a fix is safe. The LLM reviewers receive the full bounded brief and diff, and the existing verdict authority requires both family passes. Missing triage fields choose Astra rather than guessing that an issue is simple.

## 5. Interactions

- **Shadowing:** the feedback-specific Opus pin check runs before the generic Claude reviewer and prevents its Fable default from being used in this lane. The existing enabled flag can still make Claude unavailable.
- **Double-fire:** the two reviewer families are intentionally separate; Gemini remains an optional additional cross-family read under the current loop.
- **Races:** reviews are tied to a PR head; a changed head is reviewed again. Existing failed-head memoization means the new policy does not automatically rerun old serious refusals. A new head or separately audited re-review is needed.
- **Capacity:** the current clean-door factory call has no `subscriptionPath`, so the Opus call uses the default Claude CLI account. The 13-account pool does not guarantee its availability. A degraded call leaves the PR open.

## 6. External surfaces

PR review comments and audit records will name the actual selected models. Existing-agent CLAUDE.md gains the routing description. There is no new approval action or mobile form. The source change alone does not enable Echo's disabled Claude reviewer; runtime config must be updated after verified release.

## 6b. Operator-surface quality

No dashboard or operator form is changed — not applicable.

## 7. Multi-machine posture

**Machine-local by design.** Model binaries, CLI logins and the selected subscription account are local to each machine. The source policy ships to every machine through the package update, and the agent config determines whether the Opus reviewer is enabled there. Review audit and exact-head GitHub PR state remain the durable cross-machine decision record. A machine without Opus access leaves the PR open instead of claiming a pool-wide pass.

## 8. Rollback cost

Revert the source commit in a patch release and set Echo's Claude reviewer `enabled:false` again. No schema migration or data deletion is needed. Exact-head review records remain historical evidence; do not rewrite them. During rollback, pending PRs continue to wait for independent review or exact-head owner approval.

## Conclusion

The independent Astra reviewer caught a real bypass in the first draft: Gemini+Opus could pass when the selected Astra/Sol call failed. The revision requires the exact selected Codex model and Opus model to pass; Gemini retains its serious-issue veto but cannot substitute for either. The production review port now has a direct test seam with coverage for both leads, missing/Fable pin and explicitly disabled Claude. Focused revision tests passed 110/110 and the revised build passed. The main residual is live Opus capacity: this clean-door path has not yet been shown to use the multi-account pool. Integration, E2E, full-suite and live call evidence remain required before runtime enablement or a throughput claim.

## Second-pass review

**Reviewer:** GPT-6 Astra
**Independent read of the artifact:** concur with the revised working-tree implementation. The exact Astra/Sol and Opus checks close the Gemini substitution bypass, preserve serious-verdict vetoes, and keep Fable excluded. Production-port tests cover both leads and missing, Fable and disabled Claude. Integration, E2E, full-suite and live-call evidence remain outstanding before deployment.

## Rebase check — 2026-11-02

Rebased onto Instar 1.3.1607. The service import and test harness conflicts were resolved by retaining the newer review-close behavior and adding the model-route fields. A policy read found that the original path check missed class names such as `SecretStore.ts` and `DashboardPinManager.ts`; the classifier now treats those security-sensitive names as complex, with regression cases. The rebased build passes. Exact-head tests and live reviewer proof remain open.

The fresh independent read found two additional admission risks. First, Codex's provider can retry an unsupported selected model on an older model unless the call carries `strictModelPin`; the reviewer would have recorded the selected model and could have admitted the wrong one. The routed Codex review now requires a strict pin, with a test of the option; the provider's existing unsupported-model test covers the refusal path. Second, a stored pass at the same PR head from before this model policy could be reused. Successful reviews now record `feedback-routing-v1` and the selected model pair in the reason, and only that version may be reused. A legacy same-head pass is re-reviewed; a regression covers that transition.

**Independent recheck:** Concur with the corrected review at source level. The strict Codex pin and legacy same-head re-review address both findings; the security path cases are covered. The reviewer could not run tests in its isolated environment; local exact-head tests remain the separate verification gate.

The first legacy-pass regression failed because the old same-head refusal branch still returned before calling a reviewer. I separated a stale pass from an unparseable/failed verdict in that branch; the full 92-test service file now passes, including the legacy-pass case. The independent reviewer concurred that a legacy pass reaches fresh review while serious and other failed-head memoization remains intact.

A benign one-shot probe through the built clean-door reviewer returned `status:ok`, model `claude-opus-5-5`, verdict `CLEAN` on Echo's default Claude account. This proves that account and the hardened invocation can reach Opus now; it does not prove availability of the other pool accounts or full production PR review. The release fragment states that the runtime reviewer remains disabled until the explicit Opus pin is set, so installation alone is not announced as active review throughput.

One more legacy transition required a guard: a pre-policy pass could already have armed GitHub auto-merge before the new policy reached the next tick. The merge-armed branch now disarms that PR and returns it to `pr-open` before any merge deadline logic. The next tick gets a fresh exact-model review or an explicit owner approval. The focused executor service suite passes 93/93, including the armed legacy-pass regression. Full exact-head verification remains open.

**Independent recheck:** Concur. A failed disarm stays armed with `disarmFailed` for retry. This guard cannot undo a GitHub merge that happens before the first post-update executor tick. Before enabling the new policy, inspect any already armed legacy PRs and disarm them while the executor remains stopped; record their exact heads and states.

The first full unit run on `f0d492a3d` finished with 55,581 passes and four failures in three files. One recovery fixture still simulated passing `gpt-5.5`/Fable reviewers, which the new gate correctly refuses. The other failures came from placing the release fragment at `upgrades/<slug>.md`, where versioned-guide validation expects a semver filename and a summary section. The fixture now simulates Sol/Opus, and the fragment moved to `upgrades/next/<slug>.md` with the summary. Focused rerun and a fresh exact-head full suite are required; the failed run is not a pass.

## Evidence pointers

- Focused unit: `/tmp/feedback-reviewer-routing-focused2.log` (77/77 passed).
- Executor service unit: `/tmp/feedback-reviewer-routing-service2.log` (90/90 passed).
- Build: `/tmp/feedback-reviewer-routing-build5.log` (exit 0).
- Revised build: `/tmp/feedback-reviewer-routing-build6.log` (exit 0).
- Revised focused unit: `/tmp/feedback-reviewer-routing-secondpass-focused.log` (110/110 passed).
- Repository invariant check: passed on the branch before commit.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. This is a new operator routing policy, not a repair of a broken prompt or self-triggered controller.
