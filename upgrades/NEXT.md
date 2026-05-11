# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

New endpoint `POST /sessions/refresh` lets an agent trigger its own session respawn. The server saves the current Claude session UUID, kills the tmux session, and spawns a fresh one with `claude --resume <uuid>` — which attaches any MCP servers or skills installed mid-session while preserving full conversation state. The lifecycle is owned by the new `SessionRefresh` class in `src/core/SessionRefresh.ts`. The existing Telegram `/restart` command now delegates to the same orchestrator (behavior unchanged), consolidating kill+respawn logic in one place.

Rate-limited to 5 refreshes per 10-minute rolling window per session to prevent infinite respawn loops. The route returns `202 Accepted` immediately because the requester's process is the one being killed; the kill+spawn fires ~500ms after the response flushes. Validation rejects bad session names, oversized prompts, and oversized reason strings.

v1 scope is Telegram-bound sessions only. Non-Telegram-bound respawn returns `{ ok: false, code: 'not_telegram_bound' }` and is a v2 follow-up.

API:
- Request: `POST /sessions/refresh` with `{ sessionName: string, followUpPrompt?: string, reason?: string }`
- 202: `{ ok: true, message: 'Refresh scheduled', sessionName }`
- 400: invalid input
- 503: no Telegram adapter wired (v1 limitation)

## What to Tell Your User

- **Self-refresh after installing tools**: "I can now refresh myself to pick up new tools right after installing them. If I add a new capability mid-conversation, I'll quietly restart and pick up where we left off — no need for you to send another message just to wake me up."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Agent-initiated session refresh | POST /sessions/refresh |
