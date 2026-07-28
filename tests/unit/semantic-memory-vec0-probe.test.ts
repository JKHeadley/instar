// safe-git-allow: test file — fs.rmSync is for temp directory cleanup in afterEach only.
/**
 * Regression: vec0 virtual table must NOT trip corruption quarantine.
 *
 * Live failure (codex-live-test, codey 2026-05-23): every boot logged
 *   "[SemanticMemory] Database corrupt (probe read failed: no such module: vec0)
 *    — quarantining ... and rebuilding"
 * and produced a fresh `semantic.db.corrupt.<ts>` + recovery marker. Six such
 * files accumulated in hours — a rebuild-on-every-boot loop that silently
 * defeated the FTS5-only graceful-degradation path this class promises.
 *
 * Root cause: open()'s secondary probe `SELECT * FROM <table>` ran over EVERY
 * non-fts/non-sqlite table — including the vec0 `entity_embeddings` virtual
 * table — BEFORE initVectorSearch() loads the sqlite-vec extension. With the
 * extension not yet loaded, that SELECT throws "no such module: vec0", which
 * was misclassified as disk corruption.
 *
 * Contract enforced here:
 *   1. A DB containing a vec0 virtual table opens WITHOUT being quarantined,
 *      even when the sqlite-vec extension is not loaded at probe time.
 *   2. Existing entities survive (no spurious rebuild that could lose data).
 *   3. The vec0 virtual table is left intact in the file.
 *   4. Genuine corruption is still detected (the existing probe behaviour is
 *      preserved for real storage tables).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';

interface Setup {
  dir: string;
  dbPath: string;
  cleanup: () => void;
}

function makeSetup(): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-vec0-probe-'));
  const dbPath = path.join(dir, 'semantic.db');
  return {
    dir,
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** True if sqlite-vec can actually load on this platform/runtime. */
async function vecAvailable(): Promise<boolean> {
  try {
    const mod = await import('sqlite-vec');
    return typeof (mod as { load?: unknown }).load === 'function';
  } catch {
    return false;
  }
}

/**
 * Open a raw better-sqlite3 connection on `dbPath`, load sqlite-vec, and create
 * a populated vec0 virtual table named `entity_embeddings` — exactly the object
 * that breaks the probe when the extension is absent on a later open().
 */
async function injectVec0Table(dbPath: string): Promise<void> {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const sqliteVec = await import('sqlite-vec');
  const db = new BetterSqlite3(dbPath);
  sqliteVec.load(db);
  db.exec(
    'CREATE VIRTUAL TABLE IF NOT EXISTS entity_embeddings USING vec0(' +
      'id TEXT PRIMARY KEY, embedding float[4]);'
  );
  const buf = Buffer.from(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer);
  db.prepare('INSERT INTO entity_embeddings (id, embedding) VALUES (?, ?)').run('seed-1', buf);
  db.close();
}

function corruptFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.includes('.corrupt.'));
}

describe('SemanticMemory — vec0 virtual table does not trip corruption quarantine', () => {
  let s: Setup;
  beforeEach(() => { s = makeSetup(); });
  afterEach(() => s.cleanup());

  it('opens a DB with a vec0 table without quarantining (extension not loaded at probe)', async () => {
    if (!(await vecAvailable())) {
      // sqlite-vec is an optional dependency; on a host without it we cannot
      // build the reproducing fixture. The fix is still exercised in CI hosts
      // where sqlite-vec resolves (it does in this repo's toolchain).
      return;
    }
    const nowIso = new Date().toISOString();

    // Seed real data + JSONL, then close cleanly.
    const seed = new SemanticMemory({ dbPath: s.dbPath });
    await seed.open();
    seed.remember({ type: 'concept', name: 'Alpha', content: 'seed alpha', confidence: 0.9, lastVerified: nowIso, source: 'test', tags: [] });
    seed.remember({ type: 'concept', name: 'Beta', content: 'seed beta', confidence: 0.9, lastVerified: nowIso, source: 'test', tags: [] });
    seed.close();

    // Inject a vec0 virtual table (the object that breaks the probe).
    await injectVec0Table(s.dbPath);
    expect(corruptFiles(s.dir)).toHaveLength(0);

    // Reopen WITHOUT pre-loading the extension — the path codey hits every boot.
    const mem = new SemanticMemory({ dbPath: s.dbPath });
    await expect(mem.open()).resolves.not.toThrow();

    // 1 + 2: no quarantine, entities preserved (no spurious rebuild).
    expect(corruptFiles(s.dir)).toHaveLength(0);
    expect(mem.search('Alpha').length).toBeGreaterThan(0);
    expect(mem.search('Beta').length).toBeGreaterThan(0);

    // 3: the vec0 table is still present in the file.
    const raw = (await import('better-sqlite3')).default;
    const rawDb = new raw(s.dbPath);
    const row = rawDb.prepare(
      "SELECT name FROM sqlite_master WHERE name='entity_embeddings'"
    ).get() as { name?: string } | undefined;
    rawDb.close();
    expect(row?.name).toBe('entity_embeddings');

    mem.close();
  });

  it('still quarantines a genuinely corrupt storage table (probe behaviour preserved)', async () => {
    const nowIso = new Date().toISOString();
    const seed = new SemanticMemory({ dbPath: s.dbPath });
    await seed.open();
    // Many rows so data spans multiple interior pages.
    for (let i = 0; i < 4000; i++) {
      seed.remember({ type: 'concept', name: `E${i}`, content: 'x'.repeat(200), confidence: 0.9, lastVerified: nowIso, source: 'test', tags: [] });
    }
    seed.close();

    // Tear a page deep in the row-data region (preserves the SQLite header so
    // integrity_check may pass but the probe read catches it).
    const fd = fs.openSync(s.dbPath, 'r+');
    fs.writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, 32768);
    fs.closeSync(fd);

    const mem = new SemanticMemory({ dbPath: s.dbPath });
    await expect(mem.open()).resolves.not.toThrow();
    expect(corruptFiles(s.dir).length).toBeGreaterThan(0);
    mem.close();
  });
});
