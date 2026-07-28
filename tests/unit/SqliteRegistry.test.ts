/**
 * Unit tests for SqliteRegistry — the close-on-exit registry that fixes the
 * "mutex lock failed" SIGABRT (docs/specs/MULTI-MACHINE-LEASE-ROBUSTNESS-SPEC.md
 * §Problem B). Pure logic, no real databases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSqliteHandle,
  closeAllSqlite,
  sqliteRegistrySize,
  __resetSqliteRegistryForTests,
} from '../../src/core/SqliteRegistry.js';

describe('SqliteRegistry', () => {
  beforeEach(() => __resetSqliteRegistryForTests());

  it('closes every registered handle and reports the count', () => {
    const closed: number[] = [];
    for (let i = 0; i < 5; i++) registerSqliteHandle(() => closed.push(i));
    expect(sqliteRegistrySize()).toBe(5);

    const n = closeAllSqlite();

    expect(n).toBe(5);
    expect([...closed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(sqliteRegistrySize()).toBe(0);
  });

  it('a throwing close does NOT block the other handles (best-effort)', () => {
    const closed: string[] = [];
    registerSqliteHandle(() => { closed.push('a'); });
    registerSqliteHandle(() => { throw new Error('database connection is not open'); });
    registerSqliteHandle(() => { closed.push('c'); });

    const n = closeAllSqlite();

    // a + c closed; the thrower is swallowed (this is the whole point — one bad
    // close can't abort the process teardown).
    expect(n).toBe(2);
    expect(closed).toContain('a');
    expect(closed).toContain('c');
  });

  it('closeAllSqlite never throws even if EVERY handle throws', () => {
    registerSqliteHandle(() => { throw new Error('boom1'); });
    registerSqliteHandle(() => { throw new Error('boom2'); });
    expect(() => closeAllSqlite()).not.toThrow();
    expect(closeAllSqlite()).toBe(0); // all already drained
  });

  it('unregister removes a handle so closeAllSqlite skips it (unregister-before-close)', () => {
    let aClosed = 0;
    let bClosed = 0;
    const unA = registerSqliteHandle(() => { aClosed++; });
    registerSqliteHandle(() => { bClosed++; });

    unA(); // the store's own .close() unregistered before closing its handle
    expect(sqliteRegistrySize()).toBe(1);

    closeAllSqlite();
    expect(aClosed).toBe(0); // never invoked by the registry — the store closed it
    expect(bClosed).toBe(1);
  });

  it('invokes each handle AT MOST ONCE — a second closeAllSqlite is a no-op', () => {
    let count = 0;
    registerSqliteHandle(() => { count++; });

    expect(closeAllSqlite()).toBe(1);
    expect(closeAllSqlite()).toBe(0); // re-entrancy guard (e.g. SIGTERM after uncaughtException)
    expect(count).toBe(1);
  });

  it('__resetSqliteRegistryForTests clears BOTH the handle list AND the closed set', () => {
    // Close a handle so its id lands in the closed set.
    registerSqliteHandle(() => {});
    closeAllSqlite();

    __resetSqliteRegistryForTests();

    // A freshly registered handle must NOT appear pre-closed (a half-reset that
    // left the closed set would leak an "already closed" verdict into this test).
    let closed = 0;
    registerSqliteHandle(() => { closed++; });
    expect(sqliteRegistrySize()).toBe(1);
    expect(closeAllSqlite()).toBe(1);
    expect(closed).toBe(1);
  });
});
