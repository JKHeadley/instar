# WS2.5 Evolution Action-Queue Replication — ELI16

## What is this?

Your agent keeps an action queue — a list of self-improvement things it committed to do ("fix
the dashboard streaming bug", "ship WS2.5"), each with a status (pending, in progress, completed,
cancelled), a priority, who it was committed to, and when it was created. Today that queue lives
on ONE machine. If you run the agent on a laptop AND a Mac mini, an action it raised on the laptop
is invisible to the mini — and worse, the mini might redo work the laptop already finished. WS2.5
fixes that: when you turn it on, an action raised on one machine becomes known on the others — ONE
action queue, not one-per-machine.

## How does it know two machines have "the same" action?

Each machine gives every action its own local id like `ACT-001` — but those ids are LOCAL. The
laptop's id and the mini's id for the same action are different. So we can NEVER use that id to
decide "is this the same action across machines."

Instead we compute a CONTENT FINGERPRINT — a hash of the action's title plus who it was committed
to plus when it was created. If two machines have the same action, they produce the SAME
fingerprint, and the two copies collapse into ONE record instead of showing up twice. Trivial
differences (extra spaces, capitalization) are ignored. Genuinely different actions get different
fingerprints.

## Why is the STATUS the important part?

This is the whole point of replicating actions. The most valuable thing a peer machine can learn is
"this action is already done." If the laptop marks an action `completed`, the mini needs to SEE that
`completed` status so it doesn't waste effort redoing finished work. So every time an action's status
changes, the agent re-sends it — carrying the new status. The status is the load-bearing field.

Importantly: the title, who-it's-committed-to, and created-date are used for the fingerprint, but the
status is NOT — because the status changes over time. If we put the status in the fingerprint, every
status change would look like a brand-new action instead of an update to the same one.

## What happens when an action is finished — does it get deleted?

No. A `completed` or `cancelled` action is a FINISHED state, but its record is kept as history — it's
re-sent as a normal record so peers know it's done. It is NOT deleted. Only when an action is actually
REMOVED from the queue (the queue gets too long and old finished actions are trimmed away) does the
agent send a "tombstone" — a positive "this one is gone" marker — so the removal sticks everywhere,
even on a machine that was offline when it happened. Without the tombstone, a machine that still had
the old action would keep re-sending it and it would come back from the dead forever ("resurrection").

## What if two machines disagree about the same action?

An action is a work item to SURFACE, not a command, so we never silently throw one version away. If
the laptop marked it `completed` and the mini still has it `in_progress` (they were offline from each
other and edited it concurrently), the agent surfaces BOTH versions as advisory hints and flags the
conflict for you to clean up later if you want. It never blocks waiting for you to decide. A replicated
copy from another machine never overwrites a different local copy.

## Is it on by default? Is anything private leaking?

No. It ships DARK: `multiMachine.stateSync.evolutionActions.enabled` defaults to `false`. With it off,
nothing changes at all — a single-machine agent behaves byte-for-byte as before, and no action ever
crosses a machine boundary. When you DO turn it on, every field is strictly checked on arrival (the
dates must be real dates, the priority must be one of critical/high/medium/low, the status must be one
of pending/in_progress/completed/cancelled, free text is length-bounded, and a source field that looks
like a sneaky file path is dropped) so a peer can't smuggle anything malicious in, and a peer's action
is always treated as quoted, untrusted reference — never an instruction. The local `ACT-NNN` id is never
sent across the wire.

## Why does this matter?

It's the fourth of a family ("memory-family") of replicated stores. Preferences (WS2.1), relationships
(WS2.3), learnings (WS2.2), and the knowledge base (WS2.4) already do this; the action queue is next.
The end state: ONE coherent memory that follows you across every machine you run the agent on, instead
of a separate brain per machine — and crucially, the machines stop redoing each other's finished work.
The last memory-family kind (the playbook) is a tracked follow-up.
