# Without a known owner, nobody's Telegram words teach the agent (ELI16)

The agent learns its owner's preferences from what the owner writes: corrections like "stop asking me that", or "keep it short from now on". To keep anyone else from teaching it, it only learns from messages it can prove came from the owner.

There was a gap. If an agent had no owner set up and no verified operator, it treated every verified Telegram sender as the owner. On an agent that several people can message, any one of them could then teach it "the owner's" preferences.

Now, when no owner is known, nobody's Telegram words count, with one exception. If exactly one person is allowed to message the agent, that person is clearly the owner, so their words still count. An agent with an owner set up works exactly as before.

Follow-up after the first full test run: some older tests sent messages to an agent that had no owner set up, and expected the agent to learn from them. With this fix it correctly learns nothing, so those tests failed. The tests now set up an owner the same way a real agent does. Two new tests check that an agent with no owner, or with several people allowed and no owner, learns from nobody.

Second follow-up: the new "no owner" test was accidentally still giving the agent one allowed person, because of a default value in the test. It now really has nobody allowed, as it was meant to.
