# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

### Slack Messaging Adapter

Instar now includes a full Slack messaging adapter (`SlackAdapter`), enabling agents to send and receive messages via Slack workspaces. The adapter supports:

- Sending messages to channels and threads
- Token validation and secure credential handling
- Atomic write operations for message persistence
- CLI tooling for Slack interaction (`slack-cli`)
- Server-side routes for Slack webhook integration

The adapter follows the same pattern as existing messaging adapters (Telegram, WhatsApp) and plugs into the unified channel routing system.

### Server-Side Process Review Dashboard

A new Systems tab on the dashboard provides real-time visibility into server processes. This includes:

- Process telemetry collection and display
- Health status monitoring for running services
- Integration with the existing dashboard infrastructure

### Architecture Documentation

A new "Under the Hood" page on the documentation site explains Instar's internal architecture, giving developers and agents a clearer picture of how the system is structured.

### CI Stability Improvements

Several CI fixes improve reliability: resolved flaky test exclusions, fixed WhatsApp string test, added `skipStallClear` option to prevent stall-clear interference during topic sends, and fixed test failures blocking the push gate.

## What to Tell Your User

- **Slack support is here**: Your agent can now send and receive messages through Slack. If your team uses Slack, you can connect it as a messaging channel alongside Telegram and other platforms. Ask your agent to set it up for you.

- **Better visibility into what is running**: There is a new Systems tab on your dashboard that shows what server processes are active and their health status. Useful for troubleshooting if something feels off.

- **More reliable updates**: Several under-the-hood fixes make the CI pipeline more stable, which means smoother and more frequent releases going forward.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Slack messaging | Configure Slack token via CLI, then messages route automatically |
| Process review dashboard | Visit the Systems tab on your Instar dashboard |
| Architecture docs | Check the "Under the Hood" page on the docs site |
