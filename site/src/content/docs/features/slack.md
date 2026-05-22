---
title: Slack Integration
description: Two-way messaging via Slack channels and DMs.
---

Slack is a first-class messaging channel for your agent. Channels and DMs both work, with full feature parity to the Telegram path — same routing semantics, same audit log, same outbound safety layer.

The Slack adapter has been shipping since v0.28.x. If you've been wondering why your agent has a Slack CLI but the README didn't mention it — that was a documentation gap, now closed.

## Setup

Add Slack to an existing agent via the conversational flow:

```bash
instar add slack
```

The wizard asks for your Slack workspace, walks you through creating a bot user, captures the bot and signing tokens, and verifies the channel mapping. Tokens land in `.instar/config.json` under the `messaging` array.

You can also configure Slack at setup time by selecting it from the messaging-channels menu in `npx instar`.

## How it works

Inbound messages from authorized channels and authorized DMs arrive at the agent's Slack webhook endpoint, get routed to the relevant Claude Code session, and the agent's reply flows back via the adapter's outbound API.

Each channel maps to its own session (analogous to Telegram topics → sessions). DMs from authorized senders map to their own per-sender session. Conversation history per channel and per DM is persisted in the message store so respawned sessions resume with full context.

## Channels and DMs

Authorized channels are listed in the Slack adapter config. Messages from non-authorized channels are dropped silently (fail-closed).

DMs respect a configurable trigger mode similar to WhatsApp:

| Mode | Behavior |
|------|----------|
| `always` | Every DM from an authorized sender arrives at the session |
| `mention` | Only DMs that mention the bot arrive — useful when you want the bot present in shared DMs but only addressed deliberately |
| `off` | DMs are dropped |

## CLI

The Slack adapter ships with a dedicated CLI for inspection and management:

```bash
instar slack-cli status        # Connection state, registered channels, recent activity
instar slack-cli channels      # List authorized channels and their session mappings
```

## API

The Slack adapter exposes eight HTTP routes for inbound delivery, outbound sending, and inspection. See the [API reference](/reference/api) for the full list, including the webhook endpoint that Slack delivers events to.

Outbound sends follow the same single-use send-token pattern as iMessage — the agent validates the recipient, gets a token, performs the send, and confirms delivery, so every send is auditable end-to-end.

## When to choose Slack vs Telegram

| Want | Pick |
|------|------|
| Forum-topic-style threading with one topic per concern | Telegram |
| Existing-team channels where your agent participates alongside humans | Slack |
| First-time setup with the least friction (no app store, no workspace admin) | Telegram |
| Channel ACLs that mirror your organization's existing permissions | Slack |

You can run both channels at the same time. Your agent picks up incoming messages from either and replies in the channel where the message originated.

## Configuration

Slack settings nest under the `messaging` array in `.instar/config.json`:

```json
{
  "messaging": [
    {
      "type": "slack",
      "enabled": true,
      "config": {
        "botToken": "xoxb-...",
        "signingSecret": "...",
        "authorizedChannels": ["C0123456789"],
        "authorizedDmSenders": ["U0987654321"],
        "directMessageTrigger": "always"
      }
    }
  ]
}
```

See the [configuration reference](/reference/configuration) for the full schema.
