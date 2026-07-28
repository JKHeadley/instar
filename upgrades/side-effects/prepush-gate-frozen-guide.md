# Side-effects review — pre-push gate stops validating the frozen versioned guide

**Change:** `scripts/pre-push-gate.js` check 5 (side-effects-artifact requirement) is scoped to
in-flight release notes. It no longer falls back to `upgrades/<version>.md` — the guide for the
version that already shipped.

**Tier:** 1. One local developer gate. No `src/` surface, no route, no config, no persisted state,
no migration. Not run in CI (`if (!process.env.CI)`), so it cannot change what merges — only what a
developer can push from their own machine.

## The defect, with its recurrence record

Post-release-cut the tree has `upgrades/<version>.md` (frozen), no fragments, and no
`upgrades/side-effects/<version>.md`. That last file is one the release flow never creates: artifacts
are named per change slug. The fallback demanded it anyway, so **every push from a clean
post-release tree was refused**.

Three observed recurrences, all self-documented in the repo:

| version | evidence |
|---|---|
| v1.3.492 | `upgrades/side-effects/1.3.492.md` — a hand-written placeholder that says so |
| v1.3.802 | `upgrades/side-effects/1.3.802.md` — same, and calls itself "its second observed recurrence" |
| v1.3.1009 | today; refused this branch's sibling PR before diagnosis |

Both placeholders state the gap "remains logged in the framework-issues ledger under dedupKey
`pre-push-gate-versioned-artifact-fallback`". **It is not.** Queried four ways
(`GET /framework-issues` unfiltered, `?status=fixed`, `?bucket=instar-integration-gap`,
`?framework=instar`): 163 issues, zero matches, and no dedupKey in the store containing `release`,
`artifact`, or `push`. The tracking claim was hollow, which is why it recurred a third time. The
issue is registered for real as part of this change.

## What is NOT weakened — the load-bearing question

Removing a check is the risky half of this. Three separate enforcement points remain:

1. **`scripts/instar-dev-precommit.js` — untouched.** This is the real per-change enforcement: it
   refuses a COMMIT whose in-scope staged files lack an ELI16 doc and a side-effects artifact, and
   it verifies the artifact's sha against the decision trace. It blocked this very change twice
   while it was being written.
2. **Check 3b — untouched.** A push with release-relevant files and no fragment is still refused,
   with an actionable remedy (`add upgrades/next/<slug>.md`).
3. **Check 5 itself — still fires, scoped.** With in-flight notes claiming a fix and no fresh
   artifact, it refuses exactly as before. Test:
   `STILL refuses an in-flight fix-claiming fragment with no fresh side-effects artifact`.

The narrowed case — "no in-flight notes, frozen guide claims a fix, no version-named artifact" — was
never a real signal. It fired on a release that had already shipped and already been reviewed.

## Blast radius

A developer can now push from a clean post-release tree without hand-writing a placeholder. That is
the entire behavioural change. Nothing in CI, publishing, or runtime reads this script.

**Residual risk:** if the release process ever DID start producing version-named artifacts and
someone relied on this check to enforce that, this would silently stop enforcing it. Judged
acceptable: no such producer exists, and the 37 version-named artifacts already in the repo are
release rollups and placeholders, not a maintained convention.

## Verification

Verified by REVERTING, because a passing test proves nothing:

```
against the OLD gate:  3 failed | 16 passed (19)
  × ACCEPTS a post-release-cut tree with no fragment and no version-named artifact
  × does not demand a version-named side-effects artifact even when one has never existed
  × STILL refuses an in-flight fix-claiming fragment with no fresh side-effects artifact
against the NEW gate:  19 passed (19)
```

Plus a live run against the real repo in its actual post-cut state (v1.3.1009, no fragments): errors
before, warnings only after.

## Rollback

`git revert`. The gate returns to refusing every clean post-release push, and the next person writes
`upgrades/side-effects/<version>.md` by hand for the fourth time.
