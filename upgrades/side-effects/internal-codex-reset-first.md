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
