# Side-Effects Review — honest merge-base verification (a refusal is not a fact)

## Summary of the change

Two defects in the projects `/advance` merge-base check, found 2026-07-25 while recording PR #1641
as merged (project `convergence-towards-coherence`, Tier 1 item 1).

**A. The read never declared itself a read.** `routes.ts`'s injected `gitMergeBaseIsAncestor`
called `SafeGitExecutor.readSync(['merge-base','--is-ancestor',…])` without
`sourceTreeReadOk: true`. A project's `targetRepoPath` IS an instar source tree on any dogfooding
agent, so `runSourceTreeChecks` refused the query every time with `SourceTreeGuardError`. Note
`merge-base` is ALREADY in `SOURCE_TREE_READ_TIER_VERBS` — the permission for exactly this read
existed and was never requested. Fix: pass the flag.

**B. (The load-bearing half.) The helper translated every failure into a factual negative.** The
old body was `catch { return false }` with a comment asserting that a non-zero exit "IS the
negative answer, not a degradation". That is true only for exit status 1. A guard refusal, a
missing binary, a bad revision (128) or a timeout all returned the same `false`, and the validator
turned it into `MERGE_COMMIT_UNREACHABLE` — "this merge is not on main" — about a merge that
demonstrably was. Fix: only `status === 1` returns false; every other failure is rethrown, and
`StageTransitionValidator` catches it and returns a NEW distinct code `MERGE_BASE_UNVERIFIABLE`
with the underlying cause in the reason.

Reproduced under the server's exact PATH/cwd BEFORE fixing, all four boundary cases:

| input | result | old code said |
|---|---|---|
| real merge SHA, no flag | `SourceTreeGuardError`, `status: undefined` | "not reachable" (false) |
| real merge SHA, with flag | returns → ancestor TRUE | — |
| real commit not on main | `status: 1` | "not reachable" (correct) |
| nonexistent SHA | `status: 128` | "not reachable" (wrong — unanswerable ≠ negative) |

## Decision-point inventory

- `gitMergeBaseIsAncestor` — a helper feeding a GATE (the `building → merged` transition). Its
  verdict decides whether a project item may be recorded merged. This change does not widen what
  passes: a genuine non-ancestor still fails. It narrows what is *called* a non-ancestor.
- `validateStageTransition` `to === 'merged'` — the gate itself. Gains one new refusal code; loses
  no existing refusal. `MERGE_COMMIT_UNREACHABLE` still fires for real non-ancestors
  (asserted in a dedicated test so the boundary is not blurred in the other direction).
- No other decision point, hook, reaper, sentinel, scheduler or migration path is touched.

## 1. Over-block

The gate becomes *more* likely to refuse in one respect: a case that previously produced
`MERGE_COMMIT_UNREACHABLE` may now produce `MERGE_BASE_UNVERIFIABLE`. Both are refusals, so nothing
that used to be blocked is now allowed — the transition is equally gated, with an honest reason.

The new `throw` path is bounded: it is caught inside `validateStageTransition` and converted to a
verdict. It cannot escape to a 500. (Asserted by the validator unit test, which passes a throwing
helper and expects `ok: false` with the new code, not an exception.)

## 2. Under-block

**Nothing is loosened.** `status === 1` — git's documented "not an ancestor" — still returns false
and still yields `MERGE_COMMIT_UNREACHABLE`. The one behaviour change in the permissive direction
is that a read the guard was refusing now succeeds; that read is already sanctioned for source
trees by `SOURCE_TREE_READ_TIER_VERBS`, so this asks for a permission the design already grants
rather than creating one.

`sourceTreeReadOk: true` is scoped to this single call. It does not relax SourceTreeGuard for any
other operation, and it cannot: the flag is per-invocation and only bypasses the check for verbs in
the read-tier set.

## 3. Blast radius

`src/server/routes.ts` (one helper), `src/core/StageTransitionValidator.ts` (one call wrapped, one
new code). Every consumer of the merged-transition verdict was checked:

- `grep -rn "MERGE_COMMIT_UNREACHABLE"` — the route surfaces `result.code` verbatim in a 409 body;
  no consumer switches on the code value, so a new code string breaks no branch.
- `tests/unit/StageTransitionValidator.test.ts` — 41 tests, all pass, including the pre-existing
  `MERGE_COMMIT_UNREACHABLE` case (deliberately kept and re-asserted).
- `tests/integration/projects-api.test.ts` — mocks the helper with plain booleans; unaffected,
  because the boolean contract is unchanged for helpers that do not throw.

## 4. Rollback plan

Single-commit revert; no state, no config key, no migration, no persisted artifact. Reverting
restores the previous (wrong) behaviour immediately with nothing to clean up.

## 5. Test coverage (all tiers that apply)

- **Unit — behaviour** (`tests/unit/StageTransitionValidator.test.ts`, +2): a throwing helper
  yields `MERGE_BASE_UNVERIFIABLE` with a `could not verify` reason carrying the cause; and — the
  other side of the boundary — a helper returning `false` still yields
  `MERGE_COMMIT_UNREACHABLE`. Both directions, because making refusals honest must not stop the
  check refusing real negatives.
- **Unit — wiring** (`tests/unit/projects-advance-mergebase-wiring.test.ts`, new): static
  introspection asserting the callsite carries `sourceTreeReadOk: true`, the helper tests
  `status === 1` explicitly and rethrows otherwise, the bare `catch { return false }` shape cannot
  reappear, and the validator produces the new code from a `catch`. Static rather than mocked
  **because mocking SafeGitExecutor is exactly how the existing `/advance` tests masked this gap**
  — a runtime mock never reaches the guard.
- **No new integration/e2e tier**: the route change is a two-line option + error-classification
  fix with no new endpoint or response shape; the existing `projects-api` integration suite covers
  the route, and the real end-to-end proof is the live advance succeeding after release (a
  condition of autonomous run `run-ms13zzrz-78576404`).

## 6. The bug CLASS, measured rather than guessed

**This is the second instance of the same bug.** In May the identical missing declaration made
failure-learning's git reads silently fail on dogfooding agents while `/failures/*` reported
health. It was fixed, and `tests/unit/failure-learning-source-tree-readok-wiring.test.ts` was
written to stop it recurring — **scoped to that subsystem's five files and its
`failure-learning:*` operations only.** So the class survived, moved one subsystem over, and
reproduced.

Exposure, measured (not estimated): **34 of 46** `SafeGitExecutor.readSync` callsites in `src/` do
not pass `sourceTreeReadOk: true`. Many are legitimate — `WorktreeManager` on a fresh clone,
`nuke.ts` on a shadow install, `commands/init.ts` on a user's own repo — where the target is not
the instar source tree and the guard should not be bypassed.

**Deliberately NOT swept in this change.** A blind flag-everything pass would touch 34 callsites
across subsystems whose target paths I have not verified, and would relax a safety guard on
evidence I do not have. That is precisely the confident over-reach this project exists to remove.
The honest form is a per-callsite audit answering "can this path ever be the instar source tree?",
which is real work with a known size.

Proposed follow-up, with the size stated so it cannot be mistaken for a quick fix: generalise the
May ratchet from one subsystem to a repo-wide default-plus-declared-exception check (each callsite
either carries the flag or an explicit `// source-tree-n/a: <reason>` marker), landing after the
34-callsite audit. <!-- tracked: CMT-1035 -->

## 7. One thing found while writing the test, recorded rather than tidied away

The assertion forbidding the old `catch { return false }` shape initially FAILED — because it
matched the helper's own comment, which quotes that shape while explaining its removal. A
text-matching check fooled by prose describing the thing it forbids. Fixed by stripping comments
before matching, and worth naming: our constitution says an LLM gate must not string-match, and
this is the static-check equivalent of the same trap. Cheap at test-writing time; the same mistake
inside a live gate is how you get a check that fires on nothing.
