# Smaller work lists, without erasing memory

Instar keeps four lists: proposals, lessons, capability gaps and actions. Their retention
settings have a bug: when open work fills the target, asking for the last zero finished
records keeps every finished record. This change fixes all four occurrences together.

The settings are soft targets. Instar will keep open work even when it exceeds the target.
New retentionTargets names make that limitation explicit, and old max settings still work.
Zero means zero room for finished records; invalid settings stop trimming rather than silently
choosing another number. Counts are calculated from what is actually retained.

Finished work can still be valuable memory. Before it leaves a work list, Instar saves its
complete content in the archive that already supports old-action expiry. It reads that content
back before removing anything. An archive failure keeps the work list intact. Nothing in the
archive expires, and a later save or restart can safely recover an interrupted move.

Taking something out of a work list will no longer send a deletion to other machines. The
existing replication repair system can still see archived lessons and actions. The existing peer-presence checks also copy complete archive pages into each machine's
existing archive, without trimming text. Archived memory remains readable after peers go
offline. Operational retention reports look across the pool and name unreachable machines. They do not pretend an unavailable peer is empty or that repeated records are
unique. Old record numbers stay reserved so an old reference cannot name new work.

When open work exceeds the target, Instar raises a structured warning in its operational log
after trying to archive finished surplus. That warning does not cancel commitments or turn
on automatic expiry. It is an agent-owned signal, not a claim that you received a notification.
Restoring an action holds it in the work list until the hold is deliberately released.

The November 5 measurement is 300 actions, 167 active and 133 finished. August's 352/300
measurement is historical. This work is approved through the normal standing policy for
non-critical process decisions, with independent review and the normal test and merge gates.
The constitution itself does not change.
