/**
 * Bounded Accumulation §4 — TokenLedger SQLite retention (Increment 2).
 * The 256MB token-ledger was the lone unbounded SQLite store; this proves the
 * batched, dark-by-default prune deletes old events and keeps recent ones.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';

const ledgers: TokenLedger[] = [];
afterEach(() => { for (const l of ledgers.splice(0)) { try { l.close(); } catch { /* ignore */ } } });

function makeLedger(retention?: { enabled?: boolean; maxAgeMs?: number }) {
  // Create the db INSIDE the factory so TokenLedger's NativeModuleHealer wrapper
  // (openWithHealSync) covers it — a raw `new Database()` outside the factory would
  // hit a better-sqlite3 ABI mismatch before any heal could run.
  let db: any;
  const ledger = new TokenLedger({
    dbPath: ':memory:',
    claudeProjectsDir: '/tmp/does-not-exist-token-retention-test',
    databaseFactory: () => { db = new Database(':memory:'); return db; },
    retention,
  });
  ledgers.push(ledger);
  return { ledger, db };
}

function insert(db: any, requestId: string, ts: number) {
  db.prepare(
    `INSERT OR IGNORE INTO token_events (request_id, session_id, ts, input_tokens, output_tokens) VALUES (?, 'sess', ?, 0, 0)`,
  ).run(requestId, ts);
}
function ids(db: any): string[] {
  return db.prepare('SELECT request_id FROM token_events ORDER BY ts').all().map((r: any) => r.request_id);
}

const NOW = 1_700_000_000_000;

describe('TokenLedger retention', () => {
  it('pruneToRetention deletes events older than maxAgeMs, keeps newer', () => {
    const { ledger, db } = makeLedger({ enabled: true, maxAgeMs: 1000 });
    insert(db, 'old', NOW - 5000); // older than the 1s window → pruned
    insert(db, 'fresh', NOW - 200); // within the window → kept
    const res = ledger.pruneToRetention(NOW);
    expect(res.deleted).toBe(1);
    expect(ids(db)).toEqual(['fresh']);
  });

  it('is a NO-OP when retention is disabled (ships dark)', () => {
    const { ledger, db } = makeLedger({ enabled: false });
    insert(db, 'ancient', NOW - 10 ** 11);
    expect(ledger.pruneToRetention(NOW).deleted).toBe(0);
    expect(ids(db)).toEqual(['ancient']);
  });

  it('pruneOlderThan batches and reports more=true when the per-call cap is hit', () => {
    const { ledger, db } = makeLedger({ enabled: true, maxAgeMs: 0 });
    const ins = db.prepare(
      `INSERT OR IGNORE INTO token_events (request_id, session_id, ts, input_tokens, output_tokens) VALUES (?, 'sess', ?, 0, 0)`,
    );
    db.transaction(() => { for (let i = 0; i < 25; i++) ins.run('e' + i, NOW - 1); })();
    const res = ledger.pruneOlderThan(NOW, { batchSize: 10, maxBatches: 2 });
    expect(res.deleted).toBe(20); // 2 batches × 10
    expect(res.more).toBe(true); // cap hit → more remain
    // a follow-up call drains the rest
    const rest = ledger.pruneOlderThan(NOW, { batchSize: 10, maxBatches: 5 });
    expect(rest.deleted).toBe(5);
    expect(rest.more).toBe(false);
    expect(ids(db)).toEqual([]);
  });
});
