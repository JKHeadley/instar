/**
 * Unit tests for TokenLedger.
 *
 * Uses :memory: SQLite for query tests, and a tmp directory + tmp
 * JSONL files for ingestFile / scanAll behavior (offset resume,
 * inode rotation, dedupe).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function assistantLine(opts: {
  requestId: string;
  sessionId: string;
  cwd?: string;
  ts?: string;
  uuid?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  serviceTier?: string;
}): string {
  const obj = {
    type: 'assistant',
    sessionId: opts.sessionId,
    cwd: opts.cwd ?? '/Users/test/project-a',
    timestamp: opts.ts ?? '2026-04-29T20:35:03.699Z',
    uuid: opts.uuid ?? 'uuid-' + opts.requestId,
    requestId: opts.requestId,
    message: {
      id: 'msg-' + opts.requestId,
      model: opts.model ?? 'claude-opus-4-7',
      usage: {
        input_tokens: opts.input ?? 10,
        output_tokens: opts.output ?? 100,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        service_tier: opts.serviceTier ?? 'standard',
      },
    },
  };
  return JSON.stringify(obj);
}

function makeLedger(claudeProjectsDir = '/tmp/nonexistent-claude-projects'): TokenLedger {
  return new TokenLedger({ dbPath: ':memory:', claudeProjectsDir });
}

describe('TokenLedger.ingestLine', () => {
  let ledger: TokenLedger;

  beforeEach(() => {
    ledger = makeLedger();
  });

  afterEach(() => {
    ledger.close();
  });

  it('inserts a valid assistant line with usage', () => {
    const line = assistantLine({ requestId: 'req-1', sessionId: 'sess-1', input: 5, output: 50 });
    const r = ledger.ingestLine(line);
    expect(r.inserted).toBe(true);

    const summary = ledger.summary();
    expect(summary.eventCount).toBe(1);
    expect(summary.totalInput).toBe(5);
    expect(summary.totalOutput).toBe(50);
    expect(summary.totalTokens).toBe(55);
    expect(summary.sessionsActive).toBe(1);
  });

  it('skips a line with no message.usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 's',
      requestId: 'r',
      timestamp: '2026-04-29T20:35:03.699Z',
      message: { id: 'm', model: 'claude-opus-4-7' },
    });
    const r = ledger.ingestLine(line);
    expect(r.inserted).toBe(false);
    expect(r.reason).toBe('no-usage');
    expect(ledger.summary().eventCount).toBe(0);
  });

  it('skips malformed JSON without throwing', () => {
    const r = ledger.ingestLine('{ this is not valid');
    expect(r.inserted).toBe(false);
    expect(r.reason).toBe('malformed');
  });

  it('treats duplicate requestId as no-op', () => {
    const line = assistantLine({ requestId: 'req-dup', sessionId: 'sess-1' });
    expect(ledger.ingestLine(line).inserted).toBe(true);
    const r = ledger.ingestLine(line);
    expect(r.inserted).toBe(false);
    expect(r.reason).toBe('duplicate');
    expect(ledger.summary().eventCount).toBe(1);
  });

  it('skips non-assistant types and tool-result rows', () => {
    expect(ledger.ingestLine(JSON.stringify({ type: 'user', sessionId: 's' })).inserted).toBe(false);
    expect(ledger.ingestLine(JSON.stringify({ type: 'tool_result' })).inserted).toBe(false);
    expect(ledger.summary().eventCount).toBe(0);
  });
});

describe('TokenLedger.summary / topSessions / byProject', () => {
  let ledger: TokenLedger;

  beforeEach(() => {
    ledger = makeLedger();
    // Two projects, three sessions, six events.
    const lines = [
      assistantLine({ requestId: 'r1', sessionId: 'sA', cwd: '/p/alpha', input: 10, output: 100 }),
      assistantLine({ requestId: 'r2', sessionId: 'sA', cwd: '/p/alpha', input: 20, output: 200 }),
      assistantLine({ requestId: 'r3', sessionId: 'sB', cwd: '/p/alpha', input: 5, output: 5 }),
      assistantLine({ requestId: 'r4', sessionId: 'sC', cwd: '/p/beta', input: 1, output: 1, cacheRead: 1000 }),
      assistantLine({ requestId: 'r5', sessionId: 'sC', cwd: '/p/beta', input: 1, output: 1 }),
      assistantLine({ requestId: 'r6', sessionId: 'sC', cwd: '/p/beta', input: 1, output: 1 }),
    ];
    for (const l of lines) ledger.ingestLine(l);
  });

  afterEach(() => ledger.close());

  it('summary aggregates totals correctly', () => {
    const s = ledger.summary();
    expect(s.eventCount).toBe(6);
    expect(s.sessionsActive).toBe(3);
    expect(s.totalInput).toBe(10 + 20 + 5 + 1 + 1 + 1);
    expect(s.totalOutput).toBe(100 + 200 + 5 + 1 + 1 + 1);
    expect(s.totalCacheRead).toBe(1000);
    expect(s.totalTokens).toBe(s.totalInput + s.totalOutput + s.totalCacheRead + s.totalCacheCreate);
  });

  it('topSessions orders by totalTokens DESC (cache included)', () => {
    const top = ledger.topSessions({ limit: 10 });
    // sC = 1006, sA = 330, sB = 10
    expect(top[0].sessionId).toBe('sC');
    expect(top[0].totalTokens).toBe(1006);
    expect(top[1].sessionId).toBe('sA');
    expect(top[1].totalTokens).toBe(330);
    expect(top[2].sessionId).toBe('sB');
    expect(top[2].totalTokens).toBe(10);
  });

  it('byProject aggregates by project_path', () => {
    const projects = ledger.byProject();
    const alpha = projects.find(p => p.projectPath === '/p/alpha');
    const beta = projects.find(p => p.projectPath === '/p/beta');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha!.sessionCount).toBe(2);
    expect(alpha!.eventCount).toBe(3);
    expect(alpha!.totalTokens).toBe(10 + 100 + 20 + 200 + 5 + 5);
    expect(beta!.sessionCount).toBe(1);
    expect(beta!.eventCount).toBe(3);
    expect(beta!.totalTokens).toBe(1006);
  });
});

describe('TokenLedger.orphans', () => {
  it('returns sessions with newest event older than idleMs', () => {
    const ledger = makeLedger();
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const newTs = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    ledger.ingestLine(assistantLine({ requestId: 'rOld', sessionId: 'sOld', ts: oldTs }));
    ledger.ingestLine(assistantLine({ requestId: 'rNew', sessionId: 'sNew', ts: newTs }));

    const orphans = ledger.orphans({ idleMs: 30 * 60 * 1000 }); // 30 min cutoff
    expect(orphans.length).toBe(1);
    expect(orphans[0].sessionId).toBe('sOld');
    expect(orphans[0].idleMs).toBeGreaterThan(30 * 60 * 1000);
    ledger.close();
  });
});

describe('TokenLedger.ingestFile / scanAll', () => {
  let tmpDir: string;
  let projectsDir: string;
  let ledger: TokenLedger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-ledger-test-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    ledger = new TokenLedger({ dbPath: ':memory:', claudeProjectsDir: projectsDir });
  });

  afterEach(() => {
    ledger.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/token-ledger.test.ts:afterEach' });
  });

  it('resumes from stored offset on second call (no double counting)', () => {
    const projDir = path.join(projectsDir, '-Users-test-project-a');
    fs.mkdirSync(projDir, { recursive: true });
    const fp = path.join(projDir, 'session-1.jsonl');
    fs.writeFileSync(fp, assistantLine({ requestId: 'a', sessionId: 's1' }) + '\n');

    const r1 = ledger.ingestFile(fp);
    expect(r1.inserted).toBe(1);

    // Append a second event
    fs.appendFileSync(fp, assistantLine({ requestId: 'b', sessionId: 's1' }) + '\n');
    const r2 = ledger.ingestFile(fp);
    expect(r2.inserted).toBe(1);

    // Re-running with no new lines is a no-op
    const r3 = ledger.ingestFile(fp);
    expect(r3.inserted).toBe(0);

    expect(ledger.summary().eventCount).toBe(2);
  });

  it('resets to 0 if inode changes (file rotation)', () => {
    const projDir = path.join(projectsDir, '-rotation-test');
    fs.mkdirSync(projDir, { recursive: true });
    const fp = path.join(projDir, 'session-rot.jsonl');
    fs.writeFileSync(fp, assistantLine({ requestId: 'pre-rot', sessionId: 's-rot' }) + '\n');

    const r1 = ledger.ingestFile(fp);
    expect(r1.inserted).toBe(1);

    // Replace the file (new inode)
    SafeFsExecutor.safeUnlinkSync(fp, { operation: 'tests/unit/token-ledger.test.ts:rotation' });
    fs.writeFileSync(fp, assistantLine({ requestId: 'post-rot', sessionId: 's-rot' }) + '\n');

    const r2 = ledger.ingestFile(fp);
    expect(r2.inserted).toBe(1);
    expect(ledger.summary().eventCount).toBe(2);
  });

  it('scanAll walks projects directory and ingests every jsonl', () => {
    const projA = path.join(projectsDir, '-projA');
    const projB = path.join(projectsDir, '-projB');
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });
    fs.writeFileSync(path.join(projA, 's1.jsonl'),
      assistantLine({ requestId: 'a1', sessionId: 's1' }) + '\n' +
      assistantLine({ requestId: 'a2', sessionId: 's1' }) + '\n');
    fs.writeFileSync(path.join(projB, 's2.jsonl'),
      assistantLine({ requestId: 'b1', sessionId: 's2' }) + '\n');
    // Also an irrelevant file to confirm it's ignored
    fs.writeFileSync(path.join(projA, 'README.md'), 'not jsonl');

    const r = ledger.scanAll();
    expect(r.filesScanned).toBe(2);
    expect(r.inserted).toBe(3);
    expect(ledger.summary().eventCount).toBe(3);
  });
});

describe('TokenLedger.scanAll bounded behavior', () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-ledger-bounded-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/token-ledger.test.ts:bounded-afterEach' });
  });

  it('respects maxFilesPerScan and resumes via cursor on next call', () => {
    const projDir = path.join(projectsDir, '-many-files');
    fs.mkdirSync(projDir, { recursive: true });
    // 12 sessions, one event each
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(projDir, `s${String(i).padStart(2, '0')}.jsonl`),
        assistantLine({ requestId: `r${i}`, sessionId: `s${i}` }) + '\n',
      );
    }
    const ledger = new TokenLedger({
      dbPath: ':memory:',
      claudeProjectsDir: projectsDir,
      maxFilesPerScan: 5,
    });

    const r1 = ledger.scanAll();
    expect(r1.filesScanned).toBe(5);
    expect(r1.inserted).toBe(5);

    const r2 = ledger.scanAll();
    expect(r2.filesScanned).toBe(5);
    expect(r2.inserted).toBe(5);

    const r3 = ledger.scanAll();
    expect(r3.filesScanned).toBe(2);
    expect(r3.inserted).toBe(2);

    expect(ledger.summary().eventCount).toBe(12);
    ledger.close();
  });

  it('skips files older than maxFileAgeMs', () => {
    const projDir = path.join(projectsDir, '-age-test');
    fs.mkdirSync(projDir, { recursive: true });
    const old = path.join(projDir, 'old.jsonl');
    const fresh = path.join(projDir, 'fresh.jsonl');
    fs.writeFileSync(old, assistantLine({ requestId: 'old', sessionId: 'sold' }) + '\n');
    fs.writeFileSync(fresh, assistantLine({ requestId: 'new', sessionId: 'snew' }) + '\n');

    // Backdate the old file by 60 days
    const sixtyDaysAgo = Date.now() - (60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, sixtyDaysAgo / 1000, sixtyDaysAgo / 1000);

    const ledger = new TokenLedger({
      dbPath: ':memory:',
      claudeProjectsDir: projectsDir,
      maxFileAgeMs: 30 * 24 * 60 * 60 * 1000,
    });
    const r = ledger.scanAll();
    expect(r.filesScanned).toBe(1);
    expect(r.inserted).toBe(1);
    expect(ledger.summary().eventCount).toBe(1);
    ledger.close();
  });

  it('routes better-sqlite3 open through NativeModuleHealer (NODE_MODULE_VERSION self-heal)', async () => {
    // Regression for the 2-day silent ledger outage on 2026-05-15: when
    // better-sqlite3's prebuilt binding is compiled against the wrong
    // Node ABI, TokenLedger init threw and the ledger came up null
    // forever. Now the constructor wraps `new Database()` in
    // NativeModuleHealer.openWithHealSync — which rebuilds + retries
    // once before surfacing the error. This test pins that the
    // ledger ACTUALLY uses the healer (so a future refactor can't
    // silently regress to a bare `new Database`).
    const { NativeModuleHealer } = await import('../../src/memory/NativeModuleHealer.js');
    const { vi } = await import('vitest');
    const spy = vi.spyOn(NativeModuleHealer, 'openWithHealSync');
    try {
      const ledger = new TokenLedger({
        dbPath: ':memory:',
        claudeProjectsDir: projectsDir,
      });
      expect(spy).toHaveBeenCalledWith('TokenLedger', expect.any(Function));
      ledger.close();
    } finally {
      spy.mockRestore();
    }
  });

  it('scanAllAsync yields control between batches and completes', async () => {
    const projDir = path.join(projectsDir, '-async-yield');
    fs.mkdirSync(projDir, { recursive: true });
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(
        path.join(projDir, `s${i}.jsonl`),
        assistantLine({ requestId: `r${i}`, sessionId: `s${i}` }) + '\n',
      );
    }
    let yieldCount = 0;
    const ledger = new TokenLedger({
      dbPath: ':memory:',
      claudeProjectsDir: projectsDir,
      yieldEveryNFiles: 2,
      asyncYieldFn: async () => { yieldCount++; },
    });

    const r = await ledger.scanAllAsync();

    expect(r.filesScanned).toBe(8);
    expect(r.inserted).toBe(8);
    expect(yieldCount).toBeGreaterThan(0);
    ledger.close();
  });
});

describe('TokenLedger.sessionActivitySince (SessionReaper gate F)', () => {
  let ledger: TokenLedger;
  beforeEach(() => { ledger = makeLedger(); });
  afterEach(() => { ledger.close(); });

  it('returns counts/tokens/lastTs for events at or after sinceMs', () => {
    const oldTs = '2026-04-29T20:00:00.000Z';
    const newTs = '2026-04-29T21:00:00.000Z';
    ledger.ingestLine(assistantLine({ requestId: 'r1', sessionId: 'sx', ts: oldTs, output: 10 }));
    ledger.ingestLine(assistantLine({ requestId: 'r2', sessionId: 'sx', ts: newTs, output: 20 }));
    const cutoff = Date.parse('2026-04-29T20:30:00.000Z');
    const res = ledger.sessionActivitySince('sx', cutoff);
    expect(res.eventCount).toBe(1); // only the newTs event
    expect(res.tokens).toBeGreaterThan(0);
    expect(res.lastTs).toBe(Date.parse(newTs));
  });

  it('returns zeros for an unknown session (caller must KEEP on absence)', () => {
    const res = ledger.sessionActivitySince('never-seen', 0);
    expect(res).toEqual({ eventCount: 0, tokens: 0, lastTs: 0 });
  });

  it('returns zeros when all events predate sinceMs', () => {
    ledger.ingestLine(assistantLine({ requestId: 'r3', sessionId: 'sy', ts: '2026-04-29T20:00:00.000Z' }));
    const res = ledger.sessionActivitySince('sy', Date.parse('2026-04-29T23:00:00.000Z'));
    expect(res.eventCount).toBe(0);
  });
});

// Regression: TokenLedger init must migrate a pre-attribution DB instead of 503ing.
// Before the schema-order fix, `CREATE INDEX ... ON token_events(attribution_key, ts)`
// ran BEFORE the `ALTER TABLE token_events ADD COLUMN attribution_key` migration. On a
// DB whose token_events table predates the column, `CREATE TABLE IF NOT EXISTS` no-ops,
// then the index threw `no such column: attribution_key` — NOT swallowed (only
// duplicate-column is) — so the whole init failed and /tokens/* returned 503 forever.
describe('TokenLedger pre-attribution DB migration (schema-order regression)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-ledger-preattr-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test cleanup' });
  });

  /** Build a token_events table with the OLD schema (no attribution_key column). */
  function seedPreAttributionDb(dbPath: string): void {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE token_events (
       request_id            TEXT PRIMARY KEY,
       uuid                  TEXT,
       session_id            TEXT NOT NULL,
       project_path          TEXT,
       ts                    INTEGER NOT NULL,
       model                 TEXT,
       input_tokens          INTEGER NOT NULL DEFAULT 0,
       output_tokens         INTEGER NOT NULL DEFAULT 0,
       cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
       cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
       service_tier          TEXT
     )`);
    // A pre-existing row, so we also prove the migration's DEFAULT backfills it.
    db.prepare(
      `INSERT INTO token_events (request_id, session_id, ts, input_tokens, output_tokens)
       VALUES ('old-1', 'sess-old', ?, 5, 50)`,
    ).run(1_700_000_000_000);
    db.close();
  }

  it('migrates a pre-attribution token_events table on init (no 503) and adds the column', () => {
    const dbPath = path.join(tmpDir, 'token-ledger.db');
    seedPreAttributionDb(dbPath);

    // Pre-fix this constructor threw `no such column: attribution_key`.
    let ledger: TokenLedger;
    expect(() => {
      ledger = new TokenLedger({ dbPath, claudeProjectsDir: '/tmp/nonexistent-claude-projects' });
    }).not.toThrow();

    // The column now exists on the migrated table.
    const probe = new Database(dbPath, { readonly: true });
    const cols = (probe.prepare(`PRAGMA table_info(token_events)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    probe.close();
    expect(cols).toContain('attribution_key');

    // The attribution_key-referencing queries (which back /tokens/*) work, and the
    // pre-existing row was backfilled with the migration DEFAULT rather than dropped.
    const summary = ledger!.summary();
    expect(summary.eventCount).toBe(1);
    const byKey = ledger!.byAttributionKey();
    expect(byKey.length).toBeGreaterThanOrEqual(1);
    expect(byKey.some((r) => r.attributionKey === 'unknown::pre-attribution')).toBe(true);
  });

  it('re-initialising a migrated DB is idempotent (duplicate-column ALTER swallowed)', () => {
    const dbPath = path.join(tmpDir, 'token-ledger.db');
    seedPreAttributionDb(dbPath);
    // First init migrates; second init must not throw on the now-present column.
    new TokenLedger({ dbPath, claudeProjectsDir: '/tmp/nonexistent-claude-projects' });
    expect(() => {
      new TokenLedger({ dbPath, claudeProjectsDir: '/tmp/nonexistent-claude-projects' });
    }).not.toThrow();
  });
});
