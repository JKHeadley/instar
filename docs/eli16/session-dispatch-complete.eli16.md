# ELI16 — Session context no longer loses its last sections

Instar generates a context dispatch file that tells an agent which deeper
instructions to read for different kinds of work. The same file also ends with
two important sections explaining which context is always loaded and which
context is restored at session boundaries. The startup and compaction hooks
used to print only the first twenty lines of this generated file. As the table
grew beyond twenty lines, those final sections were guaranteed to disappear
even though generation succeeded.

Both deployed hook templates now print the complete generated dispatch file.
The producer remains free to add or reorder routing rows without crossing a
hidden consumer limit, and tests protect both the fresh-session and compaction
paths from reintroducing that cap. The separate short excerpt of `AGENT.md`
remains intentionally bounded and is not part of this change.
