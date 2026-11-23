# ELI16: messages can no longer press keys inside the agent's terminal (SEC-137)

When you send the agent a message, the agent's server types it into the agent's running session, the way you would type into a terminal window. In front of the message it adds a short tag saying who sent it and from where, so the agent always knows who is talking.

Short, single-line messages were typed character by character, exactly as received. A few invisible characters mean something to a terminal: one means "press Enter", another means "erase the whole line", another means "stop what you are doing". If a message contained one of these, the terminal acted on it instead of showing it. Someone could send a message that pressed Enter halfway through, so the second half arrived without the sender's tag. Or the message could erase the real tag and type a fake one that claimed to be you.

Now, just before typing, the server turns any "Enter" character into an ordinary line break, which is sent safely as part of one message, and drops the other invisible control characters. Normal writing never uses those characters, so every real message still arrives exactly as you wrote it, including emoji, accents and any language. Only the hidden keystrokes are gone, so the sender's tag can no longer be pushed aside or faked this way.
