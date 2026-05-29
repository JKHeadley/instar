# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Fixes a native-module self-heal bug where only the FIRST sqlite-backed subsystem recovered after a Node upgrade.**

`NativeModuleHealer` rebuilds the `better-sqlite3` native binding at most once per process when it sees a `NODE_MODULE_VERSION` mismatch (a Node upgrade landing after install). That once-per-process guard (`healAttempted`) was too coarse: once the first subsystem to open SQLite (e.g. `SemanticMemory`) healed successfully and consumed the single rebuild, every *later* subsystem (`TokenLedger`, `TopicMemory`, `MemoryIndex`) that hit the same mismatch was short-circuited with `throw "(heal previously attempted)"` — even though the binding on disk was already rebuilt and a cheap re-open would have succeeded.

Surfaced live while dogfooding the Codey agent (Telegram topic 13435): `/memory/search` returned 200 while `/tokens/summary` returned 503 (`token ledger unavailable`), with the binding on disk already ABI-correct and the heal log empty.

The fix branches the `healAttempted` block on the prior outcome (`this.lastResult.success`): when a prior heal **succeeded**, the later caller clears its stale cached binding and retries the open once (no second rebuild); when a prior heal **failed**, it throws with the existing failure context (unchanged). Applied to both `openWithHeal` (async) and `openWithHealSync` (sync). This finishes AC#7 of the approved `token-ledger-native-heal` spec.

## What to Tell Your User

If your agent ran for a while with its token usage tab or other SQLite-backed features showing as unavailable after a Node version upgrade, this fixes it. The agent already knew how to repair the underlying database driver automatically, but a safety limit meant only the first feature to ask for a repair actually got fixed — anything that asked afterward was told "already repaired once" and stayed dark until the next restart, even though the repair had already worked. Now every SQLite-backed feature comes back together, not just whichever one happened to start first. Nothing for you to do; it takes effect the next time the agent restarts onto this version.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Shared prior-heal retry | Automatic. After the native-module healer rebuilds the better-sqlite3 binding once per process, any later SQLite subsystem that hits the version mismatch now clears its stale cache and retries the open (no second rebuild) instead of failing. No config. |

## Evidence

- Unit: `tests/unit/NativeModuleHealer.test.ts` — new `shared prior heal — multi-subsystem recovery` block: prior-success → cache-clear + retry succeeds with NO second rebuild (sync + async); prior-failure → still throws and does not retry (both sides of the boundary); a persistent post-retry failure surfaces the original error directly. All 21 healer tests + 56 adjacent healer/ledger/runbook tests pass.
- Live diagnosis: on the Codey agent, `/memory/search` 200 vs `/tokens/summary` 503 with an ABI-correct on-disk binding and empty heal log; server-stderr showed `NODE_MODULE_VERSION 141 … requires 127 … (heal previously attempted)` at `TokenLedger.js` open — the exact short-circuit this fix removes.

Spec: `docs/specs/token-ledger-native-heal.md` (2026-05-29 amendment — in-scope, finishes AC#7).
