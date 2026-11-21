# Without a known owner, nobody's Telegram words teach the agent (ELI16)

The agent learns its owner's preferences from what the owner writes: corrections like "stop asking me that", or "keep it short from now on". To keep anyone else from teaching it, it only learns from messages it can prove came from the owner.

There was a gap. If an agent had no owner set up and no verified operator, it treated every verified Telegram sender as the owner. On an agent that several people can message, any one of them could then teach it "the owner's" preferences.

Now, when no owner is known, nobody's Telegram words count, with one exception. If exactly one person is allowed to message the agent, that person is clearly the owner, so their words still count. An agent with an owner set up works exactly as before.
