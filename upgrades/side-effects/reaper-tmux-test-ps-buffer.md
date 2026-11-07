# Side-effects review: reaper tmux test reads the full process list safely

**Tier:** 1 (test-only, one file, about 4 lines). Effort: no spec review rounds; 1 commit attempt.

## Summary
`tests/integration/reaper-live-tool-shell-real-tmux.test.ts` reads `ps -eo pid,ppid,command` through `spawnSync` with node's default 1 MiB output limit. On a busy host the list is bigger than that (the Studio's is about 709 KB when idle, and more during a full verify). The read then fails with ENOBUFS: status null and empty stderr. The helper reported this as `ps failed: ` with nothing after it, and three tests failed (on main at 23:07Z and on the #2825 verify). The fix allows 64 MiB and puts `ps.error` in the message. No production code changes.

Reproduced: `spawnSync('ps', ['-eo','pid,ppid,command'], {maxBuffer: 200*1024})` returns `{status:null, stderr:'', error:ENOBUFS}`, which is exactly the shape that was failing.

## 1. Over-block
None. Only the test's own helper changes; it accepts more output.
## 2. Under-block
The production probes in `src/core/SessionManager.ts` (`hasLiveToolShell`, `hasActiveProcesses`, the shared ps snapshot, the drain probe) use the same 1 MiB default. When over the limit they fail safe ("keep", or "unknown"), so on a very busy host the reaper cannot see idle sessions. That is a production defect outside this test repair and goes to the feedback queue. `tmux-resilience-slow-stub` failed in the same run; it does not read the process list. Its failures were wall-clock limits on a CPU-saturated host, and this PR does not change it.
## 3. Level-of-abstraction fit
Right layer: the defect is in the test's own helper.
## 4. Signal vs authority
No decision point. Test code only.
## 5. Interactions
None. The helper's error message gains the spawn error text.
## 6. External surfaces
None. Tests do not ship to agents.
## 7. Multi-machine posture
Not applicable. Test-only, nothing runs on agents.
## 8. Rollback cost
A revert of one test file.
