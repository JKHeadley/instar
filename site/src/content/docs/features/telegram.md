---
title: Telegram Integration
description: Two-way messaging via Telegram forum topics.
---

Telegram is the primary communication channel between you and your agent. Every conversation, every job, every alert flows through Telegram topics.

## Setup

The setup wizard walks you through creating a Telegram bot and connecting it:

```bash
npx instar
# Choose Telegram when prompted for messaging
```

Or add Telegram to an existing agent:

```bash
instar add telegram --token BOT_TOKEN --chat-id CHAT_ID
```

## How It Works

- **Send a message in a topic** -- arrives in the corresponding Claude session
- **Agent responds** -- reply appears in Telegram
- **`/new`** -- creates a fresh topic with its own session
- Sessions auto-respawn with conversation history when they expire

## Topics as Dashboard

Your Telegram group becomes a living dashboard:

| Topic Type | Purpose |
|-----------|---------|
| Interactive topics | Your conversations with the agent |
| Job topics | Each scheduled job gets its own topic |
| Lifeline topic | Agent health status (green icon) |

## Session Continuity

When a session expires or is compacted, the agent re-spawns with:
- Conversation summary (rolling LLM-generated summaries)
- Recent messages (loaded from SQLite)
- Full identity context (AGENT.md, USER.md, MEMORY.md)

The agent picks up exactly where it left off.

## Markdown formatting

As of v1.1.0, your agent writes in GitHub-flavored markdown and the adapter converts to Telegram-safe HTML on send. This is the default — agents don't need to know anything about Telegram's HTML escaping rules; they write normal markdown and the formatter handles the conversion.

Five format modes are available, selected via the `telegramFormatMode` config key in `.instar/config.json`:

| Mode | Behavior |
|------|----------|
| `markdown` (default) | GFM input → Telegram HTML output. Code fences, headings, lists, links, bold/italic all convert. |
| `html` | Caller produces Telegram HTML directly. The formatter passes through, escaping only what the caller missed. |
| `plain` | Strip all formatting. Useful for log forwarding. |
| `code` | Wrap entire message in a single code block. Useful for raw output. |
| `legacy-passthrough` | Byte-for-byte rollback to pre-v1.1.0 behavior. The adapter sends exactly what the caller produces. Use this if you have callers that already format for Telegram and you want to verify nothing else has changed. |

Individual callers can override the global mode by passing `_formatMode: 'html'` in the message payload — useful for cases where you've already produced Telegram HTML and want to skip the conversion.

The formatter also enforces a 32 KB input cap (`MAX_INPUT_LENGTH`). Messages above the cap silently downgrade to plain mode so the send still succeeds.

If you set `telegramAdapter.lintStrict: true` in config, formatting issues that the formatter would normally swallow (broken markdown, escaped-character mismatches) instead block the send and surface as a structured error.

## Voice transcription

Inbound voice messages are auto-transcribed via your configured voice provider. The adapter auto-detects which provider to use if `voiceProvider` isn't set explicitly.

## API

```bash
# List topic-session mappings
curl localhost:4040/telegram/topics

# Create a new forum topic (used by /new conversational flows)
curl -X POST localhost:4040/telegram/topics \
  -H 'Authorization: Bearer TOKEN' \
  -d '{"name": "deploy-status", "firstMessage": "Tracking the v1.2 rollout here"}'

# Send a message to a topic
curl -X POST localhost:4040/telegram/reply/TOPIC_ID \
  -H 'Authorization: Bearer TOKEN' \
  -d '{"text": "Hello from the API"}'

# Topic message history
curl localhost:4040/telegram/topics/TOPIC_ID/messages?limit=20

# Broadcast a status update across topics
curl -X POST localhost:4040/telegram/post-update \
  -H 'Authorization: Bearer TOKEN' \
  -d '{"text": "Deploy complete", "topicFilter": "deploy-*"}'

# Full-text search across topic history
curl 'localhost:4040/telegram/search?q=deploy&limit=20'

# Outbound message audit log statistics
curl localhost:4040/telegram/log-stats
```
