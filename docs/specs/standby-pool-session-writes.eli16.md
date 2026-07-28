# Standby may persist its own sessions — explain it like I'm 16

Two computers act as one assistant: a main one (the laptop) and a backup (the Mac
mini). To keep them from corrupting each other's shared notes, the backup runs in
"read-only" mode — it can READ the shared state but is forbidden from WRITING any of
it. That's a safety rule: if both machines wrote to the same shared notebook, you'd
get two conflicting versions ("a fork"), which is a mess.

Now we're adding a new ability: you can MOVE a single conversation from the laptop to
the mini, and the mini takes it over. We got that working far enough that the mini
RECEIVES the moved conversation and tries to start it up. But then it hit a wall:
starting a conversation means writing down "I now own this conversation, here's its
state" — and the mini is read-only, so that write got blocked:

  "StateManager is read-only (this machine is on standby). Blocked: saveSession"

So the read-only safety rule, which is correct for shared notes, was ALSO blocking
the mini from saving the one conversation it legitimately now owns. Two goals
collided: "backup can't touch shared state" vs "backup needs to run conversations
handed to it."

The fix splits writes into two kinds:
- SHARED writes (the cluster-wide notebook: who's in charge, jobs, the key-value
  store, the event log). The backup STILL can't touch these — the safety rule holds.
- PER-CONVERSATION writes (one conversation's own little file). The backup CAN make
  these — but only when the conversation-moving feature is turned on.

Why is the per-conversation write safe even on a read-only backup? Because the system
already guarantees that only ONE machine owns a given conversation at a time (it uses
a claim-and-confirm step). So when the mini saves "conversation 8882's state," no
other machine is also writing that same file — there's nothing to fork. And the only
way the mini even tries this is through the move feature, which only runs when that
feature is switched on. So the safe write is gated three ways: it must be a
single-conversation file, the move feature must be on, and the conversation must have
been formally handed to this machine.

In code it's tiny: the backup gets a flag "the conversation-pool is active," and the
two per-conversation save/remove operations are marked "this is a single-conversation
write." The guard then says: if I'm read-only, block it — UNLESS it's a
single-conversation write and the pool is active. Everything else a backup might try
to write stays blocked exactly as before, and a backup with no pool turned on behaves
identically to today (fully read-only). I added tests for every combination: the
backup allows a session save when the pool is on, still refuses shared writes, still
refuses session saves when the pool is off, and a normal machine writes everything.

This is one more rung of the ladder. With it, a moved conversation can actually be
recorded on the mini. The last remaining rung is letting the mini send its replies
back to you (right now the backup has no way to message Telegram) — that's a separate
fix I'm tracking next.
