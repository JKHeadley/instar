# Side-Effects Review — WorktreeMonitor async git scans

**Version / slug:** `worktree-monitor-async-git`
**Date:** `2026-06-23`
**Author:** Echo (autonomous)
**Tier:** 1 (behavior-preserving async refactor — no new feature, no decision points, no dark-gate, no migration)
**Second-pass reviewer:** not-required (Tier 1; small, low-risk, fully covered by existing unit tests)

## Summary of the change

`WorktreeMonitor.scanWorktrees()` issues several git commands — `git worktree list --porcelain` plus per-worktree `rev-list`/`diff` — through a private `gitCommand()` that used **`spawnSync('/bin/sh', ['-c', 'git …'])`**. On a repository with many worktrees (Echo accumulated ~282) `git worktree list` alone takes seconds, and the scan ran on BOTH a 5-minute periodic timer AND on every `sessionComplete` event. Each scan therefore blocked the **server event loop** synchronously for seconds.

That freeze was invisible on `localhost` (the dashboard websocket reconnects instantly), but over the Cloudflare tunnel (`echo.dawn-tunnel.dev`) a 1–2s freeze times out in-flight requests, dropping the dashboard websocket and failing its polls → the user-visible "Disconnected / 0 sessions / Mem 0%". This is the residual event-loop-block cause behind the dashboard "disconnected" reports, after the sync-READ fixes in #1247–#1251.

## The change

Convert `gitCommand` from `spawnSync` to async `execFile` (promisified), and propagate `await` through the scan call graph so the event loop stays responsive while git runs in the background.

Files modified:
- `src/monitoring/WorktreeMonitor.ts` — `gitCommand` → `async` (execFile, stdout-on-nonzero-exit/timeout semantics preserved to exactly match the old `spawnSync result.stdout ?? ''`); `listWorktrees`, `checkUnmergedWork`, `findOrphanBranches`, `getDefaultBranch`, `getWorktreeAge`, `scanWorktrees` → `async`; `periodicScan` resolves worktree ages with `Promise.all` before filtering; `formatPeriodicAlert` → `async`.
- `src/server/routes.ts` — `GET /hooks/worktrees` handler → `async`, awaits `scanWorktrees()`.
- `tests/unit/worktree-monitor.test.ts` — the 13 tests that called the now-async methods updated to `await` them.

## Side effects & risk

- **Behavior preserved.** The scans still run on the same triggers and the same 5-minute interval; only the blocking changed to non-blocking. `gitCommand`'s return contract (stdout even on a non-zero exit / timeout) is kept identically, so callers see the same strings.
- **No external surface change.** `GET /hooks/worktrees` returns the same JSON; the periodic + post-session alert paths are unchanged.
- **Concurrency.** Scans are serialized per the existing event flow (no new parallelism introduced beyond `Promise.all` over `getWorktreeAge`, which is read-only `git show` per worktree).
- **Risk:** low. A behavior-preserving async conversion, fully covered by the existing 22 unit tests (updated to await) + the serendipity-routes integration tests, both green.

## Verification

- `tsc --noEmit`: 0 errors.
- `tests/unit/worktree-monitor.test.ts`: 22/22 pass.
- `tests/integration/serendipity-routes.test.ts`: 22/22 pass.

## Rollout

No flag, no migration — the fix is strictly better behavior on the existing code path and ships on the next release. (A shadow-dist hotpatch — disabling both scan triggers — relieved the freeze immediately on the affected agent; this PR is the durable replacement that keeps the feature working without blocking.)
