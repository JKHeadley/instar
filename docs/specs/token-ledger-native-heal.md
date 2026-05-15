---
slug: token-ledger-native-heal
review-convergence: converged
approved: true
approved-by: justin
iterations: 1
---

# Token Ledger Native-Module Heal — Restore `/tokens/*` Endpoints

## Problem

`TokenLedger.init` has been silently failing for 2+ days on every instar agent on this machine. The `server.log` shows:

```
[instar] token-ledger init failed (non-fatal): Error: The module
'/Users/.../shadow-install/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using NODE_MODULE_VERSION ...
```

Consequence: `/tokens/summary`, `/tokens/by-project`, `/tokens/sessions`, `/tokens/orphans` all return `{"error":"token ledger unavailable"}`. The Dashboard "Tokens" tab shows nothing live. The exact observability we just built (PR #112, 2026-05-14) to detect the bleeding pattern is itself blind on the machine that needs it most.

Root cause: a Node upgrade after instar installed left the better-sqlite3 prebuilt binding ABI-mismatched. The `ServerSupervisor.preflightSelfHeal` runs `npm rebuild better-sqlite3` for the supervisor-spawn path, but the TokenLedger is initialized later, from the AgentServer constructor, after preflight has already passed. The supervisor path heals supervisor-substrate; it does not heal the token ledger's own construction. So even with PROP-399's `NativeModuleHealer` in tree, TokenLedger.ts was bypassing it.

## Root Cause

`src/monitoring/TokenLedger.ts` line ~197 (origin/main):

```typescript
this.db = new Database(opts.dbPath);
```

Raw `new Database()` call. When the prebuilt binding throws `NODE_MODULE_VERSION`, the AgentServer's outer try/catch swallows it as a non-fatal warning and sets `tokenLedger = null`. The error is logged once at startup, then the ledger is silently absent for the entire process lifetime. The dashboard, the API endpoints, and any automated detector that would catch the token-burn pattern lose their data source.

The `NativeModuleHealer` already lives at `src/memory/NativeModuleHealer.ts` (landed via PROP-399 + W-1). It has an `openWithHeal()` async surface used by `SemanticMemory`, `TopicMemory`, and `MemoryIndex` — but its API is async, and TokenLedger's constructor is sync. The healer's internals are all sync (spawnSync, fs.appendFileSync), so the async decoration is gratuitous — but the existing public surface forces async/await on call sites.

## Fix

Two-layer:

1. **`NativeModuleHealer.openWithHealSync<T>(component, opener)`** — sync mirror of the existing `openWithHeal()`. Same heal semantics: catch NODE_MODULE_VERSION → `npm rebuild better-sqlite3 --prefix <install_prefix>` synchronously → clear better-sqlite3 require cache → retry opener once. Backed by a new `healBetterSqlite3Sync()` that the existing async `healBetterSqlite3` now delegates to. Zero behavior change for existing async call sites.

2. **TokenLedger constructor uses `openWithHealSync`** — wraps `new Database(opts.dbPath)` in the healer. AgentServer additionally calls `NativeModuleHealer.configure({ stateDir })` before constructing the ledger so heal events log to `<stateDir>/native-module-heals.jsonl` rather than the os-tmp fallback.

The fix is purely additive: existing async callers (SemanticMemory et al.) are untouched. The token ledger constructor gains a heal-on-throw safety net that previously only the memory subsystem had. The heal runs at most once per process (existing healer guard), so the rebuild can't pathologically loop.

## Acceptance Criteria

1. `TokenLedger` constructor wraps `new Database(...)` in `NativeModuleHealer.openWithHealSync('TokenLedger', () => new Database(...))`.
2. `NativeModuleHealer.openWithHealSync<T>(component, opener: () => T): T` exists, behaves like `openWithHeal` for the success / non-mismatch-error / heal-on-mismatch / no-retry-after-failed-heal / heal-then-retry paths.
3. `NativeModuleHealer.healBetterSqlite3Sync()` is the canonical sync rebuild surface; async `healBetterSqlite3` is now a thin wrapper.
4. AgentServer calls `NativeModuleHealer.configure({ stateDir })` before TokenLedger init so heal events land in the agent's state directory.
5. Existing healer tests (28) keep passing unchanged.
6. New regression tests cover: `openWithHealSync` success / non-mismatch passthrough / heal-failure / heal-then-retry / no-retry-after-prior-failure (5 cases). One TokenLedger regression test pins that the constructor routes through the healer.
7. After a publish + agent upgrade with a known-broken better-sqlite3 binding present, `/tokens/summary` returns live data instead of `{"error":"token ledger unavailable"}`.

## Decision Points (signal vs authority)

The `NativeModuleHealer` is an authority over native-module rebuilds — its sync surface is a mechanical extension of the existing async surface. Adding `openWithHealSync` does not change WHO has the authority to rebuild (the healer does), only HOW the surface is consumed. The new heal call site in TokenLedger is identical in shape to existing healer integrations in `SemanticMemory.open`. Compliant with `docs/signal-vs-authority.md`.

## Rollback

Revert four files (`src/memory/NativeModuleHealer.ts`, `src/server/AgentServer.ts`, `src/monitoring/TokenLedger.ts`, plus the test files), ship a patch release. No persistent state, no migration, no API contract change. Estimated 10 minutes from detection to revert. The TokenLedger remains usable on any platform where better-sqlite3's prebuilt binding matches the installed Node ABI (the common case); the only path affected is the post-Node-upgrade ABI-mismatch case.

## Side-Effects Review

`upgrades/side-effects/token-ledger-native-heal.md` — covers the seven gate questions plus second-pass reviewer concurrence.

## Convergence Notes

Single-iteration. Conversational alignment with Justin on Telegram topic 8615 (2026-05-15, immediately following the PromptGate token-burn fix) established the scope: "restore /tokens/* endpoints by adopting the existing healer." The PROP-399 design and W-1 extension already cover the cryptographic surface; this PR is a pure consumer-side addition.
