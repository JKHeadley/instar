---
title: Paste Handling
description: Lifecycle management for user-submitted paste content.
---

When a user pastes a large chunk of text into a Telegram or Slack conversation, instar treats it as a first-class artifact rather than just dropping it into the chat. The paste lifecycle has its own subsystem so context truncation, retrieval, and re-injection on demand all work cleanly.

## Components

- **`PasteManager`** — primary lifecycle owner. Stores pastes with metadata (source channel, timestamp, sender, byte size), assigns a paste ID, and serves retrievals on demand. Pastes are stored on disk in `.instar/pastes/` so they survive session compactions and server restarts.
- **`TruncationDetector`** — watches inbound messages for the heuristics that indicate a message is actually a paste rather than a typed reply (length thresholds, structural markers like code fences, formatting that suggests copy-paste). When detection fires, the paste enters its own lifecycle rather than competing for the conversation's main context budget.

## How pastes flow through a session

1. User pastes a 50 KB chunk into a Telegram topic.
2. `TruncationDetector` flags it; the adapter routes the full content to `PasteManager` and shows the agent a short summary plus a paste ID instead of the full text.
3. Agent reads the summary, decides what it needs, and pulls the full content via the paste API when relevant.
4. Pastes older than the configured retention window get pruned during the next maintenance pass.

This is what keeps long-lived conversations from accumulating multi-megabyte context bloat. The first time the agent needs the full paste, it pulls it; otherwise the summary is enough.

## API

| Endpoint | Description |
|----------|-------------|
| `GET /pastes` | List paste records with metadata |
| `GET /pastes/:id` | Retrieve a specific paste's full content |
| `POST /pastes` | Submit a paste programmatically (used by the adapters internally) |
| `DELETE /pastes/:id` | Remove a paste |

## When to interact with this directly

Most agents don't. The paste subsystem is plumbing. The two cases where it matters:

- **Debugging a "where did my long message go" moment** — `GET /pastes` shows the recent paste records and confirms the message was captured.
- **Building a tool that explicitly needs paste content** — pull the paste by ID rather than relying on whatever truncated version landed in the session context.
