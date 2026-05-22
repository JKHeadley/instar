---
title: WhatsApp Integration
description: Full WhatsApp messaging via local Baileys library.
---

WhatsApp integration provides two-way messaging without cloud dependencies. Built on the Baileys library for local, direct WhatsApp Web connections.

## Features

- **Two-way messaging** -- Send and receive messages
- **Typing indicators** -- Shows the agent is "typing"
- **Read receipts** -- Messages are marked as read
- **Acknowledgment reactions** -- Quick feedback on received messages
- **QR code pairing** -- Scan from the web dashboard for remote setup
- **No cloud dependency** -- Direct local connection, no Meta Business API

## Setup

The setup wizard offers WhatsApp as a messaging option:

```bash
npx instar
# Choose WhatsApp when prompted
# Scan the QR code with your phone
```

## How It Works

WhatsApp messages are routed to Claude Code sessions the same way Telegram messages are. The agent responds naturally, and replies appear in WhatsApp.

The key difference from Telegram: WhatsApp doesn't have forum topics, so conversations are threaded per-contact internally rather than per-topic. Each authorized sender gets their own session with full conversation history. Group conversations get a separate session per group, configurable for the activation policy.

## Backend choice: Baileys or Business API

Two backends ship in the same adapter:

| Backend | Cost | Connection | Best for |
|---------|------|-----------|----------|
| `baileys` (default) | Free | QR code, local WhatsApp Web bridge | Personal use, small numbers of senders, no Meta Business account |
| `business-api` | Paid | Webhook with Meta-issued bot tokens | Production scale, team accounts, no QR-scan friction |

Configure via the `backend` key in the WhatsApp adapter config. Baileys is the default because it works with zero account setup.

## Direct message trigger modes

Authorized DMs respect a configurable trigger:

| Mode | Behavior |
|------|----------|
| `always` (default) | Every DM from an authorized sender arrives at the session |
| `mention` | Only DMs that mention the bot arrive — useful when sharing DMs but only addressing the bot deliberately |
| `off` | DMs are dropped |

Set via `directMessageTrigger` in the WhatsApp adapter config.

## Group conversations

`WhatsAppGroupConfig` lets you opt the agent into specific groups with per-group activation modes (always-listen, mention-only, command-only). Groups not listed are ignored. See the [configuration reference](/reference/configuration) for the schema.

## API

WhatsApp uses Meta's webhook contract for inbound events rather than a separate set of REST routes. Outbound sends happen through the adapter's internal API — your agent doesn't typically need to call these directly.
