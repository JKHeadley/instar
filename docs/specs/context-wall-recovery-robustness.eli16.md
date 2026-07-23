# Context-wall recovery robustness — ELI16

A session at the context wall can look busy for the wrong reason. Browser and
MCP helpers may still exist even though the model cannot produce another word.
The old recovery code counted those helper processes as proof of work. It then
used up one recovery attempt every time it chose to wait, eventually declaring
recovery exhausted without ever trying to recover.

This change uses the transcript as the work receipt. If the session's own
transcript grows, it is producing work and recovery waits without spending an
attempt. If the transcript stays still, recovery tries to compact the
conversation in place. If that cannot clear the wall, it starts a clean session
with recent thread history. A persistent latch has a 30-minute ceiling, so
ambiguous evidence cannot defer forever.

The latch also becomes a guard on every spawn path. While it is present, saved
resume identifiers are ignored and removed, so a user message, watchdog, or
other respawn cannot accidentally reload the same overfull conversation.
Standby status names the latched wall honestly instead of saying the dead
session is actively working.
