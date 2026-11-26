# Cloud agents keep working on just a sign-in key — plain overview

**What was wrong.** A cloud agent has no browser login for Claude. It has one sign-in key in its settings. Conversations got that key, but the agent's own background checks did not. Those checks use Claude too: reviewing the tone of outgoing messages, classifying incoming ones, and more. So on every cloud install they all failed, all the time. Replies still went out, but with no model review.

There was a second problem. When the key stopped working, nobody was told. The person who messaged the agent saw "working on it", then silence. Putting a good key back did not help a conversation already running, because it still held the dead key until someone ended it by hand. A customer has no way to find that out.

**What already exists.** The key already has one home in the settings, and the code that reads it already exists. Instar can already restart a conversation and pick up where it left off, can already notice a conversation stuck on a login error, and already knows how to write the key into settings.

**What is new.** Everything that starts Claude on the server now gets the same key from that same home. That includes a few other places the review found, such as agent-to-agent replies and the crash doctor. Instar also now checks a suspected dead key directly with Claude. If Claude really rejects it, twice, the operator gets a plain message saying how to put in a new key with one command, and each person waiting is told once what is happening. When a working key is proven back, stuck conversations restart by themselves and answer what they missed. A conversation that ended during the outage is not replayed, and the messages say nothing stronger than that.

**Safeguards.** The key never appears in command lines, logs or chat. A network problem or rate limit is never reported as a bad key, because only Claude's own refusal counts. Pay-per-call API keys are not used for background checks, because that would spend money nobody agreed to.

**If it were wrong.** One setting turns off the dead-key handling, and undoing the change restores the old behaviour. No settings are moved, so nothing needs repairing.

**What you need to decide.** Nothing. This fixes broken behaviour and does not change any standard.
