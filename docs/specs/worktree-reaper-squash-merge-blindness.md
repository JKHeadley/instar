---
title: "AgentWorktreeReaper — it cannot see a squash-merged branch, so it reclaims nothing"
slug: "worktree-reaper-squash-merge-blindness"
author: "echo"
status: "draft"
parent-principle: "Verify-the-State-not-its-Symbol"
approved: false
---

# AgentWorktreeReaper — it cannot see a squash-merged branch, so it reclaims nothing

## Problem statement

The `AgentWorktreeReaper` reclaims a worktree that is **merged + clean + not-in-use**. The
merged test is git ancestry: is the branch contained in `main`?

Every change in this repository lands through `scripts/safe-merge.mjs … --squash`. A squash
merge writes a **new** commit containing the branch's combined diff; the branch's own commits
are never ancestors of `main`. So a branch whose work shipped months ago still fails the
ancestry test, permanently.

The reaper is therefore structurally incapable of reclaiming anything in this repository. It is
not disabled and not misconfigured — it runs, evaluates every worktree, and correctly concludes
"keep" every time, forever.

### Measured on the operator's laptop, 2026-08-16

`GET /worktrees/agent-reaper`: `enabled: true`, `dryRun: false`, `lastPassAt` recent,
**`reclaimable: 0`**, 58 worktrees, all verdict `keep`:

| keep reason | count |
|---|---|
| `uncommitted-changes` | 38 |
| `unmerged` | 17 |
| `detached-or-unknown-branch` | 3 |

Disk: **11 GB** under `.worktrees/`, and a corresponding Spotlight indexing load (each worktree
is a full ~13,000-file source tree).

Three branches were checked against GitHub rather than assumed. All three had **merged** pull
requests, and none is an ancestor of `main`:

| branch | PR | merged | ancestor of main |
|---|---|---|---|
| `echo/cartographer-doc-tree` | #1041 | yes | no |
| `echo/token-audit-completeness` | #1064 | yes | no |
| `echo/build-session-clock` | #683 | yes | no |

This is the *Verify-the-State-not-its-Symbol* failure in its exact shape: ancestry is a **symbol**
for "the work is in main", and squash-merge breaks the correspondence while leaving the symbol
readable and confidently wrong.

### Why the obvious local alternatives do not work

- **`git diff main...branch` is empty.** No: three-dot diff is `merge-base..branch`, which shows
  the branch's own changes whether or not `main` absorbed them. Measured on the three
  known-merged branches above: 22, 57 and 15 files respectively. This test never passes.
- **`git cherry`.** Detects patch-equivalent commits. A squash combines N commits into one, so
  the patch-ids do not correspond. Does not detect squash merges.
- **Comparing the branch's touched files against `main`.** `main` legitimately moves on after a
  merge, so a merged branch's files routinely differ from `main` today. Would produce false
  negatives constantly, and — worse — occasional false positives.

There is no reliable purely-local test. The authoritative fact ("this branch's PR was merged")
lives on the forge.

## What this proposes

Add a **second** merged-test that consults the forge, strictly as an additional way to say
"merged". The existing ancestry test is unchanged and still runs first as the fast path.

```
merged := ancestry-says-merged  OR  forge-says-its-PR-was-merged
```

Everything else — clean, not-in-use, uncommitted-changes, lock and running-process checks — is
untouched. This proposal changes **only** the merged predicate.

### Fail-closed is the whole design

The reaper deletes. Every uncertainty must resolve to **keep**:

- no network, no token, no configured remote → keep
- API error, rate limit, timeout → keep
- no PR found for the branch → keep
- PR exists but is open or closed-unmerged → keep
- more than one PR for the head and any of them is not merged → keep

Only an unambiguous "a PR whose head is this branch was merged" flips the predicate. A reaper
that cannot reach the forge behaves exactly as it does today — which is to say, it reclaims
nothing, which is the current state and therefore a safe floor.

### Open questions for convergence

1. **Where does the forge answer come from?** Options: `gh api` on the machine (inherits the
   operator's auth, no new credential, but a shell dependency inside a destructive path), or a
   direct API call with the agent's existing token. The `gh` route is the current lean because it
   introduces no new credential handling.
2. **Caching.** 58 worktrees per pass is 58 API calls if uncached. A per-branch cache keyed on
   branch name with a merged-is-permanent rule (a merged PR never un-merges) makes this one call
   per branch, ever.
3. **Should the first release be `dryRun: true` regardless of config?** Given this change makes a
   reaper that has reclaimed *nothing* suddenly able to reclaim *dozens*, a forced observation
   pass — report what it would delete, delete nothing — is the conservative sequencing. Strongly
   recommended.
4. **Does anything else share this blindness?** Any other code asking "is this branch merged" by
   ancestry has the same defect. A sweep is needed before this closes.

### What this deliberately does not address

The 38 worktrees held by `uncommitted-changes` and the 3 `detached-or-unknown-branch` are
**correctly** kept and stay kept. Of the 38, a hand audit found 30 carrying real authored changes
(one, `macos26-launchd-tcc-fix`, has 612 modified files) and 8 dirty only with build leftovers —
and all 8 of those are *also* unmerged, so nothing about them changes here. Making the reaper
ignore "generated" files is a separate and much more dangerous proposal; it is not in scope.

## Decision points touched

- **Modifies** the merged predicate in `AgentWorktreeReaper` — additive, fail-closed, ancestry
  still authoritative when it says yes.
- **Adds** a forge dependency to a destructive path, with absence-of-forge degrading to today's
  behavior exactly.
- **Does not touch** the clean test, the in-use test, the reap budget, or the audit trail.

## Risks

- **The whole risk is a false "merged".** A wrong yes deletes a checkout containing work. This is
  why every uncertainty is keep, why the forge answer must be an exact head-branch match on a
  merged PR, and why a forced dry-run first pass is recommended. Note the residual even when
  correct: the branch and its commits survive a reap; only the working copy is removed. Deleting
  a merged branch's checkout loses nothing that is not in `main` — provided the merged
  determination is right.
- **A destructive component gaining a network dependency** is a genuine complexity increase in
  the worst place to add complexity. Mitigated by the dependency being *permission to delete more*
  rather than *permission to delete at all*: unreachable forge = today's behavior.

## Status

Draft, authored 2026-08-16 from measured live state (the reaper snapshot, the 58-worktree hand
audit, and three GitHub PR lookups). Not converged, not approved. Because this component deletes
operator data, no code should land against this document until it is both.
