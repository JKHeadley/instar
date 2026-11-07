# ELI16: Three things that froze the server at boot and during updates

The agent's server does everything on one main thread, called the event loop. If something on that thread waits, everything waits: health checks, Telegram messages, and requests from the agent's other machines. A supervisor process watches this, and when the server misses six health checks in a row it restarts it, which makes things worse.

On a busy Mac Studio on 2026-11-06, a boot took up to 5 minutes 40 seconds, and each update froze the server for almost a minute. Measuring found three specific causes.

First, when local verify starts up it works out which pull requests in its history are still open. It asked GitHub about them one at a time, 275 in all, at about 0.38 seconds each, and the server did not start listening until that finished. GitHub can answer the same question in one call, in 0.40 seconds. Now it makes the one call. A pull request missing from a complete list of open ones is not open. If the list fails, or comes back full and might be cut short, it falls back to the old one-at-a-time way, so a failure costs time and never gives a wrong answer.

Second, the project map notes the branch and remote of every nearby worktree. It ran git twice per worktree, on the main thread, and there are about 510 worktrees. Those answers already sit in small text files in each checkout, so now it reads the files. The map says the same thing, without starting a single process per worktree.

Third, when an update installs, it clears some macOS file attributes across the new install, then checks that the install really starts. Both ran on the main thread. Clearing took 39.8 seconds and the checks about 13 more. They now run in the background, with the same checks and the same refusals: a broken install still never gets used.

What this does not fix: the steady stream of short tmux and ps calls on the main thread during normal running. Those are a separate, larger job, filed as its own item with the measurements. They may have contributed to the unplanned restart at 14:17 that day, whose exact cause was not caught, so restarts under heavy load may still happen.

Nothing here adds a new decision or gate, and undoing it is a plain revert with no data to repair.

The update tests also changed: they now fake only the package install, so the real checks of a new install still run in them.
