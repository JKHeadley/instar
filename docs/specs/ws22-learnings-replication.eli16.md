# WS2.2 Learnings Replication — ELI16

## What is this?

Your agent keeps a registry of lessons it has learned — short, structured insights like
"use a trailing colon for tmux pane commands" or "read the session clock before reporting
elapsed time." Today that registry lives on ONE machine. If you run the agent on a laptop
AND a Mac mini, a lesson it learned on the laptop is invisible to the mini. WS2.2 fixes
that: when you turn it on, a lesson learned on one machine becomes known on the others —
ONE learning registry, not one-per-machine.

## How does it know two machines learned "the same" lesson?

This is the tricky part. Each machine numbers its own learnings `LRN-001`, `LRN-002`, … —
but those numbers are LOCAL. The laptop's `LRN-005` and the mini's `LRN-005` are almost
certainly different lessons. So we can NEVER use that number to decide "is this the same
lesson across machines."

Instead we compute a CONTENT FINGERPRINT — a hash of the lesson's title + category + where
it came from. If two machines learn a lesson with the same title and category, they produce
the SAME fingerprint, and the two copies collapse into ONE record instead of showing up
twice. Trivial differences (extra spaces, capitalization) are ignored. Genuinely different
lessons get different fingerprints, so two unrelated lessons never get mistaken for one.

## What if two machines learned slightly different versions of the same lesson?

A learning is GUIDANCE, not a command, so we never silently throw one version away. If the
laptop and the mini both edited the same lesson at the same time and they disagree, the
agent surfaces BOTH versions as advisory hints and flags the conflict for you to clean up
later if you want. It never blocks waiting for you to decide — you keep getting both useful
hints in the meantime. A replicated copy from another machine never overwrites a different
local copy.

## What about lessons that get deleted or pruned?

The registry caps at 500 learnings; older ones get pruned. If a pruned learning just
vanished, another machine that still had it would keep re-sending it — and it would come
back from the dead forever ("resurrection"). So when a learning is pruned, the agent sends a
"tombstone" — a positive "this one is gone" marker — so the deletion sticks everywhere, even
on a machine that was offline when the prune happened.

## Is it on by default? Is anything private leaking?

No. It ships DARK: `multiMachine.stateSync.learnings.enabled` defaults to `false`. With it
off, nothing changes at all — a single-machine agent behaves byte-for-byte as before, and no
learning ever crosses a machine boundary. When you DO turn it on, every field is strictly
checked on arrival (dates must be real dates, the "applied" flag must be a real boolean, free
text is length-bounded) so a peer can't smuggle anything malicious in, and a peer's learning
is always treated as quoted, untrusted data — never an instruction. The local `LRN-NNN`
number is never sent across the wire.

## Why does this matter?

It's the second of a family ("memory-family") of replicated stores. Preferences (WS2.1) and
relationships (WS2.3) already do this; learnings is next, and the knowledge base, evolution
queue, and playbook follow on the exact same machinery. The end state: ONE coherent memory
that follows you across every machine you run the agent on, instead of a separate brain per
machine.
