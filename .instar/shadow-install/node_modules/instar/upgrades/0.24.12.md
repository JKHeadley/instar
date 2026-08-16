# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **Fix: User messages lost when Lifeline forwards** — When Lifeline won the Telegram polling race (during startup, sleep/wake, or server restarts), it consumed user messages and forwarded them via `/internal/telegram-forward`. That route delivered messages to sessions but never logged them to JSONL or TopicMemory. Agent responses were still logged, creating one-sided conversation histories. The forward route now records inbound messages before routing them.

## What to Tell Your User

- **Bug fix**: "Your messages in topic history should now be complete. There was a bug where messages forwarded by Lifeline weren't being saved to conversation memory — so the agent could respond to you, but the history only showed the agent's side. This is fixed now."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Lifeline message logging | Automatic — no action needed |
