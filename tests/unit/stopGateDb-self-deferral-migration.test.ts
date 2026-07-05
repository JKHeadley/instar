/**
 * Unit tests — StopGateDb Phase-A self-deferral schema migration + retention.
 * Spec: docs/specs/turn-end-self-deferral-guard.md §3.4 / §7 (Tier 1 migration).
 *
 * Covers:
 *   - On a DB created at the OLD schema (events without the new columns), the
 *     ALTER TABLE ADD COLUMN migration adds each column idempotently (safe to
 *     run twice), and recordEvent then inserts the new columns without throwing.
 *   - Retention: pruneOldEvents deletes rows older than N days, keeps newer ones.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { StopGateDb, type EvalEvent } from '../../src/core/StopGateDb.js';

const NEW_EVENT_COLUMNS = [
  'self_deferral',
  'confidence',
  'agent_ownable',
  'turn_ending',
  'allow_class_rule',
  'prompt_hash',
  'surface',
  'context_turns',
];

/** Build a raw better-sqlite3 handle carrying the OLD (pre-Phase-A) schema. */
function oldSchemaDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE events (
      event_id              TEXT PRIMARY KEY,
      session_id            TEXT NOT NULL,
      agent_id              TEXT NOT NULL,
      ts                    INTEGER NOT NULL,
      mode                  TEXT NOT NULL,
      decision              TEXT,
      rule                  TEXT,
      invalid_kind          TEXT,
      evidence_pointer_json TEXT,
      latency_ms            INTEGER NOT NULL,
      reason_preview        TEXT NOT NULL
    );
    CREATE TABLE agent_eval_aggregate (
      agent_id        TEXT NOT NULL,
      day_key         TEXT NOT NULL,
      triggered_count INTEGER NOT NULL DEFAULT 0,
      shadow_count    INTEGER NOT NULL DEFAULT 0,
      continue_count  INTEGER NOT NULL DEFAULT 0,
      allow_count     INTEGER NOT NULL DEFAULT 0,
      escalate_count  INTEGER NOT NULL DEFAULT 0,
      failure_count   INTEGER NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (agent_id, day_key)
    );
  `);
  return db;
}

function columnNames(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

function fakeEvent(overrides: Partial<EvalEvent> = {}): EvalEvent {
  return {
    eventId: 'evt-' + Math.random().toString(36).slice(2, 10),
    sessionId: 'sess-1',
    agentId: 'echo',
    ts: Date.now(),
    mode: 'shadow',
    decision: 'allow',
    rule: 'U_SELF_DEFERRAL',
    invalidKind: null,
    evidencePointerJson: null,
    latencyMs: 12,
    reasonPreview: 'stopping the build here on purpose',
    ...overrides,
  };
}

describe('StopGateDb — Phase-A self-deferral migration', () => {
  it('adds every new events column to an OLD-schema DB', () => {
    const raw = oldSchemaDb();
    // sanity: the old schema has none of the new columns
    const before = columnNames(raw, 'events');
    for (const c of NEW_EVENT_COLUMNS) expect(before).not.toContain(c);

    const db = new StopGateDb({ db: raw });
    const after = columnNames(raw, 'events');
    for (const c of NEW_EVENT_COLUMNS) expect(after).toContain(c);
    // aggregate table also gains its self_deferral counter
    expect(columnNames(raw, 'agent_eval_aggregate')).toContain('self_deferral_count');
    db.close();
  });

  it('is idempotent (constructing twice over the same file does not throw / duplicate)', () => {
    const raw = oldSchemaDb();
    const a = new StopGateDb({ db: raw });
    // re-run the migration path against the same (already-migrated) handle
    expect(() => (a as unknown as { migrateSchema(): void }).migrateSchema()).not.toThrow();
    const cols = columnNames(raw, 'events');
    // no duplicate columns (each appears exactly once)
    for (const c of NEW_EVENT_COLUMNS) {
      expect(cols.filter(x => x === c)).toHaveLength(1);
    }
    a.close();
  });

  it('recordEvent inserts the new columns without throwing and reads them back', () => {
    const db = new StopGateDb({ db: oldSchemaDb() });
    const ev = fakeEvent({
      selfDeferral: 1,
      confidence: 'high',
      agentOwnable: 1,
      turnEnding: 1,
      allowClassRule: 'U_SELF_DEFERRAL',
      promptHash: 'deadbeef',
      surface: 'non-autonomous',
      contextTurns: 3,
    });
    expect(() => db.recordEvent(ev)).not.toThrow();
    const got = db.eventById(ev.eventId);
    expect(got?.selfDeferral).toBe(1);
    expect(got?.confidence).toBe('high');
    expect(got?.agentOwnable).toBe(1);
    expect(got?.turnEnding).toBe(1);
    expect(got?.allowClassRule).toBe('U_SELF_DEFERRAL');
    expect(got?.promptHash).toBe('deadbeef');
    expect(got?.surface).toBe('non-autonomous');
    expect(got?.contextTurns).toBe(3);
    db.close();
  });

  it('a legacy caller (no self-deferral fields) records NULLs, never throws', () => {
    const db = new StopGateDb({ db: oldSchemaDb() });
    const ev = fakeEvent({ decision: 'force_allow', rule: null });
    expect(() => db.recordEvent(ev)).not.toThrow();
    const got = db.eventById(ev.eventId);
    expect(got?.selfDeferral).toBeNull();
    expect(got?.promptHash).toBeNull();
    expect(got?.contextTurns).toBeNull();
    db.close();
  });
});

describe('StopGateDb — age-based retention', () => {
  it('pruneOldEvents deletes rows older than N days, keeps newer', () => {
    const db = new StopGateDb({ db: new Database(':memory:') });
    const now = Date.now();
    const old = fakeEvent({ eventId: 'evt-old', ts: now - 40 * 24 * 60 * 60 * 1000 });
    const fresh = fakeEvent({ eventId: 'evt-new', ts: now - 1 * 24 * 60 * 60 * 1000 });
    db.recordEvent(old);
    db.recordEvent(fresh);

    const deleted = db.pruneOldEvents(30, now);
    expect(deleted).toBe(1);
    expect(db.eventById('evt-old')).toBeNull();
    expect(db.eventById('evt-new')).not.toBeNull();
    db.close();
  });

  it('pruneOldEvents is a no-op when everything is within the window', () => {
    const db = new StopGateDb({ db: new Database(':memory:') });
    const now = Date.now();
    db.recordEvent(fakeEvent({ ts: now - 60_000 }));
    expect(db.pruneOldEvents(30, now)).toBe(0);
    db.close();
  });
});
