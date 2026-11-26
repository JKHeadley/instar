# Slack thread history now says who wrote each message (plain-English overview)

When someone writes to an Instar agent in Slack, the agent is handed the recent messages from that conversation, so it knows what was already said. Each of those earlier messages is supposed to say who wrote it.

There was a mistake in how those labels were made. Every earlier message was labelled with the name of whoever had just written, not whoever wrote that message. With one person in a direct message that never showed, because there is only one writer. In a shared Slack thread with two or more people, it made everything look as if it came from the latest person. In a test with two real people in one thread, the agent noticed this itself: it said both messages seemed to come from the same person, and it could only tell them apart by what the messages said.

Now each earlier message carries its own writer. The agent's own messages are labelled as the agent. The person writing now keeps their name on their own messages, so a one-person conversation reads exactly as it did. Anyone else in the thread is shown by their own Slack ID, so two people can never look like one.

This only changes the text the agent reads. Who is allowed to talk to the agent is still decided by each message's real Slack sender, which was already correct. There is nothing to decide here beyond agreeing that each message should name its own writer.

The new helper reads only fields the agent already received; it calls nothing in Slack.
