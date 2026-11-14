# Side-Effects Review — Run the lint chain in parallel; stop repeating identical git reads

**Version / slug:** `lint-parallel-runner`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (required: harness-changing — package.json scripts, commit hook)`

## Summary of the change

Tier 1, 6 files. Two independent speed-ups to `npm run lint`, which runs on every commit (`.husky/pre-commit`) and in CI.

1. **Parallel runner.** New `scripts/run-lint-parallel.mjs` reads `package.json` `scripts.lint`, splits it on `&&` exactly as Local Verify's orchestrator does (`orchestrator.ts` `splitScript`), and runs the steps with bounded concurrency (default `min(8, cores − 1)`, `INSTAR_LINT_CONCURRENCY=1` for serial). New script `lint:parallel`; `.husky/pre-commit` and the CI `lint` job call it. `scripts.lint` is unchanged, so it stays the single list of steps that Local Verify runs and that the wiring tests assert on — the runner cannot drift from it.
2. **Memoized snapshot reads.** `scripts/lib/standards-enforcement-measurement.mjs` `resolveProtectedMeasurementSnapshot` answered `readFile` / `listFiles` / `hasMarker` with a fresh `git` process every call against a fixed commit. One `standards-coverage` run spawned 891 git processes (678 `git show` for 221 distinct paths — one file 36 times — and 207 `git grep` for 55 distinct markers). Each answer is a pure function of an immutable commit, so each distinct question now runs git once.

Measured on Mama PC (10 logical cores), same worktree:

| | Before | After |
|---|---|---|
| `standards-coverage.mjs --json` (inside `lint-documented-only-countdown`), run back-to-back | 54.9 s | 21.7 s, output byte-identical (`generatedAt` excluded) |
| whole lint chain, serial `npm run lint` | 153.9 s | — |
| whole lint chain, `lint:parallel` (TS 5.9 type-check still in it) | — | 105.9 s, the type-check step itself being the 105.9 s long pole |

With the TypeScript 7 change (PR #2405) the type-check step is ~15 s, so the long pole becomes `lint-no-direct-destructive` (~22 s alone, ~60 s under full contention).

Effort: 1 profiling pass, 1 fix to the runner (PATH, below), 1 second-pass round (one blocking finding: the new test's own temp-file cleanup used `fs.unlinkSync`, which `lint-no-direct-destructive` rejects; it now writes into a fresh `mkdtemp` directory and deletes nothing), 1 commit attempt so far.

## Decision-point inventory

No decision-point surface. Which checks run, and what each decides, is unchanged; only scheduling (serial → concurrent) and the number of git subprocesses behind identical questions change. Two observable differences, both deliberate: a failing step no longer stops the remaining steps (every failure is reported in one run), and each step's output is printed whole in list order after it finishes rather than streamed.

---

## 1. Over-block

No new rejection. The runner fails exactly when at least one step exits non-zero — the same condition as the `&&` chain (which fails on the first). Under heavy contention a step with an internal timeout could in principle time out where it would not serially; none of the 49 steps has a wall-clock budget that failed in the measured runs, and `INSTAR_LINT_CONCURRENCY=1` restores serial execution.

---

## 2. Under-block

Could the runner pass where the chain fails? Only if a step's verdict depended on a previous step having run first. Checked: no step reads another's output; the five steps whose sources contain file writes write only under flags the chain never passes (`generate-standards-hierarchy.mjs` writes only without `--check` and exits before the write path in check mode; `lint-no-wholefile-sync-read.js` and `lint-sync-subprocess-chokepoint.js` only with `--write-baseline`; `lint-no-direct-destructive.js` and `lint-state-registry.js` only mention write APIs in comments/patterns). The runner prepends `node_modules/.bin` to PATH exactly as `npm run` does — the first measured run without it failed the `tsc --noEmit` step, which is the PATH test in `tests/unit/run-lint-parallel.test.ts`.

Memoization: could a cached answer be stale? No — every question is asked of `baseRevision`, a fixed commit SHA resolved once per snapshot; git objects at a commit cannot change. Only successful git output is cached: a null (absent path, no match, or a transient git failure) is not, so a repeated question asks git again exactly as before (raised by the second pass). `listFiles` builds a fresh array from the cached text on each call, so a caller cannot mutate the cache.

---

## 3. Level-of-abstraction fit

The runner sits beside the chain rather than replacing it, so the existing owner of "which lint steps exist" (`scripts.lint`, read by Local Verify and asserted by tests) keeps that role. The memo lives inside the snapshot object, the only place that knows the answers are immutable.

---

## 4. Signal vs authority compliance

Not applicable — no detector or authority is added or changed (`docs/signal-vs-authority.md` reviewed).

---

## 5. Interactions

- **Local Verify (Increasing Throughput topic, 130715):** untouched. It still splits `scripts.lint` and runs the steps serially; it could adopt the runner later, which is that topic's call. This PR changes `package.json` scripts, so Local Verify will classify it harness-changing and route it through the second pass — intended.
- **CPU contention:** up to 8 concurrent node processes during a commit or CI lint. On a shared machine this competes with other work for the length of the lint run; the total CPU is the same as serial (it is the same commands), it is just spent in less wall time.
- **Output:** buffered per step, so a step that hangs shows nothing until it ends; the hook's own timeouts are unchanged.
- **Interaction with PR #2405:** independent files except `package.json` (different keys); either merge order works.

---

## 6. External surfaces

None for agents or users: lint scripts are development tooling and are not part of the published package's runtime. Developers see faster commits and, on failure, every failing step at once.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: a development-tool runner executed per checkout. No state, notices or URLs.

---

## 8. Rollback cost

Revert the PR, or locally set `INSTAR_LINT_CONCURRENCY=1` for serial execution with the same runner. No state or migration.

## Second-pass review

**Reviewer:** independent subagent
**Verdict:** Concur with the review. (Round 1 raised a concern: the new test at `tests/unit/run-lint-parallel.test.ts:40` called `fs.unlinkSync`, which `lint-no-direct-destructive` rejects, so lint failed. Resolved in round 2: the test now writes into a fresh `fs.mkdtempSync` directory and deletes nothing.)

What I checked (with commands, not the artifact's word):
- Step independence: grepped every step script for file writes, temp paths, git mutations and npm_* env. The only writes (`lint-no-wholefile-sync-read.js`, `lint-sync-subprocess-chokepoint.js` behind `--write-baseline`; `generate-standards-hierarchy.mjs` without `--check`) are in modes the chain never passes. Git use across steps is read-only (`diff`, `show`, `merge-base`, `ls-tree`, `grep`); the one `fetch` (standards measurement, via `lint-documented-only-countdown.mjs`) is by-SHA with `--no-write-fetch-head` and moves no ref. `lint-deferral-carrier-resolvable.mjs --staged` only reads the index. No step reads npm_* variables.
- Split: `parseLintSteps` is the same `split('&&').map(trim).filter(Boolean)` as `src/localVerify/orchestrator.ts:231`; all 49 steps reported exactly once in the parallel log.
- Exit handling (ran `runSteps` directly): SIGKILLed step -> code 1 + signal; unspawnable command -> 127 with the shell's message captured; failing step's stdout+stderr printed; Node emits `close` (code -2) after a spawn ENOENT, so a missing `sh` also fails.
- End-to-end: `npm run lint` and `npm run lint:parallel` both exit 1 on the same single step (above); the other 48 pass in parallel. `set -e` in `.husky/pre-commit` and the CI `run:` step both fail on that non-zero exit.
- Memoization: `node scripts/standards-coverage.mjs --json` on a HEAD worktree with the old vs new lib: byte-identical apart from `generatedAt` (measurement status `proven`, real merge-base path), 81s -> 33s. Keys are post-validation; `baseRevision` is a fixed SHA; `listFiles` returns a copy. Minor note only: a transient git failure (e.g. timeout -> null) is now cached for the snapshot's life instead of retried per call.
- Unit test `tests/unit/run-lint-parallel.test.ts`: 6/6 pass.

Round 2 re-check (after the fixes):
- `node scripts/lint-no-direct-destructive.js` exits 0.
- `npm run lint:parallel` (TMPDIR=/home/echo/echo-test-tmp): exit 0, all 49 steps passed in 183.7s at concurrency 8.
- `tests/unit/run-lint-parallel.test.ts`: 6/6 pass.
- Memo now caches only non-null git output (`show`, `ls-tree`, `grep`); a null is re-asked on every call as before, so the round-1 minor note about caching transient failures no longer applies. A `grep -q` match returns "" (non-null, cached true); no match returns null (not cached). `listFiles` parses a fresh array per call.
- Fresh standards-coverage comparison, HEAD lib vs new lib on a temporary HEAD worktree: byte-identical apart from `generatedAt`, measurement status `proven`.
