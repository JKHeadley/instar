# ELI16 — Edited job instructions run without a server restart

AgentMD jobs store their instructions in readable markdown files. The scheduler
used to load those instructions once at startup. It could detect when someone
edited a file later, but it only warned that a restart was required and still
ran the old instructions. That made a successful edit look live when it was not.

The scheduler now re-reads the body at the moment a job is triggered. If the
edited file is still a regular, size-bounded AgentMD file with valid frontmatter,
the triggering run receives the new body and its run-history hash describes
exactly those instructions. If the file is missing, malformed, symlinked, or too
large, the scheduler safely keeps the last validated body and emits one warning
for that bad disk state. Schedule and other manifest authority remain unchanged.
