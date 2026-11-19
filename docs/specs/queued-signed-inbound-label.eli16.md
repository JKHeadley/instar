# A queued or forwarded agent-written message keeps its "written by an agent" label (ELI16)

Sometimes an agent sends a message through a person's own Telegram account. The agent signs it, and when it arrives the system checks the signature and labels it "written by agent X, sent through this person's account". The session that reads it then knows the person did not write it.

That label only survived when the message went straight into a running session. If the session was busy and the message waited in the queue, if the session had to be started fresh, or if another of the agent's computers handled it, the label was lost and the session was told the person wrote it.

Now the label is decided once, when the message arrives, from the signature check, and it travels with the message through the queue, into a fresh session, and to another computer. Nothing written inside a message can create the label. The label only makes the session more careful: it says who wrote the text and changes nothing else.
