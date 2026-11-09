# Telegram test groups: say why a step failed

The agent can now make and remove Telegram test groups on the operator's own Telegram, through a browser it controls. On its
first real try this morning, the step that lists existing test groups failed, and all the agent got back was the word "list".
Telegram had actually given a precise reason, a short error code and name, but Instar threw it away before answering, so
nobody could tell what went wrong. This change keeps that code and name and includes them in the answer and in the log of
test-group actions. It only adds information: nothing about what the agent is allowed to do changes, no message text or
account details are included, and everything else works exactly as before. With the reason visible, the real failure can be
fixed next.

For the operator nothing changes on screen; this is for the agent and for whoever reads its logs.
