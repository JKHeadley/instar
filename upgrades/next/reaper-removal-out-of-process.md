<!-- bump: patch -->
## What Changed

The agent-home worktree reaper's removal moves off the server's main thread. When removal is live, a niced background child does both the evaluation and the removal, and the server only starts it and reads its results.

- **Supervision.** One child runs at a time. It holds a lock and writes durable rows. Its runner owns the process group, scans asynchronously, adopts the child after a restart, and kills it at the deadline.
- **Removal order.** Each checkout is re-evaluated, archived and re-checked, then renamed into `.worktrees/.trash`, then git's record is pruned, then the trash is deleted through a guarded subprocess. An interruption leaves the checkout either intact or only trash.
- **Closed PRs.** A closed-unmerged PR's checkout counts as finished only when its exact head commit is still on GitHub's PR ref.
- **Cadence.** The reaper checks hourly instead of daily. A run-once migration moves the exact old 24 h default.

Removal stays `dryRun: true`.

## What to Tell Your User

Nothing to do. Cleaning up the agent's old working copies can no longer freeze the agent. Real removal stays off until it is approved.

## Summary of New Capabilities

- Worktree removal runs in a background process, hourly. The report includes leftover trash, including `trash-stuck` folders.

## Evidence

- Unit: 70 tests in 5 new files pass.
- Integration: `tests/integration/agent-worktree-reclaim-live.test.ts` passes 4 of 4, using the compiled child and real git:
  - eligible checkouts are removed in order;
  - dirty and locked ones are kept, as is a sibling's registration;
  - the event loop never blocks over 1 s;
  - after a real SIGKILL following the `renamed` row, the next run cleans the trash and counts nothing twice.
- tsc and lints are clean. The second-pass review concurred.
