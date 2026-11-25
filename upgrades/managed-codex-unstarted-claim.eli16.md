# Retry a continuation launch that never started

The server can reserve a project task before it starts a worker. If admission changes just after reservation, a task could remain held even though no worker ever started. The server can now free that work for another authorized attempt when it knows it never called the launcher.

The old launch identity stays retired and cannot authorize continuation. If the server has already asked the launcher to start, it keeps the claim while it cancels the worker. After a restart the server needs more evidence than a pending claim to decide whether a worker started. The tests check that a pre-launch rejection can be retried, that a post-launch rejection still holds the claim, and that a retired launch identity cannot be reactivated. Production enrollment remains disabled while worker recovery is being built.
