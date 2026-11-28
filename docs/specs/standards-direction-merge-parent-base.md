---
title: Direction guard — the protected base is the main commit the run tests
slug: standards-direction-merge-parent-base
author: echo (Pipeline Strategy)
status: design note (Tier 1 by the Chief of Staff's ruling, 2026-11-27 19:26; no spec-converge)
eli16-overview: docs/specs/standards-direction-merge-parent-base.eli16.md
---

# Design note: the direction guard's protected base

## The rule

The direction guard (`scripts/standards-coverage.mjs --check`) requires the operator's approval for any change to `docs/STANDARDS-REGISTRY.md` relative to a **protected base**: a commit on main that the pull request did not author. CI chooses that base in the "Resolve protected-base area ledger" step of `.github/workflows/ci.yml`. It then writes the base's registry, approver key and area-audit ledger to temp files, and passes the base revision to the check.

**From 2026-11-27, the base is the main commit the run actually tests.** In order:

1. Start from the event base: `github.event.pull_request.base.sha || github.event.before || <sha>^`.
2. For a `pull_request` or `pull_request_review` run whose checkout is a merge commit (it has a `HEAD^2`), let `PARENT = HEAD^1`. That is the base-branch tip GitHub built the merge ref on.
3. Use `PARENT` instead of the event base only if both hold:
   - the event base is an ancestor of `PARENT`, so the base only moves forward; and
   - `PARENT` is an ancestor of `origin/main`, so the base is a commit on main.
4. Otherwise the event base stands. That covers pushes, non-merge checkouts, a missing `origin/main`, and a parent off main.

## Why

The event base is the base-branch tip when the PR was last pushed. The merge ref is built against the tip at run time. When main gains a registry change in between, the old base made the inherited standards look like the PR's own additions. The guard then demanded approval for rules the PR never touched (PR #3387, 2026-11-27: two standards that arrived with #3486). The measurement step already used the merge base, so the direction guard was the odd one out.

## Why it is safe (the trust root stays on main)

- `HEAD^1` of GitHub's merge ref is the base-branch tip, never a PR commit. The PR's own changes are in `HEAD^2`, and still count as its own.
- The `origin/main` ancestor test confines the base to main. The checkout step is pinned with `fetch-depth: 0` and no `ref:`, and no PR code runs before this step.
- Fork PRs have the upstream `origin/main`. `pull_request_target` is not a trigger, and the pin refuses adding it.
- Both ancestor tests sit inside an `if`. If either fails or errors (under `bash -e`), the event base stands.

## Enforcement

`scripts/standards-coverage.mjs` pins the step's exact `run` text, its env keys (`BASE_SHA` and `EVENT_NAME`, with `EVENT_NAME` exactly `${{ github.event_name }}`), and the check step's `STANDARDS_DIRECTION_BASE_REVISION: ${{ steps.area-audit-base.outputs.base }}`. Any other workflow shape is refused. `tests/unit/standards-direction-base-merge-parent.test.ts` runs the real step from ci.yml in throwaway repositories, on both sides of each condition.

## Known consequences and limits

- Signed direction ratifications are tied to the base revision, which now moves whenever main moves. A ratification for an older base no longer matches, and must be re-signed. This fails closed.
- Other steps still read the event base: "Migration consumer lockstep" (`--diff-base`) and `AUDIT_CHANGE_BASE_SHA`. They are out of scope here. If they show the same stale-base symptom, the same rule applies.
- A race remains: if main gains a registry change between GitHub building the merge ref and the run, this rule follows the merge ref, so the run stays self-consistent.

## Review

An independent read-only reviewer DISSENTed first. Review-triggered runs kept the stale base, and that is fixed. It then CONCURred: no bypass, the pin is exact, and the fallbacks are safe. The record is in `upgrades/side-effects/standards-direction-merge-parent-base.md`.
