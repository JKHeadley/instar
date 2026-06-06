# Pending-inject durability - ELI16

> The one-line version: a message queued for a session that's still booting now survives a server restart — it used to silently vanish, and the user would wait on a reply that was never coming.

## The problem

When you message your agent and its session isn't running, the server spawns one and queues your message to be typed in once the session finishes booting (codex can take tens of seconds). That "queued" message lived only in the server's memory. Last night the auto-updater restarted the server in exactly that window: the terminal session survived and sat at an idle prompt, your message's content sat in a file nobody would ever read, the new server had no idea anything was pending — and the operator waited 50+ minutes on a reply to a message that was never delivered. Nothing anywhere recorded that a loss had happened (finding 8d300555).

## What changed

Three things, smallest possible footprint:

1. **A durable ledger of in-flight injects.** The moment a session is spawned with a queued message, a small JSON record is written to disk. It is removed only after the message is actually typed into the session. A restart can no longer erase the fact that a delivery was owed.
2. **Boot-time recovery.** When the server starts, it sweeps surviving records: a still-alive session gets its message delivered through the normal "wait until ready, then type" path (exactly the incident's shape — that session was sitting idle, waiting). A dead or too-old record is reported loudly through the degradation system and retired — the loss becomes visible instead of vanishing.
3. **An honest log line.** The old "Fresh-spawn fallback succeeded" printed before the message was typed; it now says "launched (inject pending)" because that is what's true at that moment.

## Deliberate trade-off

Delivery is at-least-once: if the server dies after typing the message but before removing the record, the next boot delivers a duplicate. A duplicated message to an agent is harmless noise; a silently dropped user message cost an hour last night. We chose the duplicate.

## What does NOT change

Normal spawns, resumes, and injects behave exactly as before — the ledger writes never block or fail the spawn (they degrade to a warning). The recovery sweep runs in the background after boot and can't delay startup.
