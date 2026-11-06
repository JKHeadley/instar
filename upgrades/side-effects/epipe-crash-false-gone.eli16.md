# Stop restarting healthy servers — Plain-English Overview

> The one-line version: the watcher that keeps each agent's server running mistook "I could not check" for "the server is dead", and restarted servers that were fine; this stops that, and stops a closed pipe from crashing a server.

## The problem in one breath

Every agent has a small watcher process that restarts its server if the server dies. To check, it asks tmux whether the server's session exists. The watcher treated every failed check as "the session is gone". On 2026-11-06 it restarted servers whose logs show they were working. During those restarts the server's error output pipe closed underneath it, and the server crashed on `write EPIPE`, which is the error the logs showed.

## What already exists

- **The watcher's health checks** — they also call the server directly, and restart it after about a minute of no response. These keep working.
- **The crash policy** — a short list of errors the server logs and survives. Anything else closes the databases and exits.

## What this adds

The watcher now believes "gone" only when tmux itself says the session is missing. If the check fails for any other reason, it logs that and leaves the decision to the direct health checks.

- A closed pipe joins the survivable list, because only that one write failed.
- Known places that write to a helper program now handle that program closing early.
- A crash line now includes where the error came from. The two crashes on 2026-11-06 logged no source.
- The new helper is listed as outside the certified message-delivery code, because it only listens for stream errors. That code and its proof are unchanged.

## The safeguards

A server that is truly dead still restarts: straight away when tmux says the session is missing, and through the health checks if tmux gives no answer. That usually takes about a minute, and up to 10 minutes on a busy machine or just after a start. Only the exact closed-pipe error is survivable, and unknown errors still crash the server as before. Tests cover both sides of each of these.

## What is still unknown

Why the checks failed is not settled. The logs show the machine sometimes refused to start new processes, which points to pressure on the host. What the check said at those moments was never recorded, so a false "no server" answer is also possible, and this fix would not stop that. The new log lines record tmux's words either way, so the next episode will show it. Which exact write raised the closed-pipe error is also unproven, and the next one may log its source.

## What the reader needs to decide

Nothing. This is a small fix that a plain revert undoes.
