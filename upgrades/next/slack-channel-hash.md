# Upgrade Guide — slack-channel-hash

## What Changed

A Slack conversation's title is written the way Slack writes it. A channel, public or private, is `#<name>`; a direct message or a group direct message is its name with no `#`. The Slack adapter records each conversation's kind from the `conversations.info` answer it already fetches for the channel name (`is_im`, `is_mpim`), and `slackConversationTitle` uses it. Until that answer arrives, an id starting with `D` is a DM and a name starting with `mpdm-` is a group DM. A DM no longer triggers a channel-name lookup warning.

## What to Tell Your User

Slack channels in the dashboard and the Instar app now show with a "#" in front, like "#general", just as in Slack. Direct messages show without one.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Slack-style channel titles | Automatic |

## Evidence

`tests/unit/slack-names.test.ts` covers the title for a public channel, a private channel, a DM and a group DM, with and without the kind known, and that the adapter records the kind from `conversations.info`. The test also checks that a DM logs no warning. On a throwaway agent connected to a real Slack test workspace, the dashboard showed "#dcproof-test" in the list and the header at 1280x728 and 390x844.
