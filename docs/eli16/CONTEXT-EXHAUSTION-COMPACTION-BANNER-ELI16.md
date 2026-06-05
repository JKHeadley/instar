# Context Exhaustion Compaction Banner ELI16

Instar has two different kinds of terminal text that mention compaction.

One kind is a real failure. For example, a session can say the conversation is
too long, or that an error happened during compaction and the user should go
back a few messages. That means the session needs context-exhaustion recovery.
The detector should still catch those messages.

The other kind is normal lifecycle text. After a session compacts successfully,
the terminal can show a banner saying the conversation was compacted, identity
was recovered, or the session paused for context compaction and resumed. That is
not a failure. It means the compaction machinery did what it was supposed to do.

The bug was that the context-exhaustion detector could treat normal compaction
banner text as if it were a failure signal. That creates a false alarm: recovery
or status code may tell the user the session hit a context problem even though
the visible text is only the normal "compaction happened and resumed" lifecycle
banner.

The fix adds a narrow exclusion before the detector checks broad context-limit
patterns. If the output looks like a normal compaction lifecycle banner and does
not also contain explicit failure text, the detector returns "no context
exhaustion." If the output includes the real failure text, such as "conversation
too long" or "press esc twice," the detector still reports context exhaustion.

This is a detector correctness fix, not a notification policy change. The future
notification gate decides who is allowed to speak to the user. This patch makes
one detector stop sending the wrong signal in the first place.
