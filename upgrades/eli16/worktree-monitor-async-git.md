# ELI16 — Make the worktree scan stop freezing the server

## The problem in plain words

Instar's server runs everything on a single thread — one line at a time, like a single cashier serving a queue. If any one task takes a long time, *everything else waits*: the dashboard's live connection, the message handlers, all of it.

One of the background helpers, the **WorktreeMonitor**, periodically looks at all the git "worktrees" (separate working copies of the code) to spot abandoned work. To do that it shells out to `git worktree list` and a few other git commands. The way it called git was **synchronous** — meaning the single thread sat there and *waited* for git to finish before doing anything else.

That's fine when there are a handful of worktrees. But on a machine where worktrees pile up (one agent had ~282 of them!), `git worktree list` takes a few *seconds*. And this scan ran on a 5-minute timer **and** every time a background job finished. So every few minutes the whole server froze for a second or two.

## Why it showed up as "dashboard disconnected"

On the local address you'd never notice — the dashboard's live connection just reconnects instantly. But when you reach the dashboard through the internet tunnel, a one- or two-second server freeze is enough to **drop the live connection and time out the data**. The result is the dashboard showing "Disconnected, 0 sessions, 0% memory" — even though the server is actually fine, it was just frozen for a moment.

## The fix

Make the git calls **asynchronous**. Instead of the single thread sitting and waiting for git, it kicks off the git command and goes back to serving everyone else; when git finishes, it picks the result back up. Same scans, same schedule, same results — but the server stays responsive the whole time, so the dashboard's live connection never drops.

## What changed and what didn't

- Changed: the worktree scan's git calls no longer block the server thread.
- Unchanged: it still scans on the same 5-minute timer and after each job, still reports the same things, and the `/hooks/worktrees` endpoint returns the exact same data. The git calls keep their old behavior of returning whatever output they produced even if git exits with an error.

It's a small, low-risk change covered by the existing tests (all green), and it's the permanent replacement for a quick hotpatch that had temporarily disabled the scans to stop the freezing.
