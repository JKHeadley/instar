# Cross-Model Review: PROJECT-SCOPE-SPEC.md (Iteration 2)

**Model**: Gemini (gemini-3.1-pro-preview)
**Reviewed**: 2026-05-11 10:03:57
**Document**: `/private/tmp/instar-project-scope-spec/docs/specs/PROJECT-SCOPE-SPEC.md`
**Iteration**: 2 (post-iteration-1 rewrite, ~70 prior findings addressed)

---

## Headline

- **Score**: 9/10
- **Verdict**: CONDITIONAL
- **Material new issues**: 3 critical (lock-in-git-sync, squash-merge SHA, static stop condition) + 2 gaps (stale PID lock, delete-resurrection)

---

## Raw Response

### 1. Overall Assessment
- **Score**: 9/10
- **Status**: CONDITIONAL
- **Summary**: This is an exceptionally strong, production-ready specification. The rewrite successfully integrated all feedback from Iteration 1. The load-bearing principles (P1-P5) are rigorously applied, the "out-of-scope trap" mitigation is brilliant (registering deferred items as child initiatives in the same PR), and the separation of signal (drift check) from authority (artifact validation) is flawless. There are **three material new issues** (two technical bugs and one race condition) that must be patched before implementation, but they are localized and easily fixed.

### 2. Critical Issues (Must Fix)

**1. The `round-runner.lock` will trigger Git-sync conflicts and cross-machine lockups**
- **What**: Phase 1.5 places the lock file at `.instar/round-runner.lock`. P5 states that `.instar/` is shared across machines via `git-sync`.
- **Why it matters**: If the lock file is synced via Git, Machine A acquiring the lock will sync it to Machine B. Machine B will think it is locked by a local process (or crash trying to read a missing PID). Furthermore, rapid lock/unlock cycles will cause constant Git merge conflicts on the lock file.
- **Suggested fix**: Explicitly state that `.instar/round-runner.lock` must be added to `.gitignore`, or move it to a machine-local directory (e.g., `/tmp/instar-round-runner.lock` or `.instar-local/`).
- **Section reference**: Phase 1.5 (Pre-flight / Acquire lock) & Phase 1.12.

**2. Artifact verification fails on Squash/Rebase merges**
- **What**: Phase 1.2 requires `mergedSha` to be reachable from `origin/main` via `git merge-base --is-ancestor`.
- **Why it matters**: If a PR is merged via GitHub/GitLab's "Squash and Merge" or "Rebase and Merge" features, the PR's head SHA is *never* an ancestor of `main` — a new commit hash is generated. The artifact validator will reject valid merged PRs, permanently stalling the pipeline.
- **Suggested fix**: Update the validator to either use the forge API (e.g., `gh pr view <prNumber> --json state,mergeCommit` to verify it is `MERGED` and get the actual squash SHA) OR explicitly state that the project requires true merge commits. The API approach is vastly preferred.
- **Section reference**: Phase 1.2 (building → merged transition).

**3. Mid-round manual transitions (e.g., Skip) will hang the static stop condition**
- **What**: Phase 1.5 computes the stop condition ("all `prNumber` values for round itemIds present...") and passes it to the `/autonomous` process.
- **Why it matters**: If a user realizes an item is blocked mid-round and manually runs `/project advance <id> skipped`, the child item updates in the DB. However, the `/autonomous` process is already running with a statically computed stop condition that still expects that skipped item to merge. The autonomous process will hang or fail.
- **Suggested fix**: The `/autonomous` stop condition should not be a static string. It should be a dynamic check: "All items in `projectId.rounds[i]` have `pipelineStage` of `merged` OR `skipped`." Alternatively, `POST /projects/:id/advance` must send an interrupt/re-eval signal to the active round-runner.
- **Section reference**: Phase 1.5 (Compute stop condition).

### 3. Strengths
- **The "Out of Scope" Trap Mitigation**: Requiring deferred Phase 2 items to be tracked as child initiatives *in the same PR* is a masterclass in preventing technical debt and forgotten scope.
- **Signal vs. Authority Separation (P1)**: Explicitly defining the LLM drift check as a *signal* and bounding the actual start gate to deterministic *artifacts* completely neutralizes prompt injection risks on state transitions.
- **Optimistic Concurrency Control (P4)**: Using `If-Match` with a `version` integer is exactly the right pattern for JSON-backed shared state, preventing the UI/agent from clobbering each other.
- **Tone-Gated Telegram Messages**: Forcing the `formatRoundCompleteMessage` to include a `rootCauseHypothesis` and `concreteNextStep` (and failing the send if missing) guarantees high-quality, actionable alerts instead of vague AI apologies.

### 4. Gaps & Missing Elements
- **Lock File Orphan Recovery**: Phase 1.13 says the lock file is removed on server start. However, if the round-runner crashes *without* the server restarting (e.g., an unhandled exception in the runner process), the lock remains forever. *Gap:* The lock acquisition logic should verify if the PID inside the lockfile is actually still running (`kill -0 <pid>`), and steal the lock if the process is dead.
- **Git-Sync Edge Case on Deletion**: Phase 1.3 says `DELETE /projects/:id` archives the project. If Machine A deletes, and Machine B modifies it while offline, the Git-sync might resurrect the deleted file. *Gap:* Specify if deletion means moving to an `.instar/archive/` folder or setting a `deletedAt` flag, which syncs more reliably than file deletion.

### 5. Industry Comparison
- **Against Jira/Linear Automations**: This spec is significantly more robust than typical issue tracker automations because it enforces *artifact-bound* transitions. Jira will let you drag a ticket to "Done" without a PR; this system rejects the HTTP request with a 409. This is a best-in-class approach for machine-driven workflows.
- **Against CI/CD Pipelines**: It successfully bridges the gap between project management and CI/CD by treating the *spec convergence* and *user approval* as discrete pipeline stages, rather than just tracking code states.

### 6. Scalability Assessment
- **Phase 1 (MVP, 1-5 agents/machines)**: Flawless (once the lock file is removed from Git sync). The JSON file backend with OCC handles this perfectly.
- **Phase 2 (Growth, 10-50 projects)**: The `ProjectIntegrityReconciler` running every 6 hours and on lazy GETs will start to hit GitHub API rate limits if it checks hundreds of SHAs. It will need batching or webhook-driven updates instead of polling.
- **Phase 3 (Scale, Multi-tenant)**: The `.instar/initiatives.json` file will become a bottleneck for Git-sync. It will need to be split into one JSON file per project (e.g., `.instar/projects/<id>.json`) to avoid constant merge conflicts on a single monolithic ledger.

### 7. Recommendations (Prioritized)

1. **Fix Lock Syncing**: Update Phase 1.5 to store `.instar/round-runner.lock` in a `.gitignore` path to prevent Git-sync conflicts.
2. **Fix Merge Validation**: Update Phase 1.2 to use the Forge API (e.g., `gh pr view`) to validate PR merge state, rather than relying strictly on `git merge-base`, to support squash/rebase merges.
3. **Dynamic Stop Conditions**: Update Phase 1.5 so the round runner's stop condition dynamically evaluates the current database state of the round's items (accounting for mid-round `skipped` or `regressed` transitions).
4. **Resilient Lock Acquisition**: Update the lock logic to check `kill -0 <pid>` of the lock owner, allowing it to clear stale locks if the runner process crashed without taking down the whole server.
5. **Soft Deletes**: In Phase 1.3, implement `DELETE` as a soft-delete (`status: archived` or moving the file) rather than an `rm` to prevent Git-sync resurrection bugs.

---

## Brief Analysis

**Convergence status**: NOT converged. Gemini surfaced three material NEW issues that iteration 1 did not catch — all three are concrete, named, and have specific fixes. The spec sits at 9/10 with verdict CONDITIONAL.

**Three load-bearing new findings**:

1. **Lock file in git-synced directory** — high-impact distributed-systems bug. The `.instar/round-runner.lock` proposal collides head-on with the P5 multi-machine sync model. Two machines will sync each other's locks. This is a true contradiction in the spec, not just a gap.

2. **Squash/rebase merge SHA mismatch** — production-blocking bug. Justin's actual instar workflow uses squash merges (verifiable from recent commit history showing fast-forward-style hashes). Phase 1.2's `git merge-base --is-ancestor` check on the PR head SHA will fail for every squash-merged PR, permanently stalling every round. This is critical because it would make the entire system non-functional in the most common merge mode.

3. **Static vs. dynamic stop condition** — race condition. The autonomous skill receives a frozen stop condition at round start, but Phase 1.7 explicitly exposes `/project advance ... skipped` as a mid-round user action. The mismatch means a user-intended unblock becomes a runner hang.

**Two notable gaps** (not as severe but real):
- Stale-PID lock recovery on runner-only crash (server stays up → lock never cleared).
- Soft-delete vs. file-delete under git-sync resurrection.

**Convergence verdict**: This round produced material new signal. A third iteration is warranted to address at minimum the three critical items. The two gaps are also worth folding in. The squash-merge issue is the most consequential — without it, the system cannot reach `merged` in Justin's actual workflow.

**Cross-reference note**: GPT/Grok reviews should be checked for overlap on these three findings. If all three external reviewers independently flagged the squash-merge issue, it is a hard-block for iteration 2.
