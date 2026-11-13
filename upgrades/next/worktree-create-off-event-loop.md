# Creating a topic's workspace no longer holds the server's event loop

<!-- bump: patch -->

## What Changed

`WorktreeManager.createBinding()` ran its heavy steps synchronously: `git worktree add` (30 s limit) or `git clone` (120 s limit) through `SafeGitExecutor.execSync`, then a `cp` of `node_modules` through `execFileSync` (60 s limit, 600 s on filesystems without copy-on-write). The server's event loop was held for the whole life of each child.

The three steps now run as children the server awaits without blocking: git through a new private `gitWriteOffLoop()` (built on `SafeGitExecutor.spawn`, so the same verb classification, source-tree guard, environment scrub and audit apply), and the copy through the promisified `execFile`. Git runs as the leader of its own process group (`SafeGitOptions.detached`, new); one that outlasts its limit is killed together with its helper processes and the creation fails at once with `git worktree add timed out after Nms`. `worktree add` now has 120 s (`HEAVY_GIT_TIMEOUT_MS`), since a slow one no longer blocks anything but the session waiting for its workspace.

Because creation now yields, `resolve()` keeps one in-flight creation per binding key (`creatingBindings`): a second session asking for the same new topic joins the first creation and then gets the ordinary `LOCK_HELD` answer, where it would otherwise have started a second `git worktree add` on the same path.

Not changed: what a killed creation leaves on disk. A partial directory is still adopted by the next request for that topic, as it was after the old 30 s timeout; with a 120 s limit that is reached less often.

## What to Tell Your User

Nothing changes that you will see. Opening a conversation that needs its own copy of a large project no longer makes the agent stop answering for up to a minute and a half while the copy is made.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Topic workspace creation runs off the server's event loop | Automatic |

## Evidence

Studio, 2026-11-13 14:09:18Z, `logs/server-freeze/freeze-20261113T140918Z.txt`: three failed health checks; the server at 0.0% CPU; a 5-second native sample has all 4,067 main-thread samples in `node::SyncProcessRunner::Spawn` under an HTTP request handler; the only young child is `git -C <agent home> worktree add -b topic/10000002656-… ` at 26 s. The supervisor log then has `Server process alive but unresponsive for 6 checks (~60s) — restarting`. The restart cancelled the Local Verify run in flight and the peer machine's run.

Tests: `tests/unit/WorktreeManager-create-off-event-loop.test.ts` (8, new), with a `git` on PATH that sleeps 700 ms before `worktree add` / `clone`: timers keep firing during creation on both the clone and the `worktree add` path (0 ticks before the change, verified by reverting the source); two simultaneous requests for one new topic run one git creation and the second gets `LOCK_HELD`; a failed creation is not remembered and the next request succeeds; at the time limit the call rejects at once and a helper process the fake git left running (holding the output pipe, as real git's checkout helper does) is dead; the error carries the command's words and git's message, no paths; a read-only verb is refused as before. The five existing WorktreeManager unit files (32 tests) pass unchanged.
