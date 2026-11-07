# Slack conversations stay with their Slack connection — the short version

Your agent can run on several of your machines, and a conversation's session can be moved from one machine to another. A Slack conversation is a special case: only the machine that holds your Slack connection can send its replies, because that connection lives on that one machine.

Today, if something tries to move a Slack conversation, either you from the dashboard or the agent itself when one machine gets too busy, the move half-happens. The new machine thinks it owns the conversation, but the old session never stops. You end up with two sessions answering the same Slack conversation.

This change refuses that move up front, in every place a move can start. You get a plain sentence: "This Slack conversation stays on the machine that holds your Slack connection." The phone and the dashboard show the same sentence where the Move option would be. Nothing else about Slack changes.

What you need to decide: nothing.
