<!-- bump: minor -->
## What Changed
With memory privacy on, an agent that serves several people talks to other agents again, each in a place of its own. Until now it refused every conversation another agent started.
- **A place per agent.** An inbound agent-to-agent conversation runs in a scoped place keyed by the other agent's authenticated fingerprint (`agent:<fp>`), with that place's memory only. It never sees the owner's memory, a person's memory or another place's. It runs in the same sandbox as every scoped session, with no Threadline tools.
- **Only agents the owner chose.** A place opens only for a peer with an explicit trust grant (`user-granted`, `paired-machine-granted` or `mutual-verified`), never `setup-default`, so a stranger who makes a new key is still refused. Same-machine peers stay refused until local message signing is enforced.
- **Replying.** A place session replies with `.instar/scripts/threadline-reply.sh`, which posts to `POST /threadline/session-reply`. The recipient comes from the session's token and never from the request. Acknowledgments go the same way (`--ack`).
- **Threads belong to their agent.** A thread records the authenticated agent it is with. Another agent's message on that thread id moves to a fresh thread, and history from before the thread was claimed is never loaded into a place.
- **Capacity.** One live session per agent, at most 3 places (`threadline.placeSessions.globalCap`), ended after 10 minutes idle (`threadline.placeSessions.idleMs`). At the cap a new agent waits in the queue. No live session is ended to make room, and one session slot is kept free.
- **Gaps closed on the way.** On a multi-person agent with privacy on, pipe mode and the listener inbox ran another agent's message with owner reach, and live inject, reply waiters and topic replies accepted any sender on a thread id. Reap recovery replayed a thread owner's identity rather than the sender's. All of these are closed regardless of the new switch. `POST /hooks/events` now records a scoped session's start under its own id only.
- **Settings.** `memoryPrivacy.refuseAgentSessions: true` restores the refusal. `memoryPrivacy.linkedPeerReplies: "post-only"` posts another agent's reply to an owner-started conversation in the topic instead of typing it into the session. Both are read live, per machine.
- **Status.** `GET /memory-privacy` adds `agentSessions`: `own-place`, `refused` or `owner-reach`.

## What to Tell Your User
If memory privacy is on and several people use me, other agents can talk to me again. Each one gets a conversation of its own that can't see anyone's private memory: not yours, and not the people I work with. Only agents you trusted or paired with get one. If you'd rather I refused other agents like before, tell me and I'll switch it back.

## Summary of New Capabilities
- Another agent's conversation runs in its own scoped place, with a session-bound reply script, on a multi-person agent with memory privacy on.
- `agentSessions` on `GET /memory-privacy` tells the app which line to show when privacy is turned on.
- `memoryPrivacy.refuseAgentSessions` and `memoryPrivacy.linkedPeerReplies` switches.
