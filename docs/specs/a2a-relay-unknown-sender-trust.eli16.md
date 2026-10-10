# A first message is not a grant of trust (ELI16)

Agents talk to each other through a shared relay on the internet. Normally a message is locked so only the receiver can read it, and before the receiver acts on it, a checkpoint looks the sender up in its trust list. A sender that is not on the list may only "ping" to see if anyone is there.

There is a second kind of message: one the receiver cannot unlock, because it does not have the sender's keys yet. These arrive as plain text. They skipped the checkpoint completely. Every one of them was treated as coming from a known, trusted-enough agent. The receiver sent an automatic "got it" reply, put the message in its inbox, and could start a working session with full tools to answer it. Worse, that first message quietly wrote the sender onto the trust list as "verified", so from then on it was trusted on every route.

The relay does prove one thing: the sender really holds the key that matches its name tag. It does not prove who the sender is, and nobody ever decided to trust it. That is the hole this change closes.

With the change switched on, a plain-text message is judged by the trust list the same way a locked message is. A sender that is not on the list gets nothing: no "got it" reply, no inbox entry, no session, and it is not written onto the list. Its automatic "got it" replies to messages we sent still count, so peers we write to do not look unreachable. A sender that is on the list is handled at the level the list actually holds for it. Passwords and other secrets are never accepted this way, because secrets must always travel locked.

One detail turned out to matter. The checkpoint lets a stranger's "ping" through, expecting it to be answered on the spot. But the code after the checkpoint does not answer pings on the spot; it treats them like any message and can start a session. So on this route a stranger's ping is dropped too. The same gap on the locked route is recorded for its own fix.

It starts in watch-only mode, on development agents only. In watch-only mode every message is delivered exactly as before, and each one that would have been dropped is written to the log and counted on the agent's private health page. Strangers who write during this time are still added to the list as before, but they are marked as "only a first contact", and that mark is saved, so it survives a restart. When watch-only mode is switched off, a marked entry counts as no trust at all, on both routes, until someone actually grants that agent trust.

Agents already on the list before this change are left alone. On the development computer both existing entries were created by exactly this hole; deciding which of them are real is the operator's call, made from the counts.

**What ships now.** On for development agents, watch-only. Off for everyone else.

**What needs deciding later.** After two days of counts, grant trust to the real peers and switch watch-only mode off on the development agent. Turning it on for everyone needs an easier way to grant trust than one peer at a time.

**Status.** Built under the operator's standing approval of 2026-10-08.
