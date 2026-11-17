# Side-Effects Review — releases skip a version npm still holds as staged

**Version / slug:** `publish-staged-version-marker`
**Date:** `2026-11-17`
**Author:** `Echo`
**Second-pass reviewer:** `independent Claude subagent (general-purpose), required because .github/ is a protected path`

## Summary of the change

Tier 1, 5 files, ~130 lines, 0 spec rounds, first commit attempt. `scripts/resolve-publish-version.mjs` gains `highestConsumedVersion(tags)` and an optional third argument: the highest `vX.Y.Z` / `published/vX.Y.Z` tag is treated as already released when it is above the npm version. The CLI reads tags with `--tags-from-git`. `.github/workflows/publish.yml` fetches tags before resolving and pushes `published/vX.Y.Z` right after `npm publish` succeeds (before the smoke wait). `scripts/release-local.mjs` does the same. Cause: npm keeps a new version staged (invisible to `npm view`) for up to ~55 min; a run in that window re-resolved the same number and npm refused it (1.3.1868, 1.3.1873; fb-354bb7b5-b5d).

## Decision-point inventory

- Release version resolution — modify — the number chosen can now be higher than npm+1 when a tag says a version was already handed to npm.

---

## 1. Over-block

No block/allow surface. The resolver can only pick a HIGHER number than before. One residual: a stray high `v*` tag would raise every later version, and the tag ruleset blocks deleting `v*` tags; that risk already existed for `v*` before this change (the resolver now reads them). If a `published/` tag exists for a version whose publish actually failed after npm accepted the PUT, that number is skipped; a skipped patch number is harmless (npm versions are not required to be contiguous; 1.3.1868 already has no release tag).

## 2. Under-block

- If the marker push fails (network, permissions), the run warns and the old behaviour returns for that version. If `git ls-remote` fails at resolve time, the resolver warns and resolves from npm only (as before).
- A run already past its resolve step when an earlier run publishes is not affected; publish.yml runs are serialized (`concurrency: publish`), and release-local keeps its existing in-flight and hosted-run checks.
- Does not shorten npm's staging wait or the 45-min smoke timeout; a smoke timeout still fails that run (now without breaking the next one).

## 3. Level-of-abstraction fit

Right layer: the single resolver both publishers already share, fed by git tags, which both publishers already read and write. No new store.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 5. Interactions

- `vX.Y.Z` release tags: unchanged; still pushed with the release commit after the smoke test. Callers that match `v*` are unaffected (`release-skip-annotate.mjs` `--match v[0-9]*`, `release-local.mjs` `ls-remote refs/tags/v*`).
- Three callers run `git describe --tags --abbrev=0` without `--match` (`scripts/check-contract-evidence.js:47`, `scripts/analyze-release.js:75`, `scripts/classify-default-drift.mjs:156`). In the normal case the `vX.Y.Z` tag sits on the release commit, a child of the `published/` commit, so describe still returns `vX.Y.Z`. They can return `published/vX.Y.Z` only when a release left no `v` tag (smoke failed) or its `v` tag ended up off main. Then the `published/` tag is the exact source npm received, which is a more accurate boundary than the older `v` tag these callers would otherwise return; they use it only as a git ref. Accepted, not changed.
- Tags are read with `git ls-remote --tags` (no fetch): cheap, and the shallow CI checkout is unchanged.
- Hooks: the CI marker push sets `HUSKY: '0'` like the existing commit/tag step, so the pre-push hook does not run between publish and smoke. release-local creates the marker with `gh api repos/<slug>/git/refs` (HEAD is `<remote>/main`, checked in preflight), so no git hook runs there either.
- No workflow triggers on tag pushes (checked every workflow: none has `on: push: tags`).
- Operator-intended leaps (package.json > npm) still win unless a staged publish already used that exact number, in which case the next patch is used instead of a guaranteed E409.

## 6. External surfaces

Adds `published/vX.Y.Z` tags to JKHeadley/instar (one per release). No change visible to agents or users; release cadence improves when npm staging is slow.

## 7. Multi-machine posture

Machine-agnostic by design: the marker lives on the GitHub remote, so a release from any authorized machine (hosted runner or any Echo host running release:local) sees it after fetching tags.

## 8. Rollback cost

Revert the PR. Leftover `published/` tags are inert (the old resolver ignores tags) and can be deleted with `git push origin --delete`.

## Second-pass review

**Reviewer:** independent Claude subagent (general-purpose), 2026-11-17, read the diff and this artifact cold.

Round 1: **Concern raised.** (a) The CI marker step did not set `HUSKY: '0'`, so the tag push would run the full pre-push hook (smoke tests, e2e scope) in CI between publish and smoke, and a hook failure would silently drop the marker; release-local's tag push had the same issue. (b) Answer 5 was wrong about `git describe`: three callers without `--match` can return a `published/` tag. (c) The tag fetch pulled near-full history; `ls-remote` is cheaper. Confirmed sound: resolver never duplicates or lowers a version; operator bumps kept; top-level `await import` valid; release-local ordering (in-flight marker, publish, marker, smoke) correct; answers 1, 2, 4, 6, 7, 8 match the code.

Changes after round 1: `HUSKY: '0'` on the CI marker step; release-local marker via `gh api` (no hook); resolver reads `git ls-remote --tags <remote>` (best-effort, no fetch) with a parser test; answer 5 corrected above (describe effect accepted with reasoning).

Round 2: **Concur with the review.** Checked: CI marker step has `HUSKY: '0'`; no tag fetch, so `git tag` cannot collide locally and the resolver's read guarantees no remote collision; release-local `SLUG` is set in preflight, HEAD equals `<remote>/main` so the SHA exists on GitHub, gh login already required by `checkCiRuns`, every failure only warns; `tagNamesFromLsRemote` folds peeled lines and ignores heads; 60 s timeout with npm-only fallback; argument parsing exits 2 without a remote; resolver still max(npm, consumed tag); answer 5 accurate. One nit (print gh's stderr in the release-local warning), applied.
