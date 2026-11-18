# The worktree cleaner stops freezing the server (plain-English overview)

## What this is

Instar has a cleaner that looks through the agent's old working copies of code (its "worktrees") to report which ones could be removed. On every agent today it only reports; it never deletes anything.

The problem is how it checks. For each copy it runs several git and system commands, and it waits for each one before doing anything else, on the same thread that answers every message and request. On the Mac Studio there are 258 copies. Measured from a sample, one full check takes about 45 seconds. During those 45 seconds the server answers nothing: replies stall, and buttons like "Accept all" hang. The check runs 15 minutes after every server start, and the Studio restarts often. It runs again once a day, and again every time someone opens the cleaner's status page.

## What changes

- **The check runs on a separate background thread,** the same fix used earlier this month for the hourly backup. The server keeps answering while it runs.
- **The cleaner's status page shows the last check's result and how old it is,** instead of redoing all the work on the server's main thread.
- **A stuck check can't jam the cleaner.** If the background check hasn't finished after 30 minutes, about 40 times longer than it should take, it is stopped and recorded as a failed check. Without this, a stuck check would silently stop every later check.
- **The background check uses the server's own login to GitHub,** so it judges merged work exactly as before.

## What does not change

- **The verdicts are the same,** because the same checking code runs.
- **Deleting still uses the old path.** On the day a cleaner is allowed to delete (no agent allows it today), deleting still goes through the old careful in-place path, so its last-moment safety re-check still works. Moving that off the main thread too is part of the larger worktree-cleanup design, which is still in review.
- **A failed check still reads "unknown", never "nothing to clean".**

## What needs deciding

Nothing. The Chief of Staff asked for this fix to go first and on its own.
