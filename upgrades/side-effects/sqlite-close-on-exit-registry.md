# Side-effects review — SQLite close-on-exit registry (#680 Problem B)

**Spec:** `docs/specs/MULTI-MACHINE-LEASE-ROBUSTNESS-SPEC.md` §Problem B (converged 3 rounds, approved).
**Change:** a central `SqliteRegistry` (`registerSqliteHandle` / `closeAllSqlite` / `__resetSqliteRegistryForTests`); all 15 long-lived better-sqlite3 stores register their handle after open; `server.ts` closes every registered handle LAST on both exit paths (graceful shutdown + uncaughtException), replacing the hand-maintained 2-store close-list.

## What it touches
- **New module** `src/core/SqliteRegistry.ts` — pure, process-global singleton. No I/O, no deps.
- **15 store constructors** gain one `registerSqliteHandle(() => this.db?.close())` call after the db is open (StopGateDb, FeatureRegistry, PreferenceStore, SpawnLedger, RegistryStore, TokenLedger, CorrectionLedger, FailureLedger, FeatureMetricsLedger, FrameworkIssueLedger, TopicMemory, SemanticMemory, MessageProcessingLedger, pending-relay-store, iMessage NativeBackend). StopGateDb + PreferenceStore + SpawnLedger also unregister + (StopGateDb) gained a `_closed` idempotency guard.
- **`src/commands/server.ts`** — `shutdown()` gained a re-entrancy guard and now calls `closeAllSqlite()` after `server.stop()` (was: explicit `topicMemory?.close()` + `semanticMemory?.close()` before `server.stop()`); the `uncaughtException` handler calls `closeAllSqlite()`.

## Side effects & blast radius
- **Behavior change at exit only.** No runtime/request-path behavior changes — registration is a no-op at steady state; the only new work happens during process teardown.
- **Ordering moved:** SQLite now closes AFTER `server.stop()` (writers stopped first) instead of before. This is intentional and safer — no route can touch a closed handle because the HTTP server is already stopped. The sidecar flush (`sharedStateLedger.shutdown()`) still runs before the close so no write is lost.
- **Double-close safety:** better-sqlite3 `.close()` throws on an already-closed handle. The registry guards this three ways — unregister-before-explicit-close, an at-most-once closed-set, and a per-handle try/catch in `closeAllSqlite()` — so a store explicitly closed at runtime and then drained at exit cannot crash teardown.
- **Reopen safety:** TopicMemory + SemanticMemory reopen their handle on corruption recovery. The registered closeFn reads `this.db` live (not a captured ref), so the current handle is always the one closed.
- **Registration leak risk:** registration is fire-and-forget for most stores. These 15 are process-lifetime singletons (registered once), so the registry does not grow unboundedly. A store instantiated many times would accumulate entries — not the case for any of the 15.
- **Test isolation:** `__resetSqliteRegistryForTests()` clears BOTH the handle list and the closed-set (a half-reset would leak an "already closed" verdict between tests).

## What could go wrong (and why it won't break prod)
- If a store's closeFn threw, the old code would abort teardown — now each is wrapped best-effort, so one bad close cannot block the others (the whole point).
- The re-entrancy guard on `shutdown()` means a SIGINT+SIGTERM race (or restartDetected racing a signal) runs the resume-UUID save + flush once, not twice.
- No migration needed — ships in code, reaches existing agents on normal update. No config/route/schema change.

## Tests (3 tiers, all green)
- Unit `tests/unit/SqliteRegistry.test.ts` (6) — close-all, throwing-close-isolation, unregister, at-most-once, reset-clears-both.
- Wiring `tests/unit/SqliteRegistry-wiring.test.ts` (5) — static allowlist completeness (every long-lived store registers; every open-callsite accounted) + functional registration-fires.
- Lifecycle `tests/integration/sqlite-close-on-exit.test.ts` (7) — real better-sqlite3 handles actually close (`.open === false`); StopGateDb closed without throw; double-close safe; server.ts ordering (closeAllSqlite after server.stop; uncaughtException closes all; old 2-store list gone).
