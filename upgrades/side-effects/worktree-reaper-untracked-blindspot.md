# Side-effects review — worktree-reaper-untracked-blindspot

Change: the AgentWorktreeReaper's `isClean` now treats reaper-residue-only worktrees (build artifacts + instar markers, esp. `.metadata_never_index`) as clean via the PURE `classifyPorcelain` + a NARROW `REAPER_RESIDUE_DENYLIST`, fail-CLOSED on git error; plus a per-path reclaim-failure breaker. Files: `src/monitoring/agentWorktreeGit.ts`, `src/monitoring/AgentWorktreeReaper.ts`, `tests/unit/agent-worktree-reaper.test.ts`.

1. **Over-block (reject legit inputs it shouldn't):** N/A in the gating sense — this LOOSENS an over-conservative KEEP gate. The "over-block" analog (keeping a reclaimable worktree) is the bug being fixed. No new over-block.

2. **Under-block (still misses failure modes):** A worktree whose ONLY change is a *non-residue* untracked file (a hand-authored `.ts`/`.md`/`.log`/`build/*` never `git add`ed) is still KEPT — by design (conservative; possibly-precious). The narrow denylist deliberately excludes `out/`/`build/`/`coverage/`/`*.log` so user-authored files there are never silently reaped. Multi-commit squash-merges are still reported unmerged → KEPT (pre-existing `git cherry` conservatism).

3. **Level-of-abstraction fit:** Correct layer. `isClean` is the reaper's per-worktree cleanliness signal; residue-awareness belongs exactly there. Reuses the existing tested PURE `classifyPorcelain` rather than a parallel re-implementation.

4. **Signal vs authority:** This is a deterministic policy evaluator over an objective git fact (porcelain + denylist), feeding a gate that is ANDed with `isMerged` (git cherry patch-id) + `isInUse`. No brittle string-matcher gains block authority; it REFINES a KEEP gate. Fail direction is the safety crux: **fail-CLOSED** (git error → dirty → KEEP), the opposite of the fail-open `makeWorktreeDirtyCheck` wrapper which would be unsafe for a deletion gate (the convergence BLOCKER).

5. **Interactions / shared consumers:** `isClean` (from `makeAgentWorktreeReaperDeps`) is shared by THREE consumers — the reaper (delete), and via `orphanedWorkGit.ts` the `OrphanedWorkSentinel` (preserve work) and any other caller. Widening "clean" to ignore the narrow never-work set is correct for all three (none should treat a marker-only worktree as holding work). `DEFAULT_RESIDUE_DENYLIST` is NOT modified, so the build-session-yield-safety killer's config-sourced list and other consumers are untouched. Tested: marker-only → clean; tracked diff → never hidden.

6. **External surfaces:** No new routes/messages. `GET /worktrees/agent-reaper` now reports more `reap-eligible` worktrees (and a new `reclaim-failed` keep reason when the breaker trips). A new `reclaim-breaker` event is emitted (consumed for observability only).

7. **Multi-machine posture:** Machine-local BY DESIGN. Worktrees live on one disk; the reaper only ever evaluates its own machine's `.worktrees/`. No replication/proxy/URL surface. (Cross-Machine Coherence: machine-local with reason.)

8. **Rollback cost:** Low. `agentWorktreeReaper.enabled: false` fully disables (existing knob); `dryRun: true` classifies without deleting (review the report first); `maxReclaimFailuresPerPath: 0` disables the breaker. The denylist is a code const (revert = one-line). No data migration. A reclaimed worktree's branch + commits remain in git (only the redundant checkout is removed), so even a wrong reap loses no committed work — and non-residue/tracked work is never reaped.

## Second-pass review (required — touches a destructive safety gate)
Convergence ran an adversarial + lessons-aware reviewer (see `docs/specs/reports/worktree-reaper-untracked-blindspot-convergence.md`). They caught a deletion-safety BLOCKER (fail-open→fail-closed), the broad-denylist hazard (→ narrow list), and the undisclosed OrphanedWorkSentinel consumer. ALL addressed in the implementation and pinned by unit tests (residue→clean, non-residue→dirty, broad-entry→dirty, git-error→KEEP, breaker trip+clear; 31 tests green). Concur with the resolved design.
