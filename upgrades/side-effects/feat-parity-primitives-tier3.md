# Side-effects review — Parity primitives Tier-3 lifecycle tests

Per L6 (Side-effects review gate). Seven dimensions.

## 1. Over-block / under-block

**Before this change.** UNDER-blocked: the Testing Integrity Standard (NON-NEGOTIABLE) requires Tier-3 for every significant feature. PRs #252-#254 shipped Tier-1 unit tests but no Tier-3 E2E. The "feature is alive in production-init" assertion was missing.

**After this change.** No over-block risk. The new tests run against tmpdir-backed fixture projects; they don't touch any production agent state. The categorization tweak in PostUpdateMigrator is additive — it recognizes one additional refuse pattern (memory rule's documented refuse) as a skip instead of an error. Existing assertions (e.g., `result.errors` includes non-conflict errors) are preserved.

## 2. Level-of-abstraction fit

The Tier-3 tests live in `tests/e2e/` per Testing Integrity Standard — exactly where Tier-3 belongs. Each describe() block scopes to one concern (registry, skill rule, hook rule, memory rule, migrator backfill, sentinel boot) so failures localize.

The categorization tweak lives in `migrateParityRenderings` where the err.message classification already happens. Not over-engineered into a separate "refuse-pattern matcher" helper — three lines of code with a docstring is the right granularity.

## 3. Signal vs Authority compliance

The migrator categorization tweak strengthens signal-vs-authority alignment. Each rule emits its refuse pattern as a signal in the thrown error message. The migrator interprets those signals into result categories (skip vs error). Previously the migrator's interpretation was too narrow (only `user-edit-conflict`); now it covers both documented §5 refuse patterns. This is interpretation logic, not rule policy — each rule's authority on whether to refuse remains its own.

## 4. Interactions with adjacent systems

**PR #262 (parity-renderings backfill, this PR's base branch).** Tier-3 tests depend on `migrateAsync()` from #262. The PR is chained — once #262 merges, this PR's base auto-rebases to main.

**PR #261 (sentinel mirror-trust wiring).** Tests construct the sentinel without `adaptiveTrust` so the backward-compatible fall-through path is exercised. New tests don't override the sentinel's trust gate behavior.

**Existing parity rule tests.** All pass. The new E2E tests use the same fixtures pattern (tmpdir + real fs + real registry imports).

**Existing PostUpdateMigrator tests.** The 11 parity-renderings tests from #262 pass without modification. The categorization tweak only broadens the skip classifier; it doesn't change error vs skip allocation for existing test cases.

## 5. Rollback cost

Low. Two files: one new test file, one 3-line tweak in PostUpdateMigrator. Revert is `git revert`. The new tests don't introduce dependencies; they exercise the existing parity layer.

## 6. Backwards compatibility / drift surface

Backwards-compatible. The migrator change is additive — previously-error-categorized memory refuse messages now land in skips. No public API change.

**Drift surface.** If a future rule introduces a third refuse pattern, the categorization regex would need updating. Documented as a known follow-up: future rules should ideally throw a typed `RefuseError` instead of relying on string matching. Not blocking; the current pattern covers all v0.1 rules.

The Tier-3 test suite uses `expect.arrayContaining` for the registry assertion so adding rules (Agent, Tool) doesn't break the test. The for-loop over `listParityRules()` exercises any added rule's contract surface automatically.

## 7. Authorization / Trust posture

No new authority claims. Tests run in tmpdir fixtures; production agent state is untouched. The migrator categorization tweak doesn't affect remediation behavior — it changes how refuse messages are categorized in the result object, not whether remediation happens.

## Outcome

Ship.

Twelve new Tier-3 E2E tests close the Testing Integrity gap for the parity-primitive layer. One small migrator categorization tweak recognizes the memory rule's documented refuse pattern as a skip. Future Agent and Tool parity rules will be covered by the existing test structure via registry iteration.
