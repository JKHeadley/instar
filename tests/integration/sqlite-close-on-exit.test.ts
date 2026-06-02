/**
 * Lifecycle / integration tests for the SQLite close-on-exit registry
 * (docs/specs/MULTI-MACHINE-LEASE-ROBUSTNESS-SPEC.md §Problem B).
 *
 * Proves the registry closes REAL better-sqlite3 handles, and that server.ts
 * wires closeAllSqlite() into every exit path in the correct ORDER (last, after
 * the writers stop) — the ordering that prevents the "mutex lock failed" SIGABRT.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  registerSqliteHandle,
  closeAllSqlite,
  sqliteRegistrySize,
  __resetSqliteRegistryForTests,
} from '../../src/core/SqliteRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StopGateDb } from '../../src/core/StopGateDb.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('SQLite close-on-exit — real handles', () => {
  let tmp: string;
  beforeEach(() => {
    __resetSqliteRegistryForTests();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-close-'));
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/sqlite-close-on-exit.test.ts' }); } catch { /* ignore */ }
  });

  it('closeAllSqlite actually closes real better-sqlite3 handles', () => {
    const dbs = [0, 1, 2].map((i) => {
      const db = new Database(path.join(tmp, `h${i}.db`));
      registerSqliteHandle(() => db.close());
      return db;
    });
    expect(dbs.every((d) => d.open)).toBe(true);

    const closed = closeAllSqlite();

    expect(closed).toBe(3);
    expect(dbs.every((d) => !d.open)).toBe(true); // every real handle is now CLOSED
    expect(sqliteRegistrySize()).toBe(0);
  });

  it('a real store (StopGateDb) is closed by closeAllSqlite without throwing', () => {
    const store = new StopGateDb({ dbPath: path.join(tmp, 'sg.db') });
    expect(sqliteRegistrySize()).toBe(1);

    expect(() => closeAllSqlite()).not.toThrow();
    expect(sqliteRegistrySize()).toBe(0);

    // The store's own close() is now idempotent (the spec-flagged guard) — a
    // later explicit close must not throw a double-close error.
    expect(() => store.close()).not.toThrow();
  });

  it('a double closeAllSqlite (e.g. SIGTERM after uncaughtException) is safe', () => {
    const db = new Database(path.join(tmp, 'x.db'));
    registerSqliteHandle(() => db.close());
    expect(closeAllSqlite()).toBe(1);
    expect(() => closeAllSqlite()).not.toThrow();
    expect(closeAllSqlite()).toBe(0);
    expect(db.open).toBe(false);
  });
});

describe('SQLite close-on-exit — server.ts wiring (ordering)', () => {
  const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'commands', 'server.ts'), 'utf8');

  it('imports closeAllSqlite from the registry', () => {
    expect(serverSrc).toMatch(/import\s*\{\s*closeAllSqlite\s*\}\s*from\s*'\.\.\/core\/SqliteRegistry\.js'/);
  });

  it('the graceful shutdown calls closeAllSqlite() AFTER server.stop() (writers stopped first)', () => {
    const shutdownStart = serverSrc.indexOf('const shutdown = async () => {');
    expect(shutdownStart).toBeGreaterThan(0);
    // bound the search to the shutdown function body
    const body = serverSrc.slice(shutdownStart, shutdownStart + 6000);
    const stopIdx = body.indexOf('await server.stop()');
    expect(stopIdx).toBeGreaterThan(0);
    // Find the actual CALL after server.stop() — there is an incidental mention
    // of closeAllSqlite() in the re-entrancy-guard comment earlier in the body,
    // so search from stopIdx forward for the real post-stop close.
    const closeAfterStop = body.indexOf('closeAllSqlite()', stopIdx);
    expect(closeAfterStop).toBeGreaterThan(stopIdx); // close LAST, after the server stops
  });

  it('the uncaughtException handler closes ALL sqlite (not just topic/semantic memory)', () => {
    const uncaughtStart = serverSrc.indexOf("process.on('uncaughtException'");
    expect(uncaughtStart).toBeGreaterThan(0);
    const body = serverSrc.slice(uncaughtStart, uncaughtStart + 1200);
    expect(body).toMatch(/closeAllSqlite\(\)/);
  });

  it('the old hand-maintained 2-store close-list is gone from the exit paths', () => {
    // The explicit topicMemory?.close()/semanticMemory?.close() in the shutdown +
    // uncaughtException paths are replaced by closeAllSqlite(). (They may still be
    // referenced elsewhere, but not as the exit-path close-list.)
    expect(serverSrc).not.toMatch(/try\s*\{\s*topicMemory\?\.close\(\);\s*\}\s*catch/);
    expect(serverSrc).not.toMatch(/try\s*\{\s*semanticMemory\?\.close\(\);\s*\}\s*catch/);
  });
});
