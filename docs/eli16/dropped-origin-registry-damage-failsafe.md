# Excluded-machines list: never overwrite a damaged file

When an agent runs on several machines, it keeps a small list of machines whose shared data it has cut off, for example a
machine that was dropped or whose pairing was revoked. About nine kinds of shared data read this one list. It lives in a
single file. Before this change, if that file got damaged (a cut-off write, a stray edit, a disk hiccup), the agent read it
as "nobody is cut off", or as only part of the list. Worse, the very next time anything was added or removed, the agent saved
that partial list over the damaged file, so the other cut-offs were gone for good and the next restart looked perfectly healthy.
A revoked machine could quietly come back.

Now a damaged file is handled carefully. The agent keeps every cut-off it can still read, from any machine, and treats those
machines as excluded. It copies the damaged file aside untouched and leaves the original where it was, so the damage is still
visible after a restart. It refuses to save changes to the list until the file is repaired, so nothing is ever erased. And it
raises one problem report saying where the copy is and how to repair it. A healthy file works exactly as before.

For the operator nothing changes on screen unless the file is damaged, in which case the agent has a clear report to act on.
