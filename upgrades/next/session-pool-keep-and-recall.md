<!-- bump: patch -->

## What Changed

On multi-machine agents with the session pool active, a conversation already running on a machine now stays there instead of being placed elsewhere on its next message, unless it is pinned elsewhere or this machine can no longer serve it. A moved conversation now fetches its recent messages over the signed mesh, so it no longer needs a bearer token shared between machines. The older call remains as a fallback and now has a 5 second deadline.

## What to Tell Your User

Nothing changes for you unless your agent shares work across machines. If it does, a running conversation won't jump to another machine by itself, and a moved one gets its recent messages back.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Running conversations stay on their machine | Automatic when the session pool is active |
| Moved conversations get recent messages without a shared token | Automatic; uses the `topic-history-pull` mesh verb |
