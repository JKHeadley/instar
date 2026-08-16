# Upgrade Guide — v0.24.20

<!-- bump: patch -->

## What Changed

### Fix: Slack Socket Mode Heartbeat Death Loop

The heartbeat timeout for Slack Socket Mode connections was 60 seconds — far too aggressive for quiet channels with no activity. This caused a connect-disconnect loop every ~90 seconds, dropping messages during reconnection windows. Increased to 5 minutes, which correctly detects zombie connections without false-positiving on idle channels.

### Slack Workspace Modes (Dedicated vs Shared)

SlackAdapter now supports two workspace modes:
- **dedicated** (default): Agent owns the workspace. Auto-joins all public channels, responds to all messages.
- **shared**: Agent is a guest in an existing workspace. Only responds to @mentions and DMs. Does not auto-join channels.

Configure via `slack.workspaceMode` in config. The `respondMode` and `autoJoinChannels` settings can also be set independently.

### Fix: GitSync Crash on Empty Repos

GitSync now handles repos with no commits (freshly `git init`'d). Previously, `rev-parse HEAD` would throw and crash the sync process.

### Fix: ServerSupervisor Grace Period After Restart

When the Supervisor starts and finds the server already running (e.g., after a Lifeline self-restart for an update), it now correctly sets `spawnedAt` and checks for planned-exit markers. This prevents false "server down" alerts during update transitions.

### Slack Image/Document Tags in Session Bootstrap

`[image:path]` and `[document:path]` tags in Slack messages are now transformed into explicit read instructions before being passed to Claude sessions, improving reliability of file handling.

### Browsable Stat Cards — Click Metrics to View Content

Stat cards in the Systems detail view are now interactive. When a metric maps to browsable content, clicking the card fetches and displays the actual data inline.

## What to Tell Your User

A few reliability fixes in this release. If you were having trouble with Slack integration (agent not responding, connection dropping), that's fixed now — the connection was being too aggressive about reconnecting. Also added support for "shared" workspace mode if you want to install an agent into an existing Slack workspace without it taking over every channel.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Slack workspace modes | Set `slack.workspaceMode: "shared"` for guest-in-existing-workspace behavior |
| Slack mention-only mode | Set `slack.respondMode: "mention-only"` to only respond to @mentions |
| Browsable stat cards | Click any stat card with browsable content to expand it inline |
