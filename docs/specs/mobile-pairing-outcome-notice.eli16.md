# Telling the conversation whether the phone paired: the plain version

When you ask an Instar agent to add itself to your phone, it sends you a one-time link. You open it on the phone, and the rest happens outside the conversation: the agent sends you a private message with Approve and Decline, and the app waits for you to approve. The conversation where you asked for the link never hears how it ended.

On 14 November that gap caused a wrong answer. The private message was delayed, the agent saw a note in its own logs saying so, and it told Justin the pairing had failed. It hadn't: the message arrived a little late, he approved, and the phone was paired. The device list already said so. Justin asked for the whole process to be made robust and seamless, including what the agent knows.

This change does two things.

First, when the agent makes a pairing link it can say which conversation asked for it. The agent then watches the device list, and when the phone is paired it posts one plain line in that conversation, like: A phone named "Justin's iPhone" is now paired with Echo. If it doesn't pair, the line says why in plain words: it was declined, the code was typed wrong too many times, nobody approved it in time, or the link expired or stopped working after a restart. There is exactly one line per link. The watch list is saved to disk, so a restart in the middle doesn't lose the message or send it twice in normal use. The line goes out through the same path as the agent's other automatic notices. If it cannot be posted within an hour, the agent raises one item on its attention list instead, so the news is never just dropped.

Second, every agent's instructions get one new line: the device list is the answer to "did it pair?", and a note that a message was held or delayed is not a failed pairing. Existing agents get this line on their next update.

Nothing about pairing security changes: who can approve, the code, and the limits on wrong codes are the same. If an agent doesn't name a conversation, nothing changes at all. It can be switched off with one setting.

For now the line is posted in Telegram conversations, which is where pairing links are asked for today. If the link is asked for in an app or Slack conversation, or the agent has no Telegram, the link is still made as before; the agent is simply told no line will follow, and why. The phone name in the line is reduced to plain letters and numbers, so a phone cannot slip a link or formatting into your conversation, and the line shows the same key the app shows.

What to decide: nothing. It is reversible with one setting or by undoing the change.
