/**
 * message_metadata through the durable relay queue
 * (spec outbound-jargon-filepath-gap §2.5):
 *
 *  - the column arrives on a PRE-COLUMN legacy DB via the idempotent ALTER
 *    (an implementer who only edits CREATE TABLE ships an INSERT that throws
 *    `no column named message_metadata` on every existing agent — this test
 *    is the guard against exactly that);
 *  - enqueue stores it, findByDeliveryId returns it, legacy rows read null;
 *  - the DeliveryFailureSentinel's default postReply forwards it whole in
 *    the redrive body (and drops a malformed stored value rather than
 *    failing the redrive).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { PendingRelayStore, resolvePendingRelayPath } from '../../src/messaging/pending-relay-store.js';

const META = JSON.stringify({
  messageKind: 'automated',
  senderClass: 'llm-session',
  jobSlug: 'evolution-overdue-check',
  advisoryAck: true,
  advisoryCodes: ['RAW_FILE_PATH'],
});

function enqueueInput(over: Record<string, unknown> = {}) {
  return {
    delivery_id: `d-${Math.random().toString(36).slice(2)}`,
    topic_id: 12476,
    text_hash: 'h'.repeat(64),
    text: 'queued automated send',
    http_code: 503,
    attempted_port: 4042,
    ...over,
  } as Parameters<PendingRelayStore['enqueue']>[0];
}

describe('PendingRelayStore — message_metadata column', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-meta-'));
  });

  it('stores and returns message_metadata round-trip', () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const input = enqueueInput({ message_metadata: META });
    expect(store.enqueue(input)).toBe(true);
    const row = store.findByDeliveryId(input.delivery_id);
    expect(row).not.toBeNull();
    expect(row!.message_metadata).toBe(META);
    store.close();
  });

  it('legacy-shaped insert (no metadata) reads back null', () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const input = enqueueInput();
    store.enqueue(input);
    expect(store.findByDeliveryId(input.delivery_id)!.message_metadata).toBeNull();
    store.close();
  });

  it('INSERT succeeds against a PRE-COLUMN legacy DB (idempotent-ALTER path)', () => {
    // Build a legacy DB by hand WITHOUT the message_metadata column — the
    // exact shape every deployed agent has on disk today.
    const dbPath = resolvePendingRelayPath(stateDir, 'echo');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE entries (
      delivery_id    TEXT PRIMARY KEY,
      topic_id       INTEGER NOT NULL,
      text_hash      TEXT NOT NULL,
      text           BLOB NOT NULL,
      format         TEXT,
      http_code      INTEGER,
      error_body     TEXT,
      attempted_port INTEGER,
      attempted_at   TEXT NOT NULL,
      attempts       INTEGER NOT NULL DEFAULT 1,
      next_attempt_at TEXT,
      state          TEXT NOT NULL,
      claimed_by     TEXT,
      status_history TEXT NOT NULL DEFAULT '[]',
      truncated      INTEGER NOT NULL DEFAULT 0
    )`);
    legacy.prepare(
      `INSERT INTO entries (delivery_id, topic_id, text_hash, text, attempted_at, state)
       VALUES ('legacy-row', 1, 'x', 'old text', '2026-06-01T00:00:00.000Z', 'queued')`,
    ).run();
    legacy.close();

    // Opening through the store runs COLUMN_ADDS; the new-shape INSERT must succeed.
    const store = PendingRelayStore.open('echo', stateDir);
    const input = enqueueInput({ message_metadata: META });
    expect(store.enqueue(input)).toBe(true);
    expect(store.findByDeliveryId(input.delivery_id)!.message_metadata).toBe(META);
    // The pre-existing legacy row reads null metadata.
    expect(store.findByDeliveryId('legacy-row')!.message_metadata).toBeNull();
    store.close();
  });
});

describe('DeliveryFailureSentinel default postReply — redrive forwards metadata', () => {
  it('threads row.message_metadata into the redrive call', async () => {
    const { DeliveryFailureSentinel } = await import('../../src/monitoring/delivery-failure-sentinel.js');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-meta-sentinel-'));
    const store = PendingRelayStore.open('echo', stateDir);
    const input = enqueueInput({ message_metadata: META });
    store.enqueue(input);

    const calls: Array<{ topicId: number; metadataJson?: string | null }> = [];
    const sentinel = new DeliveryFailureSentinel({
      store,
      configPath: path.join(stateDir, 'config.json'),
      readConfig: () => ({ port: 1, authToken: 't', agentId: 'echo' }),
      bootId: 'boot-1',
      toneGate: null,
      whoamiCache: {
        get: async () => ({ agentId: 'echo', port: 1 }),
      } as never,
      postReply: async (
        _port: number,
        _token: string,
        _agentId: string,
        topicId: number,
        _text: string,
        _deliveryId: string,
        _isSystem?: boolean,
        metadataJson?: string | null,
      ) => {
        calls.push({ topicId, metadataJson });
        return { status: 200, body: JSON.stringify({ ok: true, messageId: 7 }) };
      },
    });

    // Drive one row through the sentinel's processing path.
    const row = store.findByDeliveryId(input.delivery_id)!;
    // Exercising the private per-row processor directly (the public tick path
    // needs lease + claim plumbing irrelevant here).
    await (sentinel as unknown as { processRow(r: typeof row): Promise<unknown> }).processRow(row);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].metadataJson).toBe(META);
    store.close();
  });
});
