# ELI16 — Auto-restart when an MCP fails to load (no more manual blocker)

## The problem (today, 2026-06-02)
MCP tools (like Playwright) are configured but sometimes fail to register when a session boots — a transient launch race. When that happens, the agent finds the tools missing and treats it as a blocker, even though the fix is trivial and known: **restart the session, and the MCP re-launches and connects on retry** (proven live today — Playwright was unregistered, then came up "Connected" after one session refresh).

Justin's point: "that should be AUTOMATIC, a known protocol — not something I have to point out every time."

## The fix
A tiny new hook, `mcp-health-autorefresh.sh`, that the session-start hook fires **in the background** on every boot. On boot it:
1. Runs `claude mcp list` (which reports each server as `✓ Connected` / `✗ Failed to connect`).
2. If an **allowlisted** MCP (default: just `playwright`) shows `✗ Failed to connect`, it calls `/sessions/refresh` **once** — the session respawns with `--resume` (keeps the whole conversation) and the MCP re-registers.

So a missing MCP auto-heals instead of becoming a thing the agent flags at you.

## Why it can't go wrong (this is the important part — it restarts sessions)
- **Dark on production, live on dev agents.** It does nothing on a normal agent unless you opt in with `mcpAutoRefresh.enabled: true`. BUT an agent marked `developmentAgent: true` (echo — the dogfooding/proving ground) gets it **enabled by default** when the flag is unset. So "ships dark" means dark on the fleet but live on echo, which proves features first. An explicit `enabled: false` always wins (even on a dev agent).
- **Allowlisted.** It only ever restarts for servers you list (default `["playwright"]`). A random optional MCP failing can never trigger a restart.
- **Hard loop-guard.** It writes a marker keyed on (session, exact-failed-set). If the *same* MCP is still failing *after* one refresh, that's a persistent failure (not a transient race) — so it **refuses to refresh again** and just logs it. It can refresh **at most once per session** and can **never** restart-loop the fleet.
- **Backgrounded** — never blocks or slows a boot.

## How it's safe to ship
Built dark, with tests that lock the safety properties: the generated script is syntactically valid, and it's verified **inert** when there's no config / it's disabled / the allowlist is empty (no `claude` call, no refresh, no marker written). Reaches all agents via the always-overwrite hook migration, but stays off until explicitly enabled.

## How it gets enabled
- **Echo (dev agent):** automatic — `developmentAgent: true` in echo's config means it's enabled the moment this lands. No action needed; echo proves it live.
- **A production agent (later, after echo proves it):**
```json
// .instar/config.json
{ "mcpAutoRefresh": { "enabled": true, "servers": ["playwright"] } }
```
- **Force OFF anywhere** (even a dev agent): `{ "mcpAutoRefresh": { "enabled": false } }`.

## The general pattern (Justin's ask)
`developmentAgent` is a reusable label, not specific to this feature: any dark-by-default feature can resolve `explicitConfig ?? (developmentAgent ? enabled : dark)` so it ships live on echo and dark on the fleet. It is per-feature opt-in (a feature decides whether dev-default-enable is safe for it) — NOT a blanket "enable everything on dev".
