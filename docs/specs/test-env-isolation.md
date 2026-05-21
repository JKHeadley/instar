---
title: Test-environment isolation from inherited git env overrides
slug: test-env-isolation
status: ratified
approved: true
review-convergence: 2026-05-21T00:55:00Z
eli16-overview: test-env-isolation.eli16.md
ratification: principal-direct-2026-05-21
ratification-evidence: Telegram topic 11235 (instar docs) — Justin: "please proceed as you best see fit" (after the five-layer fix was proposed and accepted)
---

# Test-environment isolation from inherited git env overrides

## Problem

PRs #130 (May 5) and #277 (May 20) each landed test-fixture stowaway commits onto `main` — "Initial commit" and "seed" and "Worktree commit 1" authored by `Test <test@instar.local>` — that overwrote the project's `README.md` with a single-line `# Test` stub and dropped two stray files (`file-0.txt`, `seed`) at the repo root. The clobbered README shipped to npm in the v1.1.x series. PR #285 restored the README content; this spec closes the failure class.

### Root cause

When git invokes a hook (`.husky/pre-push` runs `npm run test:smoke`), it sets the following overrides on the child env:

- `GIT_DIR` — absolute path to the repo's `.git` dir
- `GIT_WORK_TREE` — absolute path to the working tree
- `GIT_INDEX_FILE` — absolute path to the staging index
- `GIT_OBJECT_DIRECTORY` — object store
- `GIT_COMMON_DIR` — shared common dir (worktree-aware)

Those variables override cwd-based repo resolution for every descendant `git` process. A test fixture that does `fs.writeFileSync('/tmp/.../README.md', '# Test Project')` followed by `execFileSync('git', ['commit', ...], { cwd: '/tmp/...' })` will stage and commit against the parent repo's index — on whichever branch happens to be checked out — because the inherited `GIT_DIR` / `GIT_INDEX_FILE` redirect everything regardless of `cwd`.

`tests/unit/scripts/check-rule3-coverage.test.ts` already documented this exact risk in a comment and stripped the vars locally. That fix never propagated to the global test bootstrap, so every fixture added since (`tests/unit/worktree-monitor.test.ts:initGitRepo`, `tests/unit/SafeGitExecutor.test.ts:initRepo`, `tests/integration/rich-profile-integration.test.ts:git-init-block`, and others) silently inherited the bug. Three of those fixtures' write patterns are visible in PR #130's final diff (`README.md`, `file-0.txt`, `seed`).

### Why nobody noticed

The polluted commits sit at the end of a branch as boring noise behind the legitimate work; reviewers see a "telegram markdown" / "worktree convention" title and skim past the tail of the commit list. The `README.md` only shows as `changed` if you click into its diff specifically, which nobody did on either PR.

## Design

Five layers. Layer 1 closes the root cause; layers 2–5 prevent the same class of failure from emerging through a different vector.

### Layer 1 — Strip `GIT_DIR` family in `tests/vitest-setup.ts`

Vitest setup files load before any test file. Delete `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR` from `process.env` here. After this change, no test in the suite inherits the dangerous env from pre-push, no matter how the test spawns git.

Single-line root-cause fix. Closes the class.

### Layer 2 — `tests/helpers/git-test-env.ts` + targeted fixture refactors

Vitest-setup only protects the `process.env` that fixtures inherit. A fixture that builds its own `env: { GIT_DIR: ..., ... }` object — for instance, by spreading `{ ...process.env }` BEFORE vitest-setup runs, or by reading an env file from disk — could reintroduce the leak.

`tests/helpers/git-test-env.ts` exports:

- `GIT_ENV_OVERRIDE_KEYS` — the canonical list, single source of truth
- `sanitizedGitEnv(base?: ProcessEnv): ProcessEnv` — returns a copy with all override keys deleted

Refactor `tests/unit/worktree-monitor.test.ts`, `tests/unit/SafeGitExecutor.test.ts`, and `tests/integration/rich-profile-integration.test.ts` — the three fixtures whose write patterns are visible in PR #130's diff — to pass `sanitizedGitEnv()` to every git-spawning call.

### Layer 3 — `scripts/pre-push-fixture-guard.mjs`

Runs in `.husky/pre-push` BEFORE the smoke tests, separately from the test-suite Layer 1 protection. Scans commits ahead of the upstream main and refuses the push if any of them carry the fixture signature:

- Author email in `{test@instar.local, t@t.com, t@e.com, test@test.com}`
- Subject matching `Initial commit` / `seed` / `init` / `Worktree commit N`

Bypass: `INSTAR_PRE_PUSH_FIXTURE_GUARD_SKIP=1` (for legitimate test-only branches).

This catches not only fresh leaks from new fixtures, but also accidental cherry-picks of historical pollution and any future env-leak from outside the test suite (a CLI tool, a job script, a CI step).

### Layer 4 — `scripts/check-repo-invariants.mjs` + new CI job

Runs as a dedicated `Repo Invariants` job in `.github/workflows/ci.yml`. Hard floor on the repo state:

- `README.md` exists and has at least 100 lines (override via `INSTAR_README_MIN_LINES`)
- `file-0.txt` and `seed` are not present at repo root (fixture stowaway signatures)

CI invariants are the last line of defense. If layers 1–3 are bypassed (via `--no-verify` or `INSTAR_PRE_PUSH_FIXTURE_GUARD_SKIP=1`), this still catches the clobber before it merges.

### Layer 5 — Cleanup + audit

`file-0.txt` and `seed` are removed from the repo root in this same change. They are signatures of the same class of pollution; leaving them on disk would falsely pass Layer 4 (which checks for newly-introduced presence) on the very PR that introduces Layer 4.

`git log` audit identified 32 commits on `main` authored by `test@instar.local` with subject `init` — these are historical fixture pollution that landed alongside legitimate PRs. They are not destructive (they add empty allow-list commits) and cannot be cleanly rewritten without a force-push to `main`, so they are left in place. Layer 3 prevents new ones; the existing ones are a documented historical artifact.

## Signal vs authority

- Layers 1–2 are **deterministic** local prevention: strip the variables before they can cause harm.
- Layer 3 is a **brittle pattern-based signal** at push time: authors + subject patterns. It's not authoritative — a malicious or pathological commit can forge identity and message. The pattern matching is calibrated to the historical pollution; broader detection would be the job of a code-review reviewer.
- Layer 4 is a **deterministic structural invariant**: the repo either holds the invariants or it doesn't.

The signal-vs-authority separation is respected: brittle pattern-matchers (Layer 3) can refuse a local push but cannot rewrite history; deterministic invariants (Layers 1, 2, 4) are the load-bearing protection.

## Testing

14 new tests across three files:

- `tests/unit/vitest-setup-git-env-strip.test.ts` — asserts `process.env` has the override keys absent at test time, and `sanitizedGitEnv()` correctly drops them from any base env.
- `tests/unit/scripts/pre-push-fixture-guard.test.ts` — six cases: clean push passes; fixture-author / "Initial commit" / "seed" / "Worktree commit N" each fail with the offending commit named in stderr; bypass env works.
- `tests/unit/scripts/check-repo-invariants.test.ts` — six cases: healthy repo passes; missing README / line floor / `file-0.txt` / `seed` each fail; `INSTAR_README_MIN_LINES` override works.

The refactored fixtures (`worktree-monitor.test.ts`, `SafeGitExecutor.test.ts`) still pass their pre-existing assertions.

## Rollback

All five layers are net-additive. Rollback paths:

- Layer 1: revert the five `delete` lines in `tests/vitest-setup.ts`.
- Layer 2: tests gracefully fall back to inherited env if the helper is removed; they would re-acquire the original bug.
- Layer 3: `INSTAR_PRE_PUSH_FIXTURE_GUARD_SKIP=1` or remove the script invocation from `.husky/pre-push`.
- Layer 4: `INSTAR_README_MIN_LINES=0` or remove the job from `ci.yml`.
- Layer 5: not rolling back the file deletions — they were stowaways with no legitimate referents.

## Non-goals

- **Rewriting `main` history** to remove the 32 historical "init" commits. They are not destructive; the force-push risk outweighs the cosmetic benefit.
- **A code-review reviewer that catches README clobbers in the diff.** Layer 4 is sufficient; a reviewer would be more expressive but adds an LLM dependency to a deterministic check.
- **An ESLint rule against raw `execFileSync('git', ...)`** in tests beyond the three confirmed fixtures. The existing `scripts/lint-no-direct-destructive.js` already covers this surface; layering an additional rule would duplicate enforcement.
