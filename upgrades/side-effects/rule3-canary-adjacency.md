# Side-effects review — Rule 3 canary adjacency

**Change:** `hasMatchingCanary` in `scripts/check-rule3-coverage.cjs` — the basename fallback is scoped
to the file's own directory, and the canary-directory probe now covers both layouts. One new test.

## Direction of effect

**Stricter**, so the risk to weigh is a false REFUSAL blocking legitimate work.

| situation | before | after |
|---|---|---|
| canary in `<dir>/canary/` | **missed** (only `<parent>/canary` was computed) | matched |
| canary in `<parent>/canary/` | matched | matched |
| canary-named file **beside** the source | matched | matched |
| canary-named file **anywhere else in the commit** | matched ❌ | **not matched** — the fix |
| no canary, but a rationale comment | passes | passes (unchanged) |

Rule 3 is satisfied by `inRegistry && (rationale || canary)` **or** `rationale && canary`, so a file
with a rationale is unaffected either way. This only removes credit that was never earned.

## The interaction that made this worth care

Removing the global fallback alone would have **broken** the check: the directory probe computed
`<parent-of-dir>/canary`, which misses a source sitting directly in an adapter root. The fallback was
masking it. An existing test caught this immediately — I had assumed the test was wrong, and it was
describing a real layout.

## Sequencing — why now and not earlier

Filed as ACT-1472 and deliberately held: making this stricter **before** #1701 (judge the author's
contribution, not the merge index) would have surfaced all of main's latent Rule 3 violations on every
merge. #1701 is now on `main` (verified: `mergeHeadIfMerging` present), so a merge evaluates only the
committer's own files and this cannot cascade.

## Blast radius

Pre-commit script only — not in `src/`, not shipped, not executed at runtime. `git revert` restores
both the permissive fallback and the layout blind spot.

## Verification

- Red → green: the new unrelated-canary test fails without the change (1 failed / 26 passed) and passes
  with it (27/27).
- The pre-existing "canary staged alongside" test passes, which is what demonstrates the layout fix —
  it was the failure that revealed the second bug.
