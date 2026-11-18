# Feedback fixes are written to the rules they are reviewed against

<!-- bump: patch -->

## What Changed

The feedback executor's automated fix sessions were being refused by the independent safety review for rules they were never shown: a test fixture with token-looking values and a replaced home directory (PR 3261), a catch widened beyond the brief with no test (PR 3252), and existing tests weakened by added delays (PR 3292). The fix session's prompt only said it had no network and no credentials.

The six review rules (Scope, Tooling, Secrets and reach, Tests, Injection, Breakage) now live in one module, `src/feedback-factory/execute/reviewRules.ts`. The reviewer reads its rules from there, word for word as before (its prompt is byte-identical, pinned by a hash test). The fix session's prompt now carries the same rules under "Your change will be refused by an independent reviewer if any of these hold:", followed by short practical guidance: change only what the brief needs, tests use temporary directories only and never HOME or real paths, no credential-looking literals in tests, never weaken, delay or delete existing assertions, and every behaviour change needs a test that fails without it. A spec-drafting session gets the spec variant of the rules.

## What to Tell Your User

- **Automatic bug fixes**: "The sessions that write automatic bug fixes are now told the same safety rules their reviewer checks, so fewer of those fixes should be turned away for avoidable reasons. Nothing changes in what gets accepted."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Fix sessions see the independent review's rules | Automatic |

## Evidence

Refusals this targets: PR 3261 (fixture credential literals + HOME replacement), PR 3252 (catch widened beyond brief, no test), PR 3292 (weakened tests). Tests: `tests/unit/feedback-factory/execute-review-rules-shared.test.ts` (worker prompt contains every rule line for both kinds; reviewer prompt sha256 pinned to its pre-change bytes, and the pin was checked against the upstream `independentReview.ts`), plus the existing `execute-independent-review.test.ts` and `execute-units.test.ts`.
