# Upgrade Guide — slack-names

## What Changed

Slack conversations show people's names and channel names instead of raw ids. The cause: `users.info`, `conversations.info`, `conversations.replies`, `conversations.members` and `files.info` do not read a JSON body, so every name lookup failed and the id was shown instead. The Slack client now sends those five methods form-encoded; every other call is unchanged. The app's Slack history fills each message's `senderName` from a cached `users.info` lookup, including messages logged earlier with the id as the name, and a Slack conversation's title is its channel name. A name that still cannot be found shows the id, and the reason is written to the log once an hour instead of failing silently. Thread replies, channel members and file details, which failed the same way, now work too.

## What to Tell Your User

In Slack conversations, in the dashboard and in the Instar app, you now see who wrote each message and the channel's name, not codes like U0CFA03N5QF.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Slack names in conversations | Automatic |
| Slack channel names as titles | Automatic |

## Evidence

`tests/unit/slack-names.test.ts` covers the request encoding, names on logged and unlogged rows, the channel title, and that a failed lookup is logged with its reason. Checked against the live Slack API with a scoped test app: with JSON, `users.info` answered `user_not_found` and `conversations.info` answered `invalid_arguments`; with form encoding both answered ok, with "Gear Test" and "dcproof-test".
