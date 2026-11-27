# Slack channel titles start with "#", DMs never do: Plain-English Overview

> The one-line version: in the dashboard and the iPhone app, a Slack channel's conversation is now titled "#dcproof-test", the way Slack shows it. A direct message or a group direct message never gets a "#".

## What was wrong

After the Slack names fix (#2974), a channel conversation took its title from the name Slack gave the channel. The title showed that name as it was, for example "dcproof-test" without the "#" that Slack itself puts in front of every channel. The "#" only appeared when the agent had no name yet and showed the channel's id ("#C0CG1C62HUL"). A DM was also handled badly: before its name was known, it was shown as "#D0..." with a "#", which Slack never does for a DM.

## What changes

- When the agent asks Slack about a conversation, it now also notes what kind it is: a channel (public or private), a direct message, or a group direct message. Slack tells it this in the same answer, so no extra call is made.
- A channel's title is "#" plus its name. If the name already starts with "#", it does not get a second one.
- A DM or a group DM is titled by its name with no "#". An id that starts with "D" is always a DM, so it is right even before Slack answers. A group DM's name starts with "mpdm-", which also identifies it before Slack answers.
- A thread still says "(thread)" after the title.

## Safeguards

- The title never waits for Slack. Until Slack answers, the kind is read from the id and the name.
- For a DM, the agent no longer asks Slack for a channel name it does not have. That stops the needless "could not resolve the channel name" warning for every DM.

## What to decide

Nothing. The operator's agent (Echo) already chose this rule: "#" for channels, public and private, never for DMs or group DMs, the way Slack shows them.
