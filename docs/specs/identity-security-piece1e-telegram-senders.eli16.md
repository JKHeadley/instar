# Who can talk to your agent on Telegram — explained simply

Your agent has a list of people allowed to talk to it on Telegram. Two things were wrong with it.

First, if the list was empty, which it is on every new agent, the agent treated that as "everyone is allowed". Second, on most agents the Telegram messages come in through a small relay program, and on that path the list wasn't checked at all. So anyone who could message the agent's bot could reach a session, run a command, or even stop a session.

This change uses one rule everywhere. You (the owner), anyone on the list, and anyone you've added as a person on your agent can talk to it. Only you can use the controls that affect the whole agent, like switching accounts or restarting its relay. The person who runs a conversation can control that conversation.

Someone the agent can positively identify as not on the list is a stranger. Strangers can't reach a session, run commands or stop anything. They get one polite private reply, and you can let them in by sending /approve with the code the agent gives you. If the agent can't tell who someone is, it doesn't call them a stranger. It keeps handling them exactly as it does today.

Because this changes who can reach every agent, it starts gently. On test and development agents the rule is enforced. On everyone else's agents it only watches at first: it tells you once who would have been turned away, and you decide when to switch it on.
