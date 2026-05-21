# Side-effects review — test-env-isolation

Spec: `docs/specs/test-env-isolation.md`
ELI16: `docs/specs/test-env-isolation.eli16.md`

## Surface map

| Layer | File(s) added / changed | Surface |
|------|------------------------|---------|
| 1 | `tests/vitest-setup.ts` | Process env at vitest startup. Every test inherits the strip. |
| 2 | `tests/helpers/git-test-env.ts` (new); refactors to `tests/unit/worktree-monitor.test.ts`, `tests/unit/SafeGitExecutor.test.ts`, `tests/integration/rich-profile-integration.test.ts` | Three fixtures' git-spawn calls now pass an explicit sanitized env. |
| 3 | `scripts/pre-push-fixture-guard.mjs` (new); `.husky/pre-push` (wire-in) | Pre-push hook gains a guard step that runs before the test suite. |
| 4 | `scripts/check-repo-invariants.mjs` (new); `.github/workflows/ci.yml` (new `invariants` job) | Standalone CI job, no dependencies, runs in parallel with type check. |
| 5 | Deletions: `file-0.txt`, `seed` | Repo root no longer carries fixture stowaways. |

Tests: 14 new across `tests/unit/vitest-setup-git-env-strip.test.ts`, `tests/unit/scripts/pre-push-fixture-guard.test.ts`, `tests/unit/scripts/check-repo-invariants.test.ts`.

## Over-block analysis

**Layer 1 strip.** Could a legitimate test *need* the inherited `GIT_DIR`? In our codebase, no — every existing fixture that touched git either operates on a tmpdir (which doesn't need it) or already strips the vars locally. We grepped `tests/` for any consumer of `process.env.GIT_DIR` and found zero direct readers. The strip cannot regress a test that depends on the override, because no such test exists.

If a future test needs to operate against the real repo (e.g., a meta-test that inspects the project's own git state), it can re-set the variable explicitly inside its own scope — the global strip removes the *inherited* value, not the *ability to set* one.

**Layer 3 fixture-author guard.** Could it block a legitimate commit? Possible failure cases:

- Author email of `test@test.com` is in the bad-author set. A real human who happens to use that email would be blocked. Mitigation: the email is in our internal fixture set; real contributors use their own emails. If a real case ever arises, `INSTAR_PRE_PUSH_FIXTURE_GUARD_SKIP=1` lets them through.
- Subject line `init` matches the pattern. A real "init" commit from a new repo bootstrap would trip the guard. Mitigation: bootstrap commits live on their own branch and aren't pushed against an established `upstream/main`, so the guard's `<base>..HEAD` range returns empty for them. Tested in `pre-push-fixture-guard.test.ts`.

**Layer 4 README line floor.** Could a legitimate README shrink below 100 lines? The current README is 271 lines and the project is growing, not shrinking. A deliberate slim-down would need `INSTAR_README_MIN_LINES` override, which is exactly the escape hatch.

## Under-block analysis

**Layers 1+2 don't catch process-spawning that re-injects the env.** If a future utility spawns `git` with an explicit `env: { GIT_DIR: '...' }`, layers 1+2 don't help — they only strip *inherited* env. Layer 3 catches the *consequence* (a pollution commit on the branch), so the failure class is still closed end-to-end, but layers 1+2 alone are not sufficient. This is acknowledged in the spec.

**Layer 3 doesn't catch destructive changes that don't match the historical signature.** A future test fixture that wrote `# Different Stub` to README would land it if the commit message and author look normal. Layer 4 catches the resulting line-count regression; together, layers 3 and 4 cover both the "known-pattern pollution" and "novel pollution that drops content" failure modes.

**Layer 4 doesn't enforce content correctness.** A README with 100+ lines of garbage would pass. We deliberately scoped Layer 4 to structural invariants only; content review is the job of human PR review.

## Level-of-abstraction fit

The fix lives at the right layer:

- The root cause is in *test setup*, so the fix is in `vitest-setup.ts` — the central, single point that runs before every test. We did not push the strip down into individual fixtures (would require N changes and could be missed); we did not push it up into the test runner config (the var would still leak into test files that import their own helpers that ran first).
- The push-time guard lives in `.husky/pre-push`, which is where push-time checks already live.
- The CI invariant is a standalone job, not a step bolted onto an existing job that might be skipped under failure-routing rules.

## Signal-vs-authority compliance

Layer 3 is a brittle pattern matcher (authors + subjects) — it's a **signal**. It cannot block a sufficiently-disguised commit, and it doesn't try to. Authority for refusing a commit rests with the deterministic layers (1, 2, 4) and human review. The signal exists to make the *common* failure mode loud, not to be the load-bearing protection.

The deterministic strip (Layer 1) is the load-bearing protection. The CI invariant (Layer 4) is the structural assertion. The signal (Layer 3) makes the failure visible early but is not the only line of defense.

## Interactions with existing systems

- **`pre-push-gate.js`** (NEXT.md / version check) runs first and remains unchanged.
- **Working-tree integrity check** (post-test step in `ci.yml`) catches *uncommitted* mutations; the new invariants job catches *committed* state. Complementary, not duplicate.
- **`lint-no-direct-destructive.js`** already requires `safe-git-allow:` on raw git use. Our new scripts carry it; the test files for those scripts carry it. No conflict.
- **`PostUpdateMigrator`** is not affected — none of these changes touch agent-installed files. The Migration Parity Standard does not apply.

## Rollback cost

All five layers are net-additive. Each can be reverted independently:

- Layer 1: revert five `delete` lines.
- Layer 2: revert the helper file and three fixture edits.
- Layer 3: comment out two lines in `.husky/pre-push` or delete the script.
- Layer 4: comment out the `invariants` job in `ci.yml`.
- Layer 5: re-create `file-0.txt` / `seed` — but they had no legitimate function, so no consumer breaks.

No data migration. No schema change. No agent-state mutation. Reverting any layer leaves the repo in a valid state and the test suite green.

## Risk summary

- **Low risk of regression.** Layer 1 is a single-line process.env mutation in test setup that affects nothing in production code. Layers 2–5 are net-additive guards.
- **Moderate risk of friction.** Layer 3 will be loud when triggered, including against legitimate edge cases (the documented bypass exists for this). Layer 4 will fail builds on cosmetic README slim-downs unless `INSTAR_README_MIN_LINES` is overridden.
- **No risk of data loss.** Nothing in this change mutates state outside the worktree.

## Verification done before commit

- All targeted test files pass locally (45 in worktree-monitor + SafeGitExecutor, 14 in new tests).
- `npm run lint` passes with the `safe-git-allow:` headers in place.
- `node scripts/check-repo-invariants.mjs` against the prepared worktree returns clean.
- `node scripts/pre-push-fixture-guard.mjs` against the prepared worktree returns clean.
- Spec carries `approved: true` per direct principal authorization in Telegram topic 11235.
