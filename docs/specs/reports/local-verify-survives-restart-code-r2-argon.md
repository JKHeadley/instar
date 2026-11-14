# code review round 2 — Gemini 4 Argon (gemini CLI), 2026-10-26

**Verdict:** ready with changes

### Ranked Findings

1. **`decideStart` ignores `resumeFirst` when no `main` verify is in the queue (`mainIdx < 0`)**
   - **Location:** `src/localVerify/LocalVerifyService.ts:336-343`
   - **Problem:** The spec (§C) states that when any ready PR entry has `resumeFirst` and `main` is not known red, it starts before a waiting `main` verify **and before other PRs**. In `decideStart`, `if (mainIdx < 0 || prIdx < 0) return { kind: 'start', index: mainIdx < 0 ? prIdx : mainIdx };` runs on line 338 *before* `resumeIdx` is checked on line 342. Whenever no `main` verify is queued (`mainIdx === -1`, e.g. after the boot `main` verify finishes, or when a release commit collapses), `decideStart` short-circuits and returns the first ready PR (`prIdx`) instead of a ready `resumeFirst` PR sitting behind another PR.
   - **Smallest fix:** Compute `resumeIdx` before the `mainIdx < 0` early return (or use `const effectivePrIdx = resumeIdx >= 0 ? resumeIdx : prIdx` when returning for `mainIdx < 0`).

2. **`RestartOrchestrator` can swallow a competing stop request or still detach during `quiesce` if the override arrives during `reporter.report()`**
   - **Location:** `src/lifeline/RestartOrchestrator.ts:116-176`
   - **Problem:** `this._state = 'quiescing'` is set before the up-to-500ms `await this.reporter.report(...)` (line 132). If a competing stop request (`keepServer: false`, such as `SIGTERM` / `external-signal`) arrives during that 500ms telemetry await:
     1. It sets `this.stopServerOverride = true` and returns `'suppressed'`.
     2. If `this.deps.isShadowInstallUpdating?.()` then returns `true` at line 152, the orchestrator resets `this._state = 'idle'` and returns `'suppressed'` — dropping the `SIGTERM` shutdown completely and leaving `this.stopServerOverride = true` stale for future requests.
     3. Even when `isShadowInstallUpdating` is false, Step 1 (line 176) calls `this.deps.quiesce({ ...req, keepServer })` with the original `keepServer: true` instead of `keepServer && !this.stopServerOverride`, detaching first and only stopping the server after `persistAll()`.
   - **Smallest fix:** Reset `this.stopServerOverride = false` whenever resetting `this.inFlight = null` (or do not defer on `isShadowInstallUpdating` when `this.stopServerOverride` is set), and pass `keepServer: keepServer && !this.stopServerOverride` into `this.deps.quiesce(...)` at line 176.

3. **Two test files listed in the spec are missing from `git diff origin/main` (untracked or uncommitted)**
   - **Location:** `docs/specs/local-verify-survives-restart.md:55-58`
   - **Problem:** The spec's `## Tests` section cites `tests/unit/lifeline/drift-restart-keeps-server.test.ts` and `tests/e2e/lifeline-keep-server-adoption.test.ts`, but neither file appears in `git diff origin/main`. If they exist as untracked files in the worktree, they have not been staged/tracked so they will be omitted from the commit/PR unless added.
   - **Smallest fix:** Ensure `tests/unit/lifeline/drift-restart-keeps-server.test.ts` and `tests/e2e/lifeline-keep-server-adoption.test.ts` are tracked in git (`git add`) so they are part of the branch diff.
