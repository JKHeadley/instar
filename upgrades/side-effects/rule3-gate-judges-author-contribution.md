# Side-effects review — Rule 3 gate judges the author's contribution

**Change:** `getStagedFiles()` in `scripts/check-rule3-coverage.cjs` diffs against `MERGE_HEAD` while
a merge is in progress; a new `mergeHeadIfMerging()` helper detects that state. Two merge-semantics
tests added.

## Direction of effect — the only question that matters for a gate

More permissive **during a merge only**, so the risk to weigh is a false ACCEPT.

| situation | before | after |
|---|---|---|
| Ordinary commit (no merge) | full index | **identical** — `MERGE_HEAD` absent, original path taken |
| Merge: file verbatim from incoming ref | judged as yours ❌ | not judged ✅ **(the fix)** |
| Merge: file you resolved / authored | judged | **still judged** — differs from `MERGE_HEAD` |
| Merge: unrelated file you also staged | judged | **still judged** — differs from `MERGE_HEAD` |
| `git diff` against `MERGE_HEAD` fails | n/a | falls back to the full index — the **stricter** reading |

The load-bearing claim is row 3, and it is asserted by a test that fails if the fix is too permissive.
It is the reason this is scoping rather than weakening: content that exists on neither parent is
authored content, and it is still evaluated.

## What could go wrong, honestly

**A file the author deliberately reverts to the incoming version.** If you resolve a conflict by
taking the incoming side wholesale, that file no longer differs from `MERGE_HEAD` and is not judged.
That is correct by the definition used here — you contributed no content — but it does mean a merge
cannot be used to *re-introduce* an incoming violation under your name. Since the incoming ref already
contains it, the rule was already not being enforced there; this changes who is asked to fix it, not
whether it exists.

**Octopus merges** (>1 `MERGE_HEAD`) — `rev-parse --verify MERGE_HEAD` returns the first only. Rare in
this repo and it degrades toward the stricter side.

**Not addressed:** the 26 latent violators on `main` remain. This stops them landing on whoever merges
next; it does not add their missing justifications.

## Blast radius

Pre-commit script only. Not in `src/`, not bundled, not executed at runtime, no state, no migration,
no config. `git revert` restores the previous behaviour exactly.

## Verification

- **Red → green with a control**: before the fix the verbatim-from-incoming test failed while the
  author-resolved control passed (1 failed / 25 passed) — the control is what proves the fix targets
  the right thing rather than disabling the check. 26/26 after.
- The verbatim test asserts the file **is staged** before expecting a pass, so a pass cannot come from
  an empty file list.
- All 24 pre-existing tests pass unchanged.
- A harness bug found and fixed en route: the tests hardcoded `master`, but `init.defaultBranch` is
  `main` here. The branch name is now read from the repo, so the tests do not depend on the author's
  git config.
