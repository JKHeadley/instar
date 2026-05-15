# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

### fix(monitoring): token ledger heals better-sqlite3 ABI mismatch automatically

`TokenLedger` was silently failing to open its SQLite handle on agents where
Node had been upgraded after install. The prebuilt better-sqlite3 binding
threw `NODE_MODULE_VERSION`, `AgentServer`'s outer try/catch swallowed it as
a non-fatal warning, and the ledger came up `null` for the entire process —
on this machine alone, that meant the four `/tokens/*` endpoints and the
Dashboard "Tokens" tab had been returning the unavailable error for 2+ days
across every active agent.

The fix routes the better-sqlite3 open through the existing
`NativeModuleHealer` so the rebuild + retry path (already used by
`SemanticMemory`, `TopicMemory`, `MemoryIndex`) now also covers the token
ledger. New `NativeModuleHealer.openWithHealSync<T>(component, opener)`
sync surface gives the ledger's sync constructor a way to consume the
healer without becoming async. `AgentServer` configures the healer with
the agent's state directory before constructing the ledger so heal events
log to `<stateDir>/native-module-heals.jsonl` instead of the os-tmp
fallback.

Existing async `openWithHeal()` callers (the memory subsystem) are
unchanged — `healBetterSqlite3` is now a thin wrapper over a new
`healBetterSqlite3Sync` that both surfaces share. 6 new regression
tests (5 on the sync surface, 1 pinning that `TokenLedger` routes through
the healer); full suite passes 49/49 in the touched areas.

Spec: `docs/specs/token-ledger-native-heal.md`. Side-effects review:
`upgrades/side-effects/token-ledger-native-heal.md`. Second-pass reviewer
concurred — clear to ship.

## What to Tell Your User

**Token ledger comes back.** Every agent has a small token-usage ledger
that powers the "where are my tokens going" question — the Dashboard
Tokens tab and the API endpoints that show recent spend, top sessions,
and idle conversations. That ledger had been silently off on this
machine for the last two days because of a mismatch between the
installed Node version and the database driver's compiled binary. This
release wires the existing automatic-repair helper into the ledger's
startup path, so the next time the agent restarts after this upgrade,
the ledger checks itself, rebuilds the driver if needed, and the
endpoints start returning live data. No action required from you.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Automatic token-ledger native-module heal | automatic (runs at agent startup if the ledger fails to open with a Node version mismatch) |

## Evidence

The original failure surfaced as 28 occurrences of this exact warning in
`logs/server.log` between 2026-05-13 and 2026-05-15 across server restarts:

```
[instar] token-ledger init failed (non-fatal): Error: The module
'/Users/.../shadow-install/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using NODE_MODULE_VERSION ...
```

Live API check on Echo before fix:

```
$ curl http://localhost:4042/tokens/summary
{"error":"token ledger unavailable"}
```

After fix (verified post-publish + post-upgrade): `/tokens/summary` returns
the live JSON payload on Echo and at least one other agent on this machine.
Six new regression tests pin the routing so a future refactor cannot
silently regress to a bare `new Database()` call.
