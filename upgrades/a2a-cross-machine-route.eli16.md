# Sending agent messages from a standby computer (ELI16)

Agents talk to each other through a shared service called the relay. It works like a post office. An agent keeps one open line to it, and only one of the agent's computers can hold that line at a time.

I run on more than one computer. One holds the line and the others stand by. Until now a standby computer could not send a message to another agent at all: it had no line, so every send failed, even though I was connected to the post office through my other computer. Sessions of mine do run on standby computers, and each message they sent failed this way.

Now, when a standby computer of mine needs to send, it asks my other computers which one holds the line. If one does, it hands the message to that computer over the private, signed channel my computers already use to talk to each other. Nothing new is opened to the outside world. The computer that holds the line sends the message in the ordinary way and keeps the records of it, exactly as it does for its own messages. It reports back what the post office really said (delivered, held for later, or refused), and the standby passes that answer on unchanged.

When the other agent replies, the reply arrives at the computer that holds the line. If the message was sent from one of my chat topics, that computer asks the computer that sent it to type the reply straight into that topic's session, so the answer shows up where the question was asked. If that computer no longer has the session, it asks at most one more: the computer my records say has the topic now.

The limits are deliberate. It tries once and never retries by itself. A refusal from the post office is reported as a refusal. If the other computer does not answer in time, I report "unknown" and do not send again. Secrets are never handed over this way. If none of my computers holds the line, the send fails as it does today. A computer whose line was taken away, as opposed to one standing by, also still fails as it does today. If the reply cannot be typed into the session, it is posted into the chat topic instead: it is never thrown away, and no new session is started to answer it without knowing the conversation.

One thing was fixed on the way. When I addressed an agent by name, the reply came back signed with its ID, the two did not match, and the reply was handed to a new session that knew nothing. Now the reply is matched against the ID the message was actually sent to. This fix is on for everyone.

Honest limits: a reply to a message sent from outside any chat topic lands on the computer that holds the line, not in the session that sent it. A second reply that arrives within a minute of a failed one, while the other computer is unreachable, is neither typed in nor posted; it stays in the Threadline list on the computer that holds the line. This does not add a second road to another person's agent for the day the post office itself is down.

**Status.** Approved for building under the operator's standing approval for the agent-to-agent communications track (2026-10-06). The forwarding ships switched on for development agents only; the name-matching fix ships for everyone.
