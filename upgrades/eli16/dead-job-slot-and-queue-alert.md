# A crashed scheduled job can release its slot

The Studio normally runs one session-based scheduled job at a time. A job stopped after losing access to its model service, but the terminal manager kept its pane on screen. The scheduler still saw a running job in its records and kept the rest of that queue waiting. The queue resumed when the dead session was removed.

The scheduler now checks the terminal when jobs are waiting. If it confirms that a job has exited, it records the end of that run through the same path that normally frees a slot. If a process is still alive or the check is inconclusive, it keeps the slot. The liveness check uses bounded background terminal queries. If the queue waits longer than the longest enabled local job timeout without advancing, the agent records an alert it can investigate.

The diagnostic is recorded in the server activity history so the agent can find the incident even after the queue recovers.
