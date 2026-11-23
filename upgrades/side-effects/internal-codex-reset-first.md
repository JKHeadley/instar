# Side-Effects Review — Internal Codex Reset-First Selection

## Summary
A Tier 1 reversible repair of the existing internal account picker. The shared comparator comes from prerequisite PR 3664. Existing account eligibility, provider choice, ambient fallback and sibling retry order are unchanged.

## 1. Over-block
No new eligibility condition or refusal is added. Unknown or stale weekly deadlines lose ordering priority but remain eligible under the existing headroom rules.

## 2. Under-block
This does not promise complete quota exhaustion, enforce a token budget, or prove every running session uses a named account. Full accounts remain excluded. No credentials or identities are synthesized.

## 3. Level of abstraction
The picker reuses compareCodexWeeklyReset rather than copying date or freshness logic. Stable sorting retains existing room order for equal deadlines. Its dependency imports SubscriptionPool types only, so it does not introduce a runtime import cycle.

## 4. Signal versus authority
The operator-authorized ordering preference feeds an existing account-selection authority. It grants no new launch, restart, credential, or shutdown authority. See ../../docs/signal-vs-authority.md.

## 5. Interactions
Only internal Codex initial selection changes. Non-Codex ordering, sibling rescue selection, explicit provider overrides and the default-off account-selection configuration remain as before. The follow-through job stays disabled.

## 6. Rollback
Revert this picker repair and its tests/docs; the account store schema and credentials are untouched. Parent PR 3664 remains an independently reviewed dependency.

## 7. Evidence and review
The new unit regression failed before the source fix (reserve selected instead of sooner-reset account). After the fix: 26 unit, 4 real-provider integration and 1 durable-pool restart lifecycle test passed. Native CLI behavior and live installation are not claimed; tests use a local stand-in executable and make no model calls. Independent reviewer reset_spec_safety concurred with the production change and identified a lifecycle coverage gap. The test was corrected to persist distinct reset deadlines before reopening the pool. Normal complete verification remains required.


## Prerequisite alignment for the critical rollout (2026-11-23)

This candidate merges corrected prerequisite 3664 at 1e13322bdbf10c3c3576adde59e07cb1313d003e, including current main 6b331e26e. The merge completed automatically with no conflict. The prerequisite correction preserves the already-merged ledger evidence artifact; it changes no routing or test assertions manually. This dependent alignment preserves the internal picker repair and introduces no new authority, credentials or schema. The prior 3664 merge-preparation error ran zero tests and is not replaced by the focused evidence. A new complete gate is still required for the corrected dependent head after its actual prerequisite merge.

Independent reviewer reset_spec_integration concurred: the alignment leaves internal picker source and all three related test files unchanged, with no manual assertions or lock changes. Fresh focused checks passed 26 unit, 4 real-child integration and 1 restart lifecycle test.


## Missing audit coverage correction (2026-11-23)

The corrected candidate aa8957992 failed decision-audit CI: src/core/SubscriptionPool.ts lacked generated decision scope. The original new picker change was combined with a prerequisite merge commit; the substantive local gate intentionally exempts MERGE_HEAD integrations, which is not evidence for newly authored code in that merge. A normal non-merge commit now clarifies the existing eligibility-before-ordering contract and runs the actual substantive pre-commit gate on SubscriptionPool.ts. No audit JSON is hand-authored, no check is weakened, and no runtime logic or assertion changes. The prior CI failure is retained separately. Existing independent review and 26 unit, 4 integration and 1 lifecycle passes still cover the unchanged picker; the newly pushed head requires normal CI and complete verification after its prerequisite merges.

Independent reviewer reset_spec_integration confirmed this correction is comment-only and an honest coverage remedy if the real substantive gate generates the record; inspect the generated scope and new CI result before claiming closure. It does not retroactively make the original merge pass that gate.
