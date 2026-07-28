# Side-effects review — Rule 3.1 rationale for `devClaimCheck`'s gh detector

**Change:** one doc-comment added above `defaultGhJson` in `src/commands/devClaimCheck.ts`.
23 lines, comment-only. No statement, expression, signature, export, or type is modified.

## What the change can affect

| Surface | Effect | Why |
|---|---|---|
| Runtime behaviour | **None** | A block comment. `tsc` emits identical JS; no code path is reachable through it. |
| Public API / CLI | **None** | `dev:claim-check` flags, output, and exit codes are untouched. |
| Tests | **None expected** | No test asserts on this file's source text. |
| The Rule 3 pre-commit gate | **Intended change** | This file stops being a violation. Verified: the gate refused this exact commit before the comment and accepted it after. |
| Other repos / migration | **None** | Not an agent-installed file, no config default, no template, no hook. Migration Parity does not apply. |
| Multi-machine posture | **N/A** | No state surface introduced. |

## The risk worth naming

The change is safe. The thing it *documents* is not, and I want that visible rather than
buried in a comment.

`JSON.parse(stdout || 'null')` resolves `null` on empty stdout. The caller's
`(await ghJson(...)) as ClaimPr[] ?? []` turns that into an empty array, and an empty array is
indistinguishable from "no open PR claims these files". Meanwhile a *thrown* error is handled
properly — it sets `ghDegraded` and the tool reports spec-scan-only.

So the loud path is loud and the quiet path is silently clean. That is the failure shape the
constitution calls out directly: a check that cannot run must not be indistinguishable from
one that ran clean.

**Not fixed here, deliberately.** Fixing it means changing behaviour (treating empty stdout as
a degradation), which deserves its own review and its own tests. Bundling it into a
comment-only change would hide a behaviour change inside a documentation commit. It is filed
separately.

**Reachability:** narrow. `gh pr list --json` emits `[]` on success, not empty output. It
would take a `gh` build that exits 0 while writing nothing, or truncated output. Low
likelihood, and the consequence is a false all-clear on an advisory tool — not a wrong gate
verdict.

## Rollback

`git revert`. Nothing depends on it; reverting restores the pre-existing violation and with it
the merge blocker.

## What I verified rather than assumed

- The file is `main`'s, not the PR's — it arrived via #813 (`144ff6122`, 2026-06-05) and is
  absent from the branch diff.
- `main`'s copy carries zero `RULE 3` markers (`grep -c` → 0).
- The refusal is real and reproducible: the same staged commit was blocked before the comment
  and passed the Rule 3 check after it.
- The fallback asymmetry is read from the code, not inferred — `catch` at the call site sets
  `ghDegraded`; the `?? []` at lines 197/201 absorbs `null` with no flag.


## Correction after opening: this was TWO files, not one

The first version of this change covered only `devClaimCheck.ts` and claimed that unblocked merging
`main` into an older branch. **That claim was false**, and an A/B test caught it: branching from a
pre-#813 `main` commit and staging a merge of current `main` flagged **two** files —
`devCiFailures.ts` as well. Fixing one of two blockers unblocks nothing.

`devCiFailures.ts` now carries its own rationale and registry row. It is marked **🔵 Exempt** rather
than Partial, because unlike its sibling every failure path is loud: a non-zero `gh` exit rejects
with captured stderr, and its `JSON.parse(stdout)` carries no `|| 'null'` default, so empty output
throws rather than degrading into a successful-looking empty result.

**How the check nearly fooled me.** My first A/B run reported the fixed side PASSING — but the merge
had failed (a ref I had not fetched), so nothing was staged and the checker exited 0 over an empty
file list. A vacuous pass is indistinguishable from a real one unless you assert the check had input.
The re-run prints staged counts: 7,499 files / 905 `src/*.ts` on the failing side, and refuses to
read 0 staged files as a pass.
