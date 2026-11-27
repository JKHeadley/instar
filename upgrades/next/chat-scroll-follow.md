<!-- bump: patch -->
## What Changed

An incoming message follows the bottom of the conversation only when you were already there. When you’re reading earlier messages, the web console keeps your place and shows a New messages button.

## What to Tell Your User

Keep reading earlier messages when a new reply comes in. Select **New messages** when you’re ready to catch up.

## Summary of New Capabilities

A New messages button jumps to the latest messages in an open web conversation.

## Evidence

The rendered Chats test reproduces the jump on the baseline and covers preserving the reader's position, jumping on request, and following a tall new message from the bottom.
