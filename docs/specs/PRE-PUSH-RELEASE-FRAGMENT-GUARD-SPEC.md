---
title: "Pre-push gate: src change without a release fragment fails loudly (#23)"
slug: "pre-push-release-fragment-guard"
author: "echo"
status: "converged"
review-convergence: "2026-05-31T18:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-31T18:30:00Z"
approved: true
approved-by: "echo"
approved-date: "2026-05-31"
approval-note: "Closes the long-standing #23 silent-release-skip class. Self-approved under the standing autonomous-dev mandate; flagged in the PR. Low-risk guard mirroring the existing src→tests check."
eli16-overview: "PRE-PUSH-RELEASE-FRAGMENT-GUARD-SPEC.eli16.md"
---

# Pre-push gate: src change without a release fragment fails loudly (#23)

## Problem

`publish.yml` (the post-merge release workflow) decides whether to publish by
checking for release notes: if there is no `upgrades/next/<slug>.md` fragment AND
no `upgrades/NEXT.md`, it sets `skip=true` and **silently skips the release**
(publish.yml: "No NEXT.md found — nothing to publish"). So a shippable `src/`
change that merges WITHOUT a release-note fragment merges to `main` but **never
ships** — with no signal anywhere. This is the #23 failure class, lived in
practice (a fix sat unreleased because the PR had no NEXT.md).

The pre-push gate (`scripts/pre-push-gate.js`) already guards related cases — it
validates the assembled release notes for required sections and malformed
fragments, and warns when `src/` changed but no test file changed — but it has
**no check** for "`src/` changed but no release fragment exists at all". So the
silent-skip slips through every local gate.

## Fix

Add a check in `scripts/pre-push-gate.js`, directly mirroring the existing
src→tests check (same `changedFiles` branch diff, same shape): if `src/` `.ts`
files changed in the branch AND no `upgrades/next/*.md` fragment (or
`upgrades/NEXT.md`) is in the diff, push an **error** (gate exits non-zero):

```js
const fragmentChanges = changedFiles.filter(f =>
  f.startsWith('upgrades/next/') || f === 'upgrades/NEXT.md'
);
if (srcChanges.length > 0 && fragmentChanges.length === 0) {
  errors.push(`… source file(s) changed but no release-note fragment … SILENTLY SKIPS the release …`);
}
```

## Why this is safe / correct

- **No false positive on the release-cut commit.** The `chore: release [skip ci]`
  commit renames `NEXT.md` → `<version>.md` and touches `upgrades/` but NOT
  `src/`, so `srcChanges.length === 0` and the check never trips.
- **No false positive on docs/test-only PRs** — `srcChanges` only counts
  `src/**.ts`.
- **Error, not warning** — a silent release-skip is a real failure (the fix never
  ships), so it must block. Genuine WIP pushes bypass with the existing
  `INSTAR_PRE_PUSH_SKIP=1` (same escape hatch as the rest of the gate).
- It lives inside the same `try` that already brackets the git-diff checks, so a
  git failure (CI / detached HEAD) skips it gracefully — same as the existing
  checks.

## Non-goals

- Does not change publish.yml's skip logic itself (the skip is correct when there
  genuinely is nothing to release; the gap was the missing *pre-merge* signal).
- Does not add a CI-level mirror (the pre-push gate is the established place for
  these git-diff checks; a CI mirror is a possible follow-up but out of scope).

## Tests

`tests/unit/pre-push-gate.test.ts` adds a content-assertion test verifying the
guard's message + the fragment-detection logic are present — matching the file's
established testing approach for the gate's git-dependent checks (the src→tests
check is tested the same way; the git-diff section is skipped in the scratch-repo
integration tests because they are not git repos). `npm run lint` + `tsc` clean;
all 14 pre-push-gate tests pass.
