# Side-Effects Review — Instar Documents (#3053): whole-PR coverage after the awareness-registry move (2026-11-15)

**Version / slug:** `instar-documents-whole-pr-1115`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `not required (coverage record; no behaviour change in this commit)`

## Summary of the change

This commit changes no code. It records one decision trace covering every file this PR changes against current main. Local Verify passed on head `88736f8024` (17:01Z, every lane at 0 failed), but the merger's decision audit refused the PR: `src/data/awareness/instar-documents.md` was uncovered. That entry file was added when the PR's CLAUDE.md text moved to the awareness entry registry (#3171), and no earlier trace listed it.

The PR's behaviour is reviewed in the earlier artifacts:
- `instar-documents-core.md`
- `instar-documents-page.md`
- `instar-documents-routes-sync.md`
- `instar-documents-browser-link.md`
- `instar-documents-old-link-guarantee.md`
- `instar-documents-proof-fixes.md`
- `instar-documents-main-merge-1111.md`
- `awareness-block-stays-last-1115.md`

The awareness entry carries the same wording as the old `DOCUMENTS_CLAUDEMD_SECTION`, now as one registry file. The registry rebuilds the feature-notes block on every update, so no migration step is needed. The registry spec is `docs/specs/awareness-entry-registry.md`.

## Decision-point inventory

None added by this commit.

## 1. Over-block

No issue identified.

## 2. Under-block

No issue identified.

## 3. Level-of-abstraction fit

The awareness text lives where the Agent Awareness Standard now says new text goes.

## 4. Signal vs authority compliance

Unchanged from the earlier artifacts.

## 5. Interactions

Covered in the earlier artifacts. Since main was merged at 88736f8024, the PR is mergeable with no conflicts.

## 6. External surfaces

Unchanged.

## 7. Rollback cost

Revert the PR's merge commit, which takes the feature (dark by default) out whole.

## Tests

Local Verify at 88736f8024: unit 67933 tests, integration 7313, e2e 4167, all with 0 failed.

## Follow-up (2026-11-15 18:40Z)

The awareness entry now says the document routes answer `503 documents-off` while the switch is off (matches `documentRoutes.ts`). This commit stages the entry file so its decision record covers it.
