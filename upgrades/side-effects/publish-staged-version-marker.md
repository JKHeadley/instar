# Side-Effects Review — releases skip a version npm still holds as staged

**Version / slug:** `publish-staged-version-marker`
**Date:** `2026-11-17`
**Author:** `Echo`
**Second-pass reviewer:** `not required (release workflow, no gate/sentinel/session surface)`

## Summary of the change

Tier 1, 5 files, ~130 lines, 0 spec rounds, first commit attempt. `scripts/resolve-publish-version.mjs` gains `highestConsumedVersion(tags)` and an optional third argument: the highest `vX.Y.Z` / `published/vX.Y.Z` tag is treated as already released when it is above the npm version. The CLI reads tags with `--tags-from-git`. `.github/workflows/publish.yml` fetches tags before resolving and pushes `published/vX.Y.Z` right after `npm publish` succeeds (before the smoke wait). `scripts/release-local.mjs` does the same. Cause: npm keeps a new version staged (invisible to `npm view`) for up to ~55 min; a run in that window re-resolved the same number and npm refused it (1.3.1868, 1.3.1873; fb-354bb7b5-b5d).

## Decision-point inventory

- Release version resolution — modify — the number chosen can now be higher than npm+1 when a tag says a version was already handed to npm.

---

## 1. Over-block

No block/allow surface. The resolver can only pick a HIGHER number than before. If a `published/` tag exists for a version whose publish actually failed after npm accepted the PUT, that number is skipped; a skipped patch number is harmless (npm versions are not required to be contiguous; 1.3.1868 already has no release tag).

## 2. Under-block

- If the marker push fails (network, permissions), the run warns and the old behaviour returns for that version.
- A run already past its resolve step when an earlier run publishes is not affected; publish.yml runs are serialized (`concurrency: publish`), and release-local keeps its existing in-flight and hosted-run checks.
- Does not shorten npm's staging wait or the 45-min smoke timeout; a smoke timeout still fails that run (now without breaking the next one).

## 3. Level-of-abstraction fit

Right layer: the single resolver both publishers already share, fed by git tags, which both publishers already read and write. No new store.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 5. Interactions

- `vX.Y.Z` release tags: unchanged; still pushed with the release commit after the smoke test. `published/` does not match `v*`, so `git describe`, the unreleased-window check (line ~139) and release-skip-annotate are unaffected. Tag fetch uses `--force` so a moved tag cannot fail the step.
- No workflow triggers on tag pushes (checked every workflow: none has `on: push: tags`).
- Operator-intended leaps (package.json > npm) still win unless a staged publish already used that exact number, in which case the next patch is used instead of a guaranteed E409.

## 6. External surfaces

Adds `published/vX.Y.Z` tags to JKHeadley/instar (one per release). No change visible to agents or users; release cadence improves when npm staging is slow.

## 7. Multi-machine posture

Machine-agnostic by design: the marker lives on the GitHub remote, so a release from any authorized machine (hosted runner or any Echo host running release:local) sees it after fetching tags.

## 8. Rollback cost

Revert the PR. Leftover `published/` tags are inert (the old resolver ignores tags) and can be deleted with `git push origin --delete`.
