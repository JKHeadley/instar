# Heal-path resilience to stale process.execPath — ELI16

## The problem in one paragraph

Your instar agent keeps a running Node.js process going for hours or days. When Homebrew updates Node in the background, it swaps out the Node binary on disk. The running process keeps working — it already had the binary loaded into memory — but any new attempt to launch a child Node fails because the file at the original path is gone. The agent's auto-repair routine (which runs whenever the agent's SQLite database needs a rebuild) tries to launch a child Node to do the work. The launch fails. The repair never runs. The agent's knowledge graph and conversation summaries go offline and stay offline across restarts, because every restart tries the same broken path.

## What changes with this fix

Before launching a child Node, the agent now checks: does the recorded Node path still exist? If yes, use it (this is the normal case — almost always). If no, try a list of stable fallback paths: the symbolic-link Homebrew always maintains, the standard install locations, and finally whatever `node` resolves to on the user's PATH. Use the first one that works.

If absolutely no Node can be found on the system, the agent doesn't pretend the rebuild succeeded. It instead emits a clear "Node is missing — reinstall it, then restart the agent" notification. That notification appears alongside the agent's other health degradations so the operator can see and act on it.

## Why this is small but important

Small: the change is a 150-line helper function plus four call-site updates. The behaviour is identical in the normal case — only when the original Node path is missing does the new code do anything different.

Important: the failure mode hit Luna (Justin's main work agent) and took her memory stack offline for hours. The same failure would have hit any agent on a machine where Homebrew updates Node, which is most macOS dev machines. Without this fix, the only recovery was someone manually running the repair script, then restarting the server. With this fix, the agent self-repairs on the next restart that detects the mismatch.

## What you'll notice

If your agent has ever logged "rebuild failed (spawnSync ... ENOENT)" — most often visible as the knowledge graph or conversation summaries going offline while the agent still appears to be running — that won't happen anymore. The next restart will heal cleanly.

If you're on a machine without Node installed at all (extremely unusual for an instar agent), you'll see a clearer notification telling you so, instead of a silent degradation.

Nothing changes if your agent is healthy and your Node binary is where it was installed.
