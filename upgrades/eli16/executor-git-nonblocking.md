# Copying code without freezing the server

Before a feedback worker starts, the server copies the code for it, and it does more copying for the final checks. It ran those git commands in a way that makes the whole server wait until each one finishes. Nothing else can happen during that wait: no messages, no health checks, and no lease renewals. On a busy machine one copy can take over 40 seconds, and there are several in a row.

That looks connected to two problems we've been chasing. The server misses renewing its lease, which made workers get rejected as out of date. And it sometimes gets declared unresponsive and restarted. The timing lines up, but the machine is also genuinely busy, so we won't know how much this helps until we watch it live.

The change runs those git commands in the background so the server keeps working meanwhile. They go through the same safety checks as before and keep their time limits, and failures still report git's own error. Quick commands stay as they were. Deleting those copies afterwards still freezes the server for several seconds at a time; that's logged as separate work. Nobody has a decision to make, and undoing this is a plain revert.
