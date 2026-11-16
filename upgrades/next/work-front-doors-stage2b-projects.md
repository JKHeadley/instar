# Projects the Chief of Staff tracks, offered in Conversations

<!-- bump: patch -->

## What Changed

Conversations' "Review suggestions" now offers each project the Chief of Staff tracks as a ready-made suggestion, "Project: <name>", with the project's conversation and the conversations under it. Accepting it creates a project in Conversations with that conversation as its front door, through the same owner steps as any accepted suggestion. With two or more, "Accept all N projects" accepts them one by one; stopping part-way leaves Continue, which also works from another tab or device. Nothing is organized until the owner accepts; a project whose conversation is already inside another project creates nothing; a rejection holds; a project no longer tracked is no longer offered.

## What to Tell Your User

- **Your projects in Conversations**: "The projects I'm tracking for you now show up in Conversations as suggestions. Accept them, one by one or all at once, and each becomes a project there with its own conversation as the front door. Nothing moves until you accept."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Projects as Conversations suggestions | Conversations → Review suggestions → Accept, or "Accept all N projects" |

## Evidence

- Unit: `tests/unit/conversation-graph-suggestions.test.ts`, `tests/unit/console-conversation-suggestions.test.ts`; e2e: `tests/e2e/conversation-graph-suggestions-alive.test.ts`.
