# After a sign-in key is fixed, every waiting person gets an answer — plain language

> When an agent's Claude key comes back, the people who wrote during the outage now get real replies, and "my operator has been told" is only said when someone actually was.

## The problem

We broke an agent's key on purpose and then fixed it. The agent noticed, told people, and restarted their conversations by itself. But only one person got an answer. The restarted conversations were not told how to reply, so they posted their Slack channel code as the message, and one of them reported "done" without answering anyone. Also, the warning to the operator went to a Slack channel nobody was in, while people were told "my operator has been told".

## What changes

- The Slack reply script now ignores a channel code typed out of habit, so it can never be sent as the reply.
- Each restarted conversation gets a copy of the messages that were waiting, plus the exact command to reply.
- A restart only counts once a real reply shows up (the agent's automatic "still working on it" notes don't count). If none shows up within 15 minutes, the person is asked to send again, and the miss is reported.
- The operator warning counts only if a person can see it. If the alert channel has none of the agent's people in it, each of them gets a direct message.

## What stays the same

How a dead key is detected, the backoff, and the restart itself are unchanged. Nothing is blocked or killed by the new checks.
