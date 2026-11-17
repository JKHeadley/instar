# WhatsApp: direct-message senders are identified from WhatsApp's own data

## What Changed

WhatsApp can deliver a direct chat under an internal "linked identity" id (`@lid` or `@hosted.lid`) that carries no phone number. The adapter now works out who sent such a message from facts WhatsApp supplies: the chat's phone-number alias when WhatsApp provides one, or, for the connected account itself, the account's own chat (a message the owner sends to someone else is no longer read as a command to the agent). A message whose sender cannot be identified this way is dropped, like any message from an unauthorized contact. A phone number is never derived from the linked-identity digits. The Baileys backend now passes the account's own linked identity to the adapter when it connects.

## What to Tell Your User

Nothing changes in normal use. Messages to yourself and messages from contacts you have authorized keep working.

## Summary of New Capabilities

None. Security hardening of how WhatsApp senders are identified.
