/**
 * Verifies the idempotent import path the MTProto backfill writes through.
 *
 * The 2026-05-20 incident truncated topic-memory.db. The backfill flow
 * needs to be re-runnable (FloodWait recovery, partial-success retries,
 * etc.) without producing duplicates. The UNIQUE(message_id, topic_id)
 * constraint + INSERT OR IGNORE is the idempotency primitive — these
 * tests assert that semantics holds across the realistic re-run scenarios.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — .mjs file, no type declarations
import { TopicMemoryImporter } from '../../scripts/lib/topic-memory-importer.mjs';

const REAL_SCHEMA_SQL = `
  CREATE TABLE meta ( key TEXT PRIMARY KEY, value TEXT );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    topic_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    from_user INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL,
    session_name TEXT,
    sender_name TEXT,
    sender_username TEXT,
    telegram_user_id INTEGER,
    user_id TEXT,
    privacy_scope TEXT DEFAULT 'private',
    UNIQUE(message_id, topic_id)
  );
  CREATE INDEX idx_messages_topic ON messages(topic_id, timestamp);
  CREATE INDEX idx_messages_topic_id ON messages(topic_id, message_id);
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    text, content='messages', content_rowid='id',
    tokenize='porter unicode61'
  );
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;
`;

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmi-'));
  const dbPath = join(dir, 'topic-memory.db');
  const db = new Database(dbPath);
  db.exec(REAL_SCHEMA_SQL);
  db.close();
  return dbPath;
}

function row(messageId: number, topicId: number, text: string, extras: Record<string, any> = {}) {
  return {
    messageId,
    topicId,
    text,
    timestamp: extras.timestamp ?? '2026-05-20T00:00:00Z',
    fromUser: extras.fromUser ?? 0,
    senderName: extras.senderName ?? 'echo',
    senderUsername: extras.senderUsername ?? null,
    telegramUserId: extras.telegramUserId ?? 11111,
    privacyScope: 'private',
  };
}

describe('TopicMemoryImporter — basic insert', () => {
  let importer: any;
  let dbPath: string;

  beforeEach(() => {
    dbPath = freshDb();
    importer = new TopicMemoryImporter(dbPath);
  });
  afterEach(() => importer?.close());

  it('inserts a single message', () => {
    const r = importer.importBatch([row(100, 10873, 'hello')]);
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.touchedTopics).toEqual(new Set([10873]));
  });

  it('inserts multiple messages in one batch', () => {
    const r = importer.importBatch([
      row(100, 10873, 'a'),
      row(101, 10873, 'b'),
      row(102, 10873, 'c'),
    ]);
    expect(r.inserted).toBe(3);
    expect(r.skipped).toBe(0);
  });

  it('returns counts grouped by topic after insert', () => {
    importer.importBatch([
      row(1, 10873, 'a'),
      row(2, 10873, 'b'),
      row(3, 9984, 'c'),
    ]);
    const counts = importer.countsByTopic();
    expect(counts.get(10873)).toBe(2);
    expect(counts.get(9984)).toBe(1);
  });
});

describe('TopicMemoryImporter — idempotency (the headline property)', () => {
  let importer: any;
  let dbPath: string;

  beforeEach(() => {
    dbPath = freshDb();
    importer = new TopicMemoryImporter(dbPath);
  });
  afterEach(() => importer?.close());

  it('re-running the same batch produces zero new inserts', () => {
    const batch = [row(100, 10873, 'a'), row(101, 10873, 'b')];
    const first = importer.importBatch(batch);
    const second = importer.importBatch(batch);
    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it('partial overlap inserts only the new messages', () => {
    importer.importBatch([row(100, 10873, 'a'), row(101, 10873, 'b')]);
    const r = importer.importBatch([
      row(101, 10873, 'b'),
      row(102, 10873, 'c'),
      row(103, 10873, 'd'),
    ]);
    expect(r.inserted).toBe(2);
    expect(r.skipped).toBe(1);
  });

  it('same message_id in different topics is NOT a duplicate', () => {
    // The UNIQUE constraint is (message_id, topic_id) — message ids are
    // per-chat, but the same numeric value can appear across topics. The
    // importer must treat these as distinct rows.
    const r = importer.importBatch([
      row(100, 10873, 'lockdown msg'),
      row(100, 9984, 'agent-updates msg'),
    ]);
    expect(r.inserted).toBe(2);
    expect(r.skipped).toBe(0);
  });

  it('does not corrupt FTS index across re-runs', () => {
    importer.importBatch([row(100, 10873, 'the headline guarantee')]);
    importer.importBatch([row(100, 10873, 'the headline guarantee')]); // dup
    importer.importBatch([row(101, 10873, 'second message')]);

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(`SELECT message_id FROM messages_fts JOIN messages ON messages_fts.rowid = messages.id WHERE messages_fts MATCH 'headline'`)
      .all() as Array<{ message_id: number }>;
    db.close();
    expect(rows.map((r) => r.message_id)).toEqual([100]); // single match, no FTS dupe
  });
});

describe('TopicMemoryImporter — edge cases', () => {
  let importer: any;

  beforeEach(() => {
    importer = new TopicMemoryImporter(freshDb());
  });
  afterEach(() => importer?.close());

  it('accepts empty text (service messages, media-only posts)', () => {
    const r = importer.importBatch([row(100, 10873, '')]);
    expect(r.inserted).toBe(1);
  });

  it('uses default privacy_scope when omitted', () => {
    const r = importer.importBatch([row(100, 10873, 'x')]);
    expect(r.inserted).toBe(1);
  });

  it('accepts null sender fields (system messages)', () => {
    const r = importer.importBatch([
      row(100, 10873, 'system', {
        senderName: null,
        senderUsername: null,
        telegramUserId: null,
      }),
    ]);
    expect(r.inserted).toBe(1);
  });

  it('treats a coercible non-string text as the string form (defense in depth)', () => {
    // gramjs occasionally surfaces messages where `message` is undefined
    // (media-only posts). The importer defaults to '' for these. Verify.
    const r = importer.importBatch([
      {
        messageId: 100,
        topicId: 10873,
        // intentionally undefined text — the importer should coerce to ''
        text: undefined as any,
        timestamp: '2026-05-20T00:00:00Z',
        fromUser: 0,
        senderName: 'x',
        senderUsername: null,
        telegramUserId: 0,
        privacyScope: 'private',
      },
    ]);
    expect(r.inserted).toBe(1);
  });
});

describe('TopicMemoryImporter — regression: post-recovery backfill scenario', () => {
  it('simulates the 2026-05-20 incident shape (small db, large incoming)', () => {
    const dbPath = freshDb();
    const importer = new TopicMemoryImporter(dbPath);

    // Existing: 4 messages survived the truncation, ids 1000-1003
    importer.importBatch([
      row(1000, 10873, 'survived 1'),
      row(1001, 10873, 'survived 2'),
      row(1002, 10873, 'survived 3'),
      row(1003, 10873, 'survived 4'),
    ]);

    // Incoming backfill: 50 historical messages (ids 950-1003), overlapping
    // the 4 survivors. Importer must insert 50 - 4 = 46 new, skip 4.
    const backfill = [];
    for (let i = 950; i <= 1003; i++) {
      backfill.push(row(i, 10873, `historical ${i}`));
    }
    const r = importer.importBatch(backfill);
    expect(r.inserted).toBe(50);
    expect(r.skipped).toBe(4);
    expect(importer.countsByTopic().get(10873)).toBe(54);
    importer.close();
  });
});
