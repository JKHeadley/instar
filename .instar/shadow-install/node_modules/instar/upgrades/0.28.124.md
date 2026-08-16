# Upgrade Guide — v1.0.12

<!-- bump: patch -->

## What Changed

Closes the Testing Integrity Tier-3 gap that PRs #252-#254 deferred. The Testing Integrity Standard (NON-NEGOTIABLE) requires three test tiers for every significant feature, and the Tier-3 lifecycle tests are the most important — they prove the feature is actually alive in the production-init path.

The recent primitive PRs shipped excellent Tier-1 unit tests but did not include Tier-3. This release ships one consolidated end-to-end suite at tests/e2e/parity-primitives-lifecycle.test.ts covering the parity registry boot, each rule's contract surface, end-to-end render cycles for skill and hook, memory verify behavior, the PostUpdateMigrator parity-renderings backfill, and the FrameworkParitySentinel boot lifecycle. Twelve tests, no mocks, real fixture project, real fs operations.

Plus a small migrator categorization tweak — the parity-renderings backfill now recognizes the memory rule's documented "refused to remediate" message as a skip alongside the skill rule's "user-edit-conflict". Both are documented Migration Parity §5 refuse patterns, both should be operator-action notes rather than errors.

## Evidence

The Tier-3 suite runs in roughly 360 milliseconds against a tmpdir-backed fixture project. The full chain — canonical source on disk, rule.listInstances scan, rule.verify, rule.remediate, framework-native rendering produced, read-back verification — is exercised for skill and hook. Memory verify is exercised against canonical AGENT, USER, and MEMORY markdown files. The migrator backfill is exercised end-to-end with marker dedupe verified. The sentinel boots, scans a populated fixture, and stops cleanly without errors.

Verification: 12 new tests pass; the existing 11 parity-renderings unit tests (from PR #262) continue to pass; the broader migrator categorization tweak preserves all previously-validated assertions in the parity-renderings test suite.

## What to Tell Your User

- "The Testing Integrity Standard required end-to-end lifecycle tests for every primitive, but the recent primitive PRs shipped without that coverage. This release closes that gap with one consolidated end-to-end suite covering the entire parity layer end-to-end. The suite runs against a real fixture project — no mocks — and verifies that registry, rules, sentinel, and the post-update backfill all come alive correctly in production initialization."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Tier-3 lifecycle coverage for parity primitives | Automatic. The new suite runs in CI alongside other E2E tests. |
| Registry-iteration test pattern | Future Agent and Tool parity rules are covered by the same suite via the for-loop over listParityRules. No per-primitive test additions needed. |
| Broader §5 refuse-pattern recognition | The migrator now treats both 'user-edit-conflict' and 'refused to remediate' as skips with operator-action notes. |

## Deferred (Tracked Follow-ups)

- Future parity rules introducing new refuse patterns should ideally throw a typed RefuseError instead of relying on string matching in the migrator. Not blocking for v1.0.
- Conversational-action v0.2 wiring through ContextHierarchy, SelfKnowledgeTree, and Playbook on-demand loaders is the final remaining v1.0 task in this autonomous session.
