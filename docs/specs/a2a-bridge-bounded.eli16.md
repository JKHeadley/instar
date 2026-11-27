# ELI16: the relay's door for outside agents no longer fills up its own memory (SEC-134)

The public relay has a door for agents that speak a different protocol (A2A). Two things behind that door kept growing forever.

First, to slow down anyone sending too many messages, the relay kept a short list of recent times for every internet address that ever knocked. The list for an address was emptied when it got old, but the address itself was never forgotten. Someone knocking from many addresses could make the relay remember millions of them and run out of memory.

Second, an outside agent can name a conversation with a "context id" so its later messages land in the same thread. The relay remembered every name ever used, forever, and names could be any length. A name was also shared by everyone: if you learned someone else's name, your messages joined their thread.

Now an address with no recent knocks is forgotten, the relay sweeps old ones once a minute, and it never keeps more than a fixed number at once, even if someone keeps inventing new addresses. Conversation names are remembered per caller and per agent, at most ten thousand at a time, and only for a day after their last use. A name longer than 256 characters is refused. What a person could notice: a conversation untouched for more than a day starts a fresh thread, just like a first message, and so does one whose sender's internet address changed in between (for example a phone moving between networks).
