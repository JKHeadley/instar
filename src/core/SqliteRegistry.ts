/**
 * SqliteRegistry — a central close-on-exit registry for every long-lived
 * better-sqlite3 database handle in the process.
 *
 * WHY THIS EXISTS (the bug it fixes):
 *   When the process calls `process.exit()`, any better-sqlite3 database left
 *   OPEN triggers a C++ static-destructor `std::mutex` lock during teardown
 *   (`__cxa_finalize_ranges → exit`), which fails with
 *   "mutex lock failed: Invalid argument" → std::terminate → SIGABRT. The
 *   process ABORTS instead of exiting cleanly, and on a crash-loop it never
 *   recovers. The codebase already knew this and closed TWO stores
 *   (topicMemory, semanticMemory) before exit — but there are FIFTEEN
 *   long-lived stores. Any of the other thirteen left open still aborts.
 *
 * THE STRUCTURAL FIX (Structure > Willpower):
 *   Every store signs into ONE registry the moment its db opens. On exit, ONE
 *   call (`closeAllSqlite`) closes them all. A new store added later is closed
 *   automatically by registering — the close-list can never silently fall
 *   behind again (the exact failure mode that produced this bug). This replaces
 *   the hand-maintained two-store close-list in `server.ts`.
 *
 * CONTRACT:
 *   - register AFTER the db is fully open (never in a half-constructed state);
 *   - the store's own `.close()` calls the returned unregister fn BEFORE it
 *     closes its handle, so the registry never double-closes it;
 *   - `closeAllSqlite()` invokes each registered handle AT MOST ONCE (a closed
 *     set guards re-entrancy — e.g. SIGTERM after an uncaughtException already
 *     started teardown), best-effort per handle (a throwing close — such as an
 *     already-closed handle — never blocks the others);
 *   - run it LAST on every exit path, AFTER all writers stop + after any WAL
 *     checkpoint / sidecar flush, so no later tick re-opens a statement on a
 *     closed db and no unflushed write is lost.
 *
 * Spec: docs/specs/MULTI-MACHINE-LEASE-ROBUSTNESS-SPEC.md §Problem B.
 */

type SqliteCloseFn = () => void;

interface RegisteredHandle {
  readonly id: number;
  readonly closeFn: SqliteCloseFn;
}

// Process-global mutable singleton. Module identity is the lifetime: a single
// instar process imports this module once and shares one registry.
const registry = new Map<number, RegisteredHandle>();
// The "closed set": ids that have already been closed (via closeAllSqlite OR
// an explicit unregister). Guarantees AT-MOST-ONCE invocation even if both the
// registry close and an explicit store close target the same handle.
const closedIds = new Set<number>();
let nextId = 1;

/**
 * Register a SQLite handle's close function. Call this AFTER the db is open.
 * Returns an unregister fn the store MUST call from its own `.close()` BEFORE
 * closing its handle (so `closeAllSqlite` never double-closes it).
 */
export function registerSqliteHandle(closeFn: SqliteCloseFn): () => void {
  const id = nextId++;
  registry.set(id, { id, closeFn });
  return function unregisterSqliteHandle(): void {
    registry.delete(id);
    // An explicit store close means this handle is (about to be) closed — record
    // it so a racing closeAllSqlite never re-invokes a now-stale closeFn.
    closedIds.add(id);
  };
}

/**
 * Close EVERY registered handle exactly once, best-effort. Returns the number
 * of handles actually closed. Safe to call multiple times (idempotent via the
 * closed set) and from any exit path. NEVER throws — a per-handle failure is
 * swallowed so one bad close can't block the rest (the whole point).
 */
export function closeAllSqlite(): number {
  let closed = 0;
  // Snapshot: a closeFn could (in principle) touch the registry; iterate a copy.
  for (const [id, handle] of Array.from(registry.entries())) {
    registry.delete(id);
    if (closedIds.has(id)) continue; // already closed — at-most-once
    closedIds.add(id); // mark BEFORE invoking so a re-entrant call can't double-fire
    try {
      handle.closeFn();
      closed++;
    } catch {
      // Best-effort: an already-closed handle throws "database connection is
      // not open" — that's fine, the goal (no open handle at exit) still holds.
    }
  }
  return closed;
}

/** Number of handles currently registered (not yet closed/unregistered). */
export function sqliteRegistrySize(): number {
  return registry.size;
}

/**
 * Test-isolation reset. Clears BOTH the handle list AND the closed set — a
 * half-reset would leak an "already closed" verdict from one test into the
 * next (a handle registered in the next test would appear pre-closed).
 */
export function __resetSqliteRegistryForTests(): void {
  registry.clear();
  closedIds.clear();
}
