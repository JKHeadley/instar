# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Agent instructions now point to captured app, Telegram, and Slack conversation history when looking for earlier discussions. The same instructions reach existing agents through the CLAUDE.md migration. Memory and Telegram keyword searches now safely handle text containing dots, hyphens, and apostrophes.

## What to Tell Your User

"When you ask if we discussed something before, I will search the conversation history and check how much the search covered. Names such as instar.sh and IDs such as SEC-123 also work in the older memory and Telegram search routes."

## Summary of New Capabilities

The agent can look up captured discussions across machines using the conversation search route.

## Evidence

Regression coverage in memory-index, semantic-memory, topic-memory, and conversation-search-guidance unit tests, plus the Telegram search HTTP and CLAUDE.md reference-layout tests.
