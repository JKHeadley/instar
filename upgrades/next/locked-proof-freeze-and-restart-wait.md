<!-- internal-only -->
## What Changed
Three more faults in the locked-screen proof driver (`scripts/locked-proof/`), found in the live run on the Mac Mini on 2026-11-05 after the viewer-wait fix let it start. Proof tooling only; no runtime code changes.

1. Cases 12.1 and 12.6 freeze the server with SIGSTOP, but the server ran as a tmux pane process and tmux resumes a stopped pane process at once, so the server never froze and the case judged a running server. Both cases now serve the agent under launchd first and put it back in tmux afterwards, and `stop-server` throws unless `ps` shows the process stopped.
2. After `start-server` or `serve-under-launchd` the driver went straight on while the new server still read the lock state as "unknown", so the final sample read "unknown" and the next case's viewer had no machine to open. Both now wait up to 120 seconds for a known lock state.
3. `readLockState` returned agent A's "unknown" without asking agent B. An agent that does not know yet is now skipped like one that is down.

## Evidence
Live on the Mac Mini, 2026-11-05. (1) Case 12.1 failed with "marker ended owed, expected relocked; Mac ended unlocked"; during a rerun `ps` showed the server in state `Ss+` and its lease file was renewed every 10 seconds, and a control (`tmux new-session 'sleep 120'`, then `kill -STOP`) read `Ss+` 0.3 s later while the same signal outside tmux read `T`. With the server under launchd the stop read `T`, the guard moved the duty from owed to watching 39 s later and to relocked, and 12.1 passed. (2) and (3) Cases 12.2a and 12.2c failed with "Mac ended unknown, expected locked" although the guard had relocked, and 12.2b and 12.2d failed at the viewer wait right after a restart; in the rerun with these fixes 12.2a, 12.2b, 12.2c and 12.2d passed. Unit tests in `tests/unit/locked-proof-driver.test.ts` cover each fix; 54 of 54 pass.
