# Side-Effects Review — Worktree resolver accepts agent-home source checkouts

**Version / slug:** `worktree-resolve-agent-home`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `instar-codey second-pass checklist`

## Summary of the change

This change fixes `instar worktree create` for developer agents whose canonical Instar checkout is their own agent home or current working tree. `src/core/InstarWorktreeManager.ts` now considers the current working directory and `INSTAR_AGENT_HOME` as repo candidates before the hardcoded fallback paths, resolves subdirectory candidates to the git top-level, and still validates the remote URL allowlist and hooks path. `src/core/SafeGitExecutor.ts` gains a narrow `sourceTreeWorktreeManagerOk` escape so the worktree manager can perform only the source-tree git shapes it legitimately needs: read-only resolver checks, `git worktree add/prune`, and per-worktree identity config writes. Tests cover cwd and agent-home discovery, source-tree-shaped fixtures, and the closed SafeGitExecutor escape.

## Decision-point inventory

- `resolveInstarRepo` — modify — chooses which validated Instar checkout the worktree manager operates against.
- `SafeGitExecutor.sourceTreeWorktreeManagerOk` — add — allows a closed set of worktree-manager git shapes against a source tree while keeping SourceTreeGuard default-deny for every other mutation.
- `createWorktree` git helper — modify — opts the manager's git calls into the narrow source-tree worktree-manager allowance.

---

## 1. Over-block

The resolver still rejects legitimate Instar forks whose `remote.origin.url` is not in the default or configured worktree repo allowlist. That is intentional and unchanged; operators can extend `worktree.repoUrlAllowlist` for trusted forks.

The new SafeGitExecutor escape can still block future worktree-manager operations if the manager adds a new git shape not listed here. That is preferable to silently widening source-tree mutation authority; future shapes should be added deliberately with tests.

## 2. Under-block

The resolver now falls back from an invalid `INSTAR_REPO` to cwd, agent home, and configured fallback paths. That matches the previous fallback style but means a bad env var does not force failure if another legitimate repo candidate is available. Integrity validation still applies to the repo ultimately selected.

The worktree-manager escape allows `git worktree add/prune` against a validated source checkout. A bug in branch/slug/path validation could still cause a bad worktree target, but the manager's existing slug validation and `.worktrees` containment checks run before the add call.

## 3. Level-of-abstraction fit

Repo discovery belongs in `InstarWorktreeManager`, because that manager already owns agent-home resolution, repo validation, worktree path containment, and audit ledger writes. The SourceTreeGuard bypass belongs in `SafeGitExecutor`, not as a raw subprocess bypass, because the executor remains the single funnel and can enforce the exact allowed shapes.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] Not applicable to conversational/product judgment — this is a structural filesystem/git safety guard.

This is a brittle blocker, but it falls under the documented SourceTreeGuard carve-out for safety guards on irreversible actions. The change narrows an explicit exception rather than weakening the guard generally.

## 5. Interactions

- **Shadowing:** `sourceTreeWorktreeManagerOk` is checked inside SafeGitExecutor at the same point as `sourceTreeReadOk`; it does not bypass verb classification or env sanitization.
- **Double-fire:** SourceTreeGuard still fires for all non-enumerated source-tree mutations. The new option only prevents false blocking for the worktree manager's enumerated shapes.
- **Races:** Candidate repo resolution reads git metadata from cwd/agent home/fallback paths. Concurrent remote config changes could affect which candidate passes, but every candidate is validated at call time.
- **Feedback loops:** Worktree creation still writes the existing audit ledgers after success. No new persistent state is introduced.

## 6. External surfaces

This affects Instar developers and agents invoking the `instar worktree create` helper. It should turn a false failure into successful worktree creation when the agent home/current checkout is a valid Instar repo. It does not change Telegram, dashboard behavior, runtime server APIs, or CI behavior.

## 7. Rollback cost

Rollback is a pure code revert of `src/core/InstarWorktreeManager.ts`, `src/core/SafeGitExecutor.ts`, the tests, and this artifact. No data migration or agent state repair is required. Existing worktrees created while the fix is live remain ordinary git worktrees and can be removed with existing tooling if needed.

## Conclusion

The diagnosis found that the resolver missed valid cwd/agent-home source checkouts and the guard path needed a narrow worktree-manager exception once those checkouts became candidates. The implemented fix preserves the remote allowlist, hooks-path validation, SourceTreeGuard default-deny behavior, and path containment. Focused unit and integration tests pass.

---

## Second-pass review (if required)

**Reviewer:** instar-codey second-pass checklist
**Independent read of the artifact:** concur

The second pass agrees that this is the narrowest practical fix: no raw git bypass, no general SourceTreeGuard weakening, and tests prove unrelated source-tree mutations still throw.

---

## Evidence pointers

- `tests/unit/InstarWorktreeManager.test.ts`
- `tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts`
- `tests/integration/instar-worktree-create.test.ts`
