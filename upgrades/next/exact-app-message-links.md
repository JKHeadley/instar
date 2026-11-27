# Exact App message links

## What Changed

The dashboard and signed app clients can resolve a link to a specific App message. The link opens that message and older context directly. A message that the reader cannot access has the same response as a message missing from the serving copy.

## What to Tell Your User

When this is enabled, use Copy Message Link from a message’s options. Anyone opening the link needs their own access to that conversation and message.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Copy a link to one App message | Choose Copy Message Link from the message's options, once the feature is on. |
| Open a message link | The link opens that message with the older context around it; the reader needs their own access to the conversation. |

## Configuration

The feature starts off. The setting is `mobilePairing.native.messageLinks.enabled`. Copying requires a configured shareable HTTPS origin. Links can be disabled without changing ordinary conversation history or pin navigation.
