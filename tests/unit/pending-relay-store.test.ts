// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Layer 2a tests — PendingRelayStore SQLite substrate.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § Layer 2a.
 *
 * Coverage:
 *   - Schema setup (idempotent — open()-open()-open() does not re-create).
 *   - ALTER TABLE add-column is idempotent (no error on re-run).
 *   - enqueue() basic insert + INSERT OR IGNORE on duplicate delivery_id.
 *   - findByDeliveryId returns the row.
 *   - findByTopicAndHashWithin honors the windowMs cutoff.
 *   - transition() updates state + appends to status_history atomically.
 *   - Path resolution sanitizes hostile agent-ids (no traversal).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  PendingRelayStore,
  resolvePendingRelayPath,
  assertSqliteAvailable,
} from '../../src/messaging/pending-relay-store.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-relay-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('PendingRelayStore — schema and path', () => {
  it('creates the entries table on first open', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    expect(store.count()).toBe(0);
    store.close();

    // Sanity-check schema by opening the file directly.
    const dbPath = resolvePendingRelayPath(tmpDir, 'echo');
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);
    const cols = db.prepare("PRAGMA table_info('entries')").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).sort();
    expect(colNames).toContain('delivery_id');
    expect(colNames).toContain('truncated');
    expect(colNames).toContain('status_history');
    db.close();
  });

  it('is idempotent — opening an existing DB does not raise on the column-add path', () => {
    const a = PendingRelayStore.open('echo', tmpDir);
    a.close();
    // Second open should not throw on the duplicate-column ALTER.
    const b = PendingRelayStore.open('echo', tmpDir);
    expect(b.count()).toBe(0);
    b.close();
  });

  it('resolves path with sanitized agent-id (no traversal)', () => {
    const hostile = '../etc/passwd';
    const p = resolvePendingRelayPath(tmpDir, hostile);
    // Sanitization confines the file to the state dir — no parent escape is possible.
    // Resolve symlinks/normalize and confirm the result still lives under tmpDir/state.
    const stateDir = path.join(tmpDir, 'state');
    expect(p.startsWith(stateDir + path.sep)).toBe(true);
    // The basename is a single filename — separators are stripped.
    expect(path.basename(p)).not.toContain('/');
    expect(path.basename(p)).not.toContain(path.sep);
  });
});

describe('PendingRelayStore — enqueue + lookup', () => {
  it('inserts a row and returns true for first insert, false for duplicate', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    const input = {
      delivery_id: '11111111-1111-4111-8111-111111111111',
      topic_id: 50,
      text_hash: 'a'.repeat(64),
      text: 'hello',
      http_code: 503,
      attempted_port: 4042,
    };
    expect(store.enqueue(input)).toBe(true);
    expect(store.enqueue(input)).toBe(false);
    expect(store.count()).toBe(1);
    store.close();
  });

  it('findByDeliveryId returns the row with text round-tripped as Buffer', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    store.enqueue({
      delivery_id: '22222222-2222-4222-8222-222222222222',
      topic_id: 7,
      text_hash: 'b'.repeat(64),
      text: Buffer.from('hi there', 'utf-8'),
      http_code: 502,
      attempted_port: 4042,
      truncated: true,
    });
    const row = store.findByDeliveryId('22222222-2222-4222-8222-222222222222');
    expect(row).not.toBeNull();
    expect(row!.topic_id).toBe(7);
    expect(row!.truncated).toBe(1);
    expect(Buffer.from(row!.text).toString('utf-8')).toBe('hi there');
    expect(row!.state).toBe('queued');
    store.close();
  });

  it('findByTopicAndHashWithin honors the time window', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    const oldTs = new Date(Date.now() - 10_000).toISOString();
    store.enqueue({
      delivery_id: '33333333-3333-4333-8333-333333333333',
      topic_id: 50,
      text_hash: 'c'.repeat(64),
      text: 'old',
      http_code: 503,
      attempted_port: 4042,
      attempted_at: oldTs,
    });
    // Old row outside 5s window — must NOT match.
    expect(store.findByTopicAndHashWithin(50, 'c'.repeat(64), 5_000)).toBeNull();
    // Insert a fresh row.
    store.enqueue({
      delivery_id: '44444444-4444-4444-8444-444444444444',
      topic_id: 50,
      text_hash: 'c'.repeat(64),
      text: 'new',
      http_code: 503,
      attempted_port: 4042,
    });
    const hit = store.findByTopicAndHashWithin(50, 'c'.repeat(64), 5_000);
    expect(hit).not.toBeNull();
    expect(hit!.delivery_id).toBe('44444444-4444-4444-8444-444444444444');
    store.close();
  });
});

describe('PendingRelayStore — transition', () => {
  it('updates state and appends to status_history', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    store.enqueue({
      delivery_id: '55555555-5555-4555-8555-555555555555',
      topic_id: 1,
      text_hash: 'd'.repeat(64),
      text: 'x',
      http_code: 503,
      attempted_port: 4042,
    });
    expect(
      store.transition('55555555-5555-4555-8555-555555555555', 'claimed', {
        claimed_by: 'bootA:1234:9999',
      }),
    ).toBe(true);
    const row = store.findByDeliveryId('55555555-5555-4555-8555-555555555555')!;
    expect(row.state).toBe('claimed');
    expect(row.claimed_by).toBe('bootA:1234:9999');
    const hist = JSON.parse(row.status_history) as Array<{ state: string }>;
    expect(hist.length).toBe(2);
    expect(hist[0].state).toBe('queued');
    expect(hist[1].state).toBe('claimed');
    store.close();
  });

  it('returns false when transitioning a missing delivery_id', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    expect(store.transition('00000000-0000-4000-8000-000000000000', 'claimed')).toBe(false);
    store.close();
  });
});

describe('assertSqliteAvailable', () => {
  it('returns ok=true when better-sqlite3 works in-process', () => {
    const result = assertSqliteAvailable();
    expect(result.ok).toBe(true);
    // cliPresent depends on host environment; both true and false are valid.
    expect(typeof result.cliPresent).toBe('boolean');
  });
});
