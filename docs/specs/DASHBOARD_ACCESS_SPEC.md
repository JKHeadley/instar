# Dashboard Access Topic — Spec

> Always-available dashboard link via a dedicated Telegram topic.

## Problem

Users lose access to their agent dashboard because:
1. **Quick tunnel URLs are ephemeral** — every server restart generates a new random URL
2. **No discovery mechanism** — even when the URL is stable, there's no obvious place to find it
3. **The dashboard is the primary way to watch live sessions** — losing access means losing visibility

## Solution

A dedicated **"Dashboard" Telegram topic** that:
- Auto-creates on first server start
- Auto-posts the current dashboard URL whenever the tunnel comes up or changes
- Pins the latest link message for instant access
- Recommends named tunnel setup for a permanent URL

## User Experience

### First Install (Quick Tunnel)

After setup completes and the server starts:

```
📊 Dashboard

Your agent dashboard is live:
https://random-word-combo.trycloudflare.com/dashboard

PIN: [dashboardPin from config]

Note: This link changes when your server restarts.
For a permanent link, ask me to set up a named tunnel.
```

### Server Restart (Quick Tunnel)

Each restart posts a new message and pins it:

```
📊 Dashboard (updated)

New link: https://different-words.trycloudflare.com/dashboard
PIN: [same pin]
```

The old message stays for history. The new one gets pinned.

### Named Tunnel (Persistent)

If the user sets up a named tunnel, the URL never changes. The topic posts once:

```
📊 Dashboard

Your permanent dashboard link:
https://dashboard.yourdomain.com/dashboard

PIN: [pin]

This link is permanent — it won't change on restart.
```

On server restart with a named tunnel, no new message needed (URL is the same). Optionally post a brief "Server restarted — dashboard is back online."

## Architecture

### Components

#### 1. Dashboard Topic (Auto-Created)

- **Created by**: Server startup, before tunnel starts
- **Name**: "Dashboard" (with color icon — suggest blue: 7322096)
- **Topic ID**: Persisted in config.json under `messaging[].config.dashboardTopicId`
- **Pattern**: Same as lifeline topic — `findOrCreateForumTopic()` with persistence

#### 2. URL Broadcast Hook (TunnelManager → TelegramAdapter)

After tunnel connects and URL is captured:

```typescript
// In server.ts startup sequence, after tunnel.start():
if (tunnel?.url && telegram) {
  await broadcastDashboardUrl(telegram, config, tunnel.url, tunnel.state.type);
}
```

The broadcast function:
1. Reads `dashboardTopicId` from config
2. Sends formatted message with URL + PIN
3. Pins the message (Telegram API: `pinChatMessage`)
4. Unpins previous dashboard messages first (keep topic clean)

#### 3. Named Tunnel Setup Guidance

When a user asks about permanent links, the agent should:
1. Check if they have a domain (or help them get one)
2. Walk through Cloudflare Zero Trust tunnel creation
3. Help them create a tunnel token
4. Update config: `tunnel.type: 'named'`, `tunnel.token: '<token>'`
5. Restart server to apply

This guidance lives in the agent's awareness (CLAUDE.md template), not in a separate skill — it's conversational, not a phase gate.

### Data Flow

```
Server starts
  → HTTP server binds to port
  → Dashboard topic ensured (findOrCreateForumTopic)
  → Tunnel starts
  → URL captured
  → broadcastDashboardUrl(telegram, config, url, type)
    → Format message (URL + PIN + tunnel type note)
    → sendToTopic(dashboardTopicId, message)
    → pinChatMessage(dashboardTopicId, messageId)
  → Server ready
```

### Config Changes

```typescript
// In TelegramConfig (existing messaging config)
interface TelegramConfig {
  // ... existing fields
  dashboardTopicId?: number;  // Auto-populated on first run
}
```

No user configuration needed. The topic is auto-created and the ID is auto-persisted.

### PIN Handling

The dashboard PIN is already in config (`dashboardPin`). The broadcast message includes it so users can unlock immediately from the Telegram link. This is acceptable because:
- The Telegram group is private (only the user + bot)
- The PIN is already stored in plaintext in config.json
- Convenience > marginal security for a local agent dashboard

If the user has concerns, they can set a stronger PIN or use named tunnel with additional auth.

## Named Tunnel Setup Flow

For users who want a permanent URL:

### Prerequisites
- A domain (any registrar)
- A free Cloudflare account
- DNS pointed to Cloudflare (or using Cloudflare as registrar)

### Steps (Agent-Guided)

1. **Create Cloudflare tunnel**: Agent guides user through `cloudflared tunnel create <name>`
2. **Configure DNS**: Agent helps add CNAME record pointing to tunnel
3. **Get tunnel token**: `cloudflared tunnel token <name>`
4. **Update config**: Agent writes `tunnel.type: 'named'` and `tunnel.token` to config
5. **Restart**: Agent restarts server, confirms persistent URL works

### Without a Domain

If the user doesn't have a domain, they still get the auto-broadcasting quick tunnel. The agent should mention:
- Domains are cheap ($10-15/year for .com)
- Cloudflare offers free domains through their registrar
- The quick tunnel works fine — they just need to check the Dashboard topic for the latest link

## Implementation Plan

### Phase 1: Dashboard Topic + URL Broadcast
- Add `ensureDashboardTopic()` to server startup
- Add `broadcastDashboardUrl()` function
- Pin message on send
- Persist topic ID in config

### Phase 2: Named Tunnel Awareness
- Add named tunnel guidance to CLAUDE.md template
- Add tunnel configuration helpers (config update, restart)
- Detect named vs quick and adjust message accordingly

### Phase 3: Health Status (Future)
- Periodic health heartbeat to dashboard topic (optional)
- "Server went offline" / "Server back online" messages
- Uptime tracking visible in topic

## Edge Cases

- **No Telegram configured**: Skip dashboard topic entirely. Dashboard still accessible via `localhost:PORT/dashboard`.
- **Tunnel disabled**: Post local-only URL to topic: `http://localhost:PORT/dashboard`. Note it's only accessible from this machine.
- **Tunnel fails to start**: Post to topic: "Dashboard is available locally at http://localhost:PORT/dashboard. Remote access isn't working — check your internet connection."
- **Topic deleted by user**: Re-create on next restart (same pattern as lifeline topic).
- **Multiple restarts in quick succession**: Each posts a new URL. Only the latest is pinned. Topic accumulates history but stays clean at the top.
