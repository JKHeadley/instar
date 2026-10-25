# Moving a conversation could leave two live copies of the agent — the fix

**What was wrong.** When the agent moves a conversation from one of its machines to another, the machine that has it is asked to finish up, close its session for that conversation, and then hand ownership to the new machine. The hand-over step did not check whether the close had worked. If the close was refused, ownership moved anyway and the old session kept running. The new machine, now the owner, started its own session at the next message. Two sessions then served one conversation without knowing about each other. On 23 October 2026 that happened for about ten minutes: both sessions created, closed and deleted the same Telegram topics, and Justin was told two different stories. Nothing was lost only because one of them happened to save everything first.

**Why the close was refused.** Two safety checks stopped it. One says only the machine in charge of the whole agent (the "lease holder") may end sessions on its own; the old machine usually is not that machine. The other keeps a session alive when the user has written recently; the user had just asked for the move. Neither check makes sense for a deliberate move: the conversation carries on on the new machine.

**What changes.**
1. The old machine hands ownership over only if its session really closed. If the close was refused or failed, the move is cancelled and ownership stays where the running session is.
2. The move request then answers "failed, please retry" and does not point the conversation at the new machine. Before, it did, so the next message could still create the second copy.
3. A deliberate move's close is no longer stopped by the two checks above. All the other checks still apply (for example a session with a helper still running is kept), and if one of them refuses, the move is cancelled as in step 1.

**What stays the same.** Moves that work today work the same way. Nothing changes for a single-machine agent. The separate "stand-down" feature, which detects two copies after the fact, is unchanged; this fix stops the second copy from being created in the first place.

**What to decide.** Nothing. If a move is cancelled this way, the reply names the reason, and the move can be retried.
