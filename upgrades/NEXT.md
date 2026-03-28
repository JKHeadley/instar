# v0.24.18-beta.0 — Slack Messaging Adapter (Beta)

## What Changed

Native Slack support joins Telegram and WhatsApp as a first-class messaging adapter. Your agent can now live in Slack — receiving messages via Socket Mode, responding in channels, and managing conversations with the same features Telegram has.

This is a beta release for early testing. The core adapter is complete and working, with setup wizard support, session management, and feature parity across most Telegram capabilities.

## What to Tell Your User

Your agent can now talk to you through Slack. If you already use Slack for work, you can add it alongside Telegram — no need to switch. Setup takes about 5 minutes: you log into Slack, and the agent handles creating the workspace, app, and channels automatically.

Slack sessions show up in the dashboard with their own platform badge, and you can create new sessions linked to Slack channels right from the dashboard. Commands work with an exclamation mark prefix — type !sessions or !new in any channel the agent is in.

This also includes a new autonomous mode skill that lets the agent work independently for hours with structural enforcement — it literally cannot stop until the work is done.

## Summary of New Capabilities

- Slack messaging adapter with Socket Mode (real-time WebSocket, no webhooks needed)
- DIY app model — each user creates their own Slack app, no shared infrastructure
- Browser-automated setup wizard (Playwright drives workspace creation, app config, token extraction)
- Session channel registry with bidirectional channel-to-session mapping
- Channel resume map for conversation continuity across session restarts
- Attention channel for critical alerts (auto-created, users auto-invited)
- Dashboard link broadcast to Slack dashboard channel (update-in-place, no spam)
- Slash commands via ! prefix (!sessions, !new, !help)
- Platform badges on dashboard session cards
- Platform dropdown when creating new sessions
- Job scheduler integration (per-job Slack channels)
- Cross-platform alerts (Slack added alongside Telegram and WhatsApp)
- Presence proxy routing to correct session channels
- SlackLifeline process for persistent Socket Mode connection
- Autonomous mode skill with stop hook enforcement and session isolation
- Unanswered message detection in Slack context hook
- Message logging, search, and retention for Slack
