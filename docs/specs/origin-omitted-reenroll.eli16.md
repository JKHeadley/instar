# Locked-down sessions stay locked after a restart (ELI16)

Some of the agent's sessions are started on purpose with none of its keys, for example the session that fixes bugs reported from outside. Among the keys they don't get is a small "origin" pass that lets a session prove which session it is when it sends a message as the agent.

When the agent's server restarts, it hands a fresh origin pass to every session that is still running, because the old passes stop working. It did that for the locked-down sessions too, so after any restart they quietly got a pass they were never meant to have.

Now a locked-down session is started with a label that says "no origin pass". A restart reads that label and skips the session. Normal sessions get their pass back exactly as before.

If the agent cannot read the label because of an error, it gives that session no pass at all rather than guessing.
