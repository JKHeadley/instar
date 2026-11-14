# Side-Effects Review — the rebalance proof waits for a settled session

**Version / slug:** `rebalance-proof-settled-idle`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** codex-cli gpt-6-astra, five rounds, concurred on the last. Round 1: four findings on the proof wait, three fixed, one stated as a limit. Round 2: rejected the first rule as hiding real work, replaced. Rounds 3 and 4: an environment assignment and a newline passing the launcher shape, both fixed. Round 5: concur, on the stated assumption that callers pass one ps line at a time.

## Summary of the change

On Linux, `npm exec` starts the Playwright MCP through `sh -c playwright-mcp`. `isToolShellCommand` matches that, and a tool shell outranked the baseline list, so `computeHasActiveProcesses` and `drainProcessShape` reported every such session as working forever. Measured on Mama PC by running the shipped function on a session sitting at its prompt: `hasActive true`, with that shell the only cause. Exactly that launcher is now recognised: a plain one-command `sh -c` naming an mcp binary, whose direct parent is `npm exec` or `npx` of an MCP package.

The rebalance proof also needs six idle reads in a row of one session before a move, bounded by a deadline, and `sourceSessionGone` in its evidence is now a real read on every path.

## Decision-point inventory

- Work-state process leg — modify — the exact launcher shell is not work. Same change in the stand-down drain shape. Proof precondition — modify — idle must hold across reads. Evidence field — modify. No verdict rule changes.

---

## 1. Over-block

The proof: a session that keeps going active for the whole 120-second window yields `no-idle-session`, which records nothing and can be rerun. Each proof takes about 25 seconds longer. The work-state change only removes a false busy reading.

## 2. Under-block

This is the side to watch, because false idle can close or move a working session. Review rejected the first form, any shell below an MCP root: `claude --mcp-config` matched as a root and hid the agent's shells, and a command-running MCP's shells are real work. So the rule needs the exact shape and the runner as direct parent. Anything with an operator, a second program or another parent stays work, and both rejected cases are tests. Six reads cover about 25 seconds, so a brief delivered later can still abort a move: a named red, never a false green.

## 3. Level-of-abstraction fit

The rule sits in `baselineProcessPatterns.ts`, the one source, as `isMcpLauncherShell`. Nothing else about the two checks changes, so a browser under the MCP stays as each already had it. `computeHasLiveToolShell` matches Claude snapshot shells only and is unaffected.

## 4. Signal vs authority compliance

No new authority. The drain still decides quiet for itself and can still abort.

## 5. Interactions

The real effect is on Linux: idle sessions there were never closed by the idle reaper, and now are, on the same timers as macOS, and moves and stand-down stop waiting on them. A session bound to a topic has the long topic threshold, and returning to one starts it again. macOS trees have no such shell and do not change. `hasLocalSession` is now also read after a failed move, and a throw there leaves the move's failure as the reason.

## 6. External surfaces

None. No route, config or message changes.

## 7. Multi-machine posture

Machine-local reads. It fixes a difference between machines: a Linux peer now reports work state the way a Mac does. Rows and stage rules are unchanged.

## 8. Rollback cost

Revert the commit. No state depends on it; Linux idle sessions go back to staying open.
