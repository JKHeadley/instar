# The send check works on every channel, not just Telegram

When an agent is about to send a message that credits someone with something it cannot source, a check called B23 can hold the message and ask the agent to fix it. To be fair, it first looks at the recent conversation, because repeating what was just said is fine. It only makes that crediting call when it can see the conversation.

The live test showed the problem. On real Telegram the check held a false credit. On real Slack the same words went straight through. The reason was simple: the code only knew how to find recent conversation for a Telegram topic. On Slack, the app, WhatsApp and iMessage it saw nothing, so it never made the call. The rule says it works on every channel, and it did not.

This change has each of those channels hand over its recent turns, read from the log the channel already keeps. It reads only the end of the file, so a big log costs little. It happens only when an agent is set to refuse, so no other agent's messages are reviewed any differently.

The second fix is about answering a held message. Telegram's reply script lets the agent say "you're right, I revised it" or "you're wrong, here's why". The other four scripts could not, and Slack's mistook the flag for a channel name. All four can now, and they print how.

Testing also found that the iMessage script used a command that fails on macOS, the only place iMessage runs, so it lost the reason for every refusal. That is fixed too.

Existing agents get the new scripts through the normal update. Undoing this is a plain revert. There is nothing for you to decide.
