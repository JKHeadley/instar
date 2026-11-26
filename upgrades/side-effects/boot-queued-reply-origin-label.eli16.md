# Replies sent while the server starts keep their label

Every message an agent sends to Telegram ends with a small footer that says who sent it: the agent's name, the machine, the tool running the session (for example Claude Code) and the model. People use that footer to know which session and computer a message came from.

When the server is restarting, it answers for a few seconds with "still starting". A reply a session sends in that window can't go out right away. The reply script saves it in a small local queue, and the server sends it once it is up. That part worked. But the queue only saved the text, not who wrote it. When the server sent the saved message, it had no idea which session it came from, so the footer said "unknown · unknown · unknown". That happened on November 3 with a reply from the "Instar App" session.

What changes:

- When the reply script has to queue a message, it also saves a fingerprint of the session's private credential. It saves only the fingerprint, never the credential, so the saved value can't be used to send anything.
- When the server later sends the queued message, it looks up which running session that fingerprint belongs to and fills in the real machine, tool and model, the same way it does for a normal reply.
- A restart gives every running session a fresh credential. The server now remembers each session's last few fingerprints, so a message queued just before the restart can still be matched. Those old fingerprints are used only for the label. They can never authorize a send.
- The machine is always filled in, even for messages from older scripts or from a session that has already ended, because the queue only ever holds messages written on this machine.
- If the session has ended by the time the message goes out, the footer shows the machine and leaves the tool and model as "unknown". The system never guesses.

Nothing changes about whether or when a queued message is sent. Only its label changes. Existing agents get the new reply script automatically on their next update.
