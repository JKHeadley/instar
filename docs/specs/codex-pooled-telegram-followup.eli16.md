# Keeping Telegram follow-ups with the right Codex conversation

When you send another message while an agent is working, the system must keep it with that conversation. It must not lose the message, place it in a different account, or paste it twice because delivery is uncertain. Instar already has a durable delivery journal and a queue for this purpose. Before it can safely deliver a message, it records the position of the conversation transcript so it can tell whether Codex actually received the input.

The reported failures occurred because this transcript lookup used the default Codex folder, while the two running conversations used a separate subscription account folder. Their transcripts existed, but the lookup could not see them. The system refused delivery before it reached the terminal. This explains the observed refusal; it does not prove every problem with a busy terminal has the same cause.

This repair makes the existing delivery machinery read the account home from the exact running session. It keeps the existing ownership checks, encrypted journal, transcript observation and queue order. It does not search other accounts or treat an unreadable transcript as successful delivery. A queued follow-up remains durable until the preceding tracked delivery completes, and only then becomes eligible for the next physical delivery.

Tests check the actual account path, refusal boundaries, the HTTP forwarding route, and persistence across reconstructing the server. Complete verification and the normal release process still follow. No existing user message is automatically replayed by this change, and a historical failed message is not claimed recovered. Reverting the source change restores the prior behavior without a database migration.
