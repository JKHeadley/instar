# Side-Effects Review — Local Verify: skip ratchet resolves typescript; parser failure is not harness-changing; the carve-out admits `log`

**Version / slug:** `local-verify-classify-typescript`
**Date:** `2026-10-23`
**Author:** `echo`
**Second-pass reviewer:** `claude-opus reviewer subagent (independent)`

## Summary of the change

`src/localVerify/skipRatchet.ts` gains `loadTypescript(fromDirs)`, which resolves `typescript` from each given directory, then from its own install. `src/localVerify/orchestrator.ts` `classify()` passes the run worktree (just installed by `npm ci`), or an injected `seams.typescript()`, to `evaluateSkipRatchet`, and wraps the ratchet in its own try: a parser failure sets `skipsAdded`/`testsRemoved` (only when an inventoried test file changed) and logs `skip-ratchet-failure`, instead of falling into the outer catch that sets `harnessChanging`. The spec (`docs/specs/local-verify-merge-authority.md` §2) gets one amendment sentence. **Second fix, found by this PR's own verify:** `src/core/SafeGitExecutor.ts` adds `log` to `LOCAL_VERIFY_CLONE_VERBS`. The independent-review head binding (#2316) runs `git log <base>..<head> -- <paths>` through the verifier's git funnel, but the carve-out never admitted `log`, so the guard refused it as an op against the instar source tree and every flagged PR was refused `trace-commit-unreadable` (this PR's first run, 2026-10-23 21:45Z). A unit test in `tests/unit/localVerify/safeGitCarveOut.test.ts` covers the admitted shapes and that `rev-list` stays outside the set. Tier 1: two narrow bug fixes, fully undone by a revert; 3 source files, ~90 LOC; two commit attempts (the second after the first verify exposed the carve-out gap), no spec rounds (bug fixes against an existing converged spec).

## Decision-point inventory

- `classify()` flags (`harnessChanging`, `skipsAdded`, `testsRemoved`) — modify — a ratchet parser failure no longer sets `harnessChanging`; it sets the two ratchet flags.
- Flagged-path set for the independent-review lookup — modify — on a parser failure it is the changed inventoried test files (plus any harness/protected paths), not "unknown".
- `LOCAL_VERIFY_CLONE_VERBS` in `SafeGitExecutor` (the source-tree guard's local-verify carve-out) — modify — admits the read verb `log`; every other rule of the carve-out (targets inside `.worktrees/.verify`, the git dir pinned and probed to resolve inside it, the destructive-verb list) is unchanged.

---

## 1. Over-block

Previously every PR touching a `.test.ts` was flagged harness-changing (over-block, the bug). Now, if the parser still cannot load, a PR changing an inventoried test file is flagged skips-added/tests-removed even if it added no skip: still a flag, but a narrower, honestly-labelled one that a review covering the test files admits. In the normal case (parser loads from the run worktree) nothing is over-flagged.

## 2. Under-block

Carve-out: admitting `log` admits a read only. It cannot write refs, objects or the work tree; the pinned `GIT_DIR` + ceiling and the `rev-parse --absolute-git-dir` probe still require the repository to resolve inside `.worktrees/.verify`, so a `log` against the agent home is still refused (the existing refusal tests hold). `rev-list` and `diff-tree` are deliberately not added — nothing needs them.

A parser failure no longer marks a PR harness-changing. That is correct: a harness change is decided by the harness classifier over the diff, which still runs and still sets `harnessChanging` for harness paths; only the ratchet was unmeasurable, and it now fails closed on its own flags. A real diff read failure (merge-base, diff, show) still goes to the outer catch and sets `harnessChanging` + `protectedPath`. Resolving typescript from the run worktree loads the merge tree's pinned typescript; a PR that changes that pin in `package.json`/`package-lock.json` is classified harness-changing by the toolchain rule, so a PR cannot swap the parser through the toolchain pin; a non-toolchain dependency's postinstall overwriting `node_modules/typescript` is a residual accepted by the spec's threat model (it applies equally to vitest today). Threat model unchanged (trusted principals; the lanes already execute the PR's code on this machine).

## 3. Level-of-abstraction fit

Right layer: the ratchet's own failure is handled where the ratchet is called; the parser location is a resolution concern of the module that needs it, with an injection seam for tests and callers.

## 4. Signal vs authority compliance

No new authority. The flags are inputs to the existing §3 merge predicate (which admits flagged records only with a concurring independent review). The change makes the flag more accurate; a failure still fails closed (flagged), never open.

## 5. Interactions

The carve-out change interacts with `findIndependentReview`'s `staleAfterTrace` only; the feedback-executor clone carve-out has its own verb set and is untouched.

`findIndependentReview` now receives the test files as flagged paths on a parser failure instead of nothing extra; a covering trace admits it, as for any skips-added record. Status projection labels the record `skips-added` rather than `harness-changing`. `computeVerifierVersion` hashes the installed dist, so the verifier version changes on release, as for any localVerify change.

## 6. External surfaces

The `instar/local-verify` status description label for affected PRs changes from `harness-changing` to none (normal case) or `skips-added`. No API shape change; one new log event name in the run log.

## 7. Multi-machine posture

Machine-local by design: local-verify runs on the lease holder, records are machine-local per the spec; this change alters only the computation inside a run.

## 8. Rollback cost

Revert the commit and release. Note the chicken-and-egg this PR broke: before the carve-out fix, no flagged PR (including a fix PR) could pass the review binding, so the first merge of this change needs the binding to work — that is why the carve-out fix rides in the same PR. No data migration; existing records keep their stored flags (a re-verify recomputes).

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (claude-opus-5-5), 2026-10-23
**Independent read of the artifact: concur**

Concur with the review. Checked: (a) the parser cannot be swapped through the toolchain pin — `lockToolchain` compares version+resolved+integrity for `node_modules/typescript`, `manifestToolchain` the spec string, and `patches/**`, `.npmrc`, `scripts`/`overrides` and lifecycle scripts are on the glob list; a committed `node_modules` is wiped by `npm ci`; the dependency-postinstall residual is inside the trusted-principals threat model. (b) Fail-closed holds: the inner catch flags both ratchet flags whenever an inventoried changed test file exists; a module that loads but is wrong throws in `createSourceFile` into the same catch; diff/merge-base/show failures still reach the outer catch. (c) The failure path's flagged set equals `evaluateSkipRatchet`'s `perFile` set. (d) The tests fail without the fix (the un-fixed ratchet returns `skipsAdded:false`; the injected-parser counter stays 0; `loadTypescript` was unexported). (e) No spec contradiction. Nits applied: the failure is now logged even when no inventoried file changed (`inventoriedChanged` count) and §2 names the residual. Nit accepted as a stated limit: no unit test drives `loadTypescript([p.runDir])` through the orchestrator's real wiring, because under vitest the own-install fallback always succeeds; the run logs on the next real verify are the check.

**Second pass on the carve-out fix** (independent reviewer subagent, claude-opus-5-5, 2026-10-23): **concur.** Checked: admitting `log` adds no primitive `diff`/`show` lack (same `--output` surface, no hooks; `-C`/`--git-dir`/`--work-tree` values are targets that must realpath inside `verifyRoot`; `GIT_DIR` + ceiling pinned; the `--absolute-git-dir` probe still gates); `log` is in `READONLY_GIT_VERBS`, so `run` routes it to `readSync` and the carve-out (unlike `diff-tree`, which is in neither set); the new test's `rev-list` assertion is the exact pre-fix path, so removing `'log'` flips the first expectation to a throw; `SafeGitExecutor.ts` is on neither the harness globs nor the protected list; the same-PR argument holds (any fix PR with a test file was flagged by the broken ratchet, and any flagged PR was refused by the broken binding). Follow-up named, filed to the feedback queue rather than this PR: the orchestrator's git verb usage and `LOCAL_VERIFY_CLONE_VERBS` share no source of truth (orchestrator tests mock git), which is how #2316 shipped a verb the funnel refused; a test driving `classify`'s real git sequence through the seam against a real clone would close it.
