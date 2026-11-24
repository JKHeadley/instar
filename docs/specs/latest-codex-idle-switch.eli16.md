# How a running Codex conversation could change models safely

A new conversation can already start on the newest reviewed model in its chosen family. An open conversation is different. It may have work running in the background, text that someone is still typing, or a message waiting to enter the conversation. An automatic change should happen only for people who choose that behavior and only when Instar can prove the conversation is safe to update.

The first change would explain what Instar can establish about a session without interfering with it. A conversation pinned to a specific model or using a local model stays ineligible. For an older session without a trustworthy record, Instar reports the choice as unknown and keeps automatic switching unavailable. Instar will call the live state unknown when it cannot verify a detail that matters.

A future automatic switch would need direct proof of which model the running Codex process is using and that it has finished its work. Instar would also need a way to hold new input while it changes models and a reliable record of which messages the conversation already accepted. The conversation must keep the same identity and account. If the update cannot be verified, the saved conversation and waiting messages stay in recovery custody. The first change provides observation only.
