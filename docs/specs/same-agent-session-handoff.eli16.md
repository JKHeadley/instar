# Session Handoffs Stay Out of the User's Chat — Plain-English Overview

An Instar agent often runs several sessions at once, each tied to its own chat topic. Sometimes one session needs another to do something: "please run this experiment", "who owns this?". On 2026-11-03 the operator saw such a message in his "Increasing Throughput" chat. A desk session had written it to the session working that topic. He was clear: internal coordination like this must never be shown to him, while real progress updates should keep coming.

The desk used the chat because nothing else worked. Instar has a message route for one session to write to another, but for two sessions of the same agent it saved the message and never delivered it. The message sat at "sent" forever, because the retry loop only looks at "queued" messages. So a session that needed another session reached for the one route that did arrive: the user's topic.

This change fixes that at two points:

1. **The route now delivers.** A same-agent message to a named session is typed straight into that session, but only if the target is one of the agent's own running sessions. A wrong name is refused and nothing is typed anywhere. Delivery then uses the same checks other agent messages already go through: the session must be alive and showing a safe program. If the session can't take the message right now, it is marked "queued", and the existing retry loop tries every 30 seconds for about five minutes. The delivered block says where to send the reply: back to the sender's session, never into a user topic.
2. **Agents are told about it.** Every agent's CLAUDE.md gains a short section saying that chat topics are the user's conversation, never a channel between its own sessions, with the exact call to use instead. Existing agents receive it on update.

A third piece, a check in the outgoing-message reviewer that hands back any chat message written to another agent, is a separate change. Adding it changes the reviewer's benchmarked prompt, so the benchmark must be re-run first. That work is tracked in the feedback queue (fb-245d23bf-1e2).

What to decide: nothing beyond the normal review. If something goes wrong, a revert removes both parts. No stored data changes.
