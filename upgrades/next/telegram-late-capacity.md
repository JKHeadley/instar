<!-- bump: patch -->
## What Changed

Ordinary Telegram sends now acquire the credential owner's short-lived capacity after durable dispatch recording, immediately before the network call. Previously, slow recording could use up the grant's lifetime before the request reached Telegram.

The shared rate limit, lease checks, single-use grants and original recovery bounds remain in force. A capacity refusal at this later point counts as a known failed attempt on the existing message and retains the existing retry delay. Persistent saturation can exhaust that message's attempt budget without a network call.

## What to Tell Your User

Slow message recording could make a send permission expire before Instar used it. This patch requests that permission after recording finishes. A held message still needs capacity from its current owner; queued custody does not guarantee delivery.

## Summary of New Capabilities

This repairs existing delivery timing and needs no new setting. Existing agents receive the updated explanation during migration. Do not recreate held messages to bypass their recovery limits.
