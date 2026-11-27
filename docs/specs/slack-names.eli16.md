# Slack shows people's names, not their ids — Plain-English Overview

> The one-line version: in Slack conversations the dashboard and the iPhone app now show who wrote each message ("Gear Test") and the channel's name ("#dcproof-test"). Before, they showed Slack's internal ids ("U0CFA03N5QF", "#C0CG1C62HUL") or just "Someone".

## What was wrong

The agent asks Slack for a person's name with `users.info` and for a channel's name with `conversations.info`. It sent those questions in a format (JSON) that these particular Slack methods do not read. Slack answered as if no person or channel had been named, and the agent quietly fell back to showing the raw id. This affected every agent connected to Slack, in every place it shows a Slack name. Three related lookups had the same problem: a thread's replies, a channel's members and a file's details. The live proof of the dashboard Conversations page (#2966) found it, in a Slack test workspace whose app did have permission to read names.

## What changes

- Those five Slack methods are now asked in the format they read (form encoding). Every other Slack call stays exactly as it was.
- The conversation history shows the person's name on each message. That includes messages from someone the agent only saw in the channel and never logged, and messages logged earlier with the id as the "name".
- A Slack conversation is titled with its channel name.
- When a name cannot be found, the id is still shown, but the agent now writes the reason to its log once an hour, instead of failing silently.

## Safeguards

- Names are looked up once and kept for a few minutes (people) or an hour (channels), so a busy conversation does not flood Slack.
- The history read never waits on Slack: a name it does not have yet shows on the next refresh, a few seconds later.
- A name someone gave the conversation still comes first; the channel name is only the fallback for the title.

## What you need to decide

Nothing. Echo asked for this fix (fb-4db533fa-9d9) before #2966 counts as done.
