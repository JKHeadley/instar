## What Changed

- Topics you create or rename in Telegram now get their real name on the agent's server even when its lifeline does the Telegram polling. Before, the lifeline dropped the text-less "topic created/renamed" message, so those conversations showed as "Conversation name unavailable".

## What to Tell Your User

New topics show their real names on the dashboard. Topics created recently pick up their name the next time a message is sent in them.

## Evidence

- On a live agent, four topics created that day showed as "Conversation name unavailable"; no machine had their names. Unit tests cover the lifeline forwarding a created/renamed name; route tests cover recording it and refusing an empty message that is not a name-only update.

## Summary of New Capabilities

None. This fixes topic naming.
