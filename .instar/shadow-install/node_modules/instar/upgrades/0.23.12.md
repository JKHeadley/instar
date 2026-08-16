# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

Added sleep/wake recovery infrastructure for macOS environments. When a machine sleeps and wakes, SQLite WAL locks can go stale and tunnel connections drop silently. This release adds:

- **WAL checkpoint methods** on TopicMemory and SemanticMemory — `checkpoint()` flushes stale WAL locks after macOS sleep/wake, preventing "database is locked" errors that previously required manual restart.
- **TunnelManager recovery** — `forceStop()` cleanly tears down zombie tunnel processes, and `enableAutoReconnect()` provides exponential-backoff reconnection when tunnels drop during sleep/wake cycles.
- **TelegramAdapter resilience** — catches silent connection failures from the Telegram API that occur after network state changes, with automatic retry logic.

These changes target the most common failure mode for agents running on developer laptops: machine sleep causing cascading failures across memory, tunnels, and messaging.

## What to Tell Your User

- **Sleep/wake recovery**: "If your machine goes to sleep and wakes back up, I can now recover automatically — my database connections, tunnels, and messaging all reconnect without needing a restart."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| WAL checkpoint after sleep/wake | Automatic — called by StallTriageNurse on stall detection |
| Tunnel auto-reconnect | Automatic with exponential backoff |
| Tunnel force-stop | Available via TunnelManager API for manual recovery |
| Telegram silent-failure catch | Automatic — adapter retries on connection loss |
