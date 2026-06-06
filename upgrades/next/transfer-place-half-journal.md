## Conversation moves now carry their ownership proof (quiet topics)

Moving a conversation to another machine now records the move in the shared coherence diary even when the conversation was quiet — previously the receiving machine had no way to prove the conversation was its to serve, so its "fetch this conversation's files" reflex refused to run (the EXO-recovery case). The transfer also repairs conversations left half-placed by older moves. Agents see a new `placedOwnership` field in the transfer response.

- audience: agent-only
- maturity: stable
