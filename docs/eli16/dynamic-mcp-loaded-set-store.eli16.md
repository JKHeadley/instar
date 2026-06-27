# Dynamic MCP — the loaded-set state store (ELI16 overview)

## What this is

A tiny, durable notebook that records, per conversation, "which MCP helpers is this
session currently running with." It's the shared source of truth between the two
halves of the feature: the part that LAUNCHES a session reads it ("start with
these"), and the part that CHANGES things writes it ("now it's running with these").
Because a session can only change its helper set by restarting, this little file is
how a restart remembers what to come back up with.

## The clever bit: "saved" vs "final"

Every entry is marked either "in progress" or "final." This matters because changing
a session is a two-step dance: write the new list, then restart. If the restart
fails (say the system is rate-limited), we must NOT leave a half-applied change that
a later, unrelated restart would silently pick up. So the reader only ever trusts a
"final" entry. An "in progress" entry is invisible to it — which means a change that
got written but never successfully restarted simply never takes effect. The live
session keeps whatever it already had.

## Safety details

Writes are atomic: we write to a temporary file and then rename it into place in one
move, so a crash mid-write can never leave a half-written, garbage file that the
reader would trip over. If a file somehow does end up unreadable, the reader treats
it as "no trusted record" and the session falls back to its safe default rather than
crashing. Seven tests pin all of this: absent vs in-progress vs final, the
commit-after-in-flight transition, de-duping, the unreadable-file case, and the
no-leftover-temp-file guarantee. It's not wired to anything yet.
