# Side-Effects Review — #3194 merge of main: spec-approval rule renumbered B24 → B25 (2026-11-15)

**Version / slug:** `pr3194-merge-main-b25-1115`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `not required (identifier rename + conflict union)`

## Summary of the change

Merging main into #3194 conflicted in `src/core/MessagingToneGate.ts`. Main had meanwhile taken rule id B24 for `B24_OLD_VIEW_LINK` (the Instar Documents old-link nudge, #3053). This PR's rule `B24_SPEC_APPROVAL_UNCHECKED` therefore became `B25_SPEC_APPROVAL_UNCHECKED`, and every place this PR names it moved with it: the rule constant (`B25_SPEC_APPROVAL_RULE`), the prompt heading, comments, the spec, the awareness entry, the coverage registries and the tests. The conflict resolution keeps both rules in every list: the rule list, the signal-mode map and the advisory-or-blocking map. Main's B24 and its tests are unchanged. No logic changed. The only difference is the rule's id string.

## Decision-point inventory

None changed. Both rules keep their modes: B24_OLD_VIEW_LINK stays advisory/behavioral-judgment, and B25_SPEC_APPROVAL_UNCHECKED stays blocking/signal-driven.

## 1. Over-block

No issue identified.

## 2. Under-block

No issue identified. The rename is complete: no `B24_SPEC` string remains.

## 3. Level-of-abstraction fit

Unchanged.

## 4. Signal vs authority compliance

Unchanged.

## 5. Interactions

Records of a past hold that name the rule id are stored by this PR's feature only. It has not shipped, so there are no stored B24_SPEC rows to migrate.

## 6. External surfaces

The rule id appears in held-message notices to the agent. It now reads B25.

## 7. Rollback cost

Revert the merge commit.

## Tests

- tsc clean.
- spec-approval-constitution-check and tone-gate-advisory-migration: 53 of 53 pass.
- The tone-gate b21/b24/main unit files were run as well.
