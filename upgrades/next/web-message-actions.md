<!-- bump: patch -->
## What Changed

The web conversation menu can show quoted Reply, React, and Forward for App messages. It uses the signed browser session and the server’s existing conversation action checks.

## What to Tell Your User

When your server enables the actions, open a message’s options to reply with a quote, react with an emoji, or copy a text message to another eligible conversation. A quote stays with your draft if the server refuses its original.

## Summary of New Capabilities

The web action controls require an affirmative capability from the server. Forward also requires matching custody for the two conversations. The current forwarding server branch still needs to publish that capability.

## Evidence

The browser fixture checks controls with capabilities absent and with fixture capabilities supplied. It checks the signed Reply, Reaction and Forward request shapes and the same-intent retry.
