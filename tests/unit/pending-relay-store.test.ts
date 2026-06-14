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

describe('PendingRelayStore — listStaleClaimable (restore-purge visibility)', () => {
  // A restore-purge deletes queued-undelivered outbound messages; this
  // listing makes every victim traceable BEFORE the delete (per-row log +
  // degradation report). 2026-06-05: five real messages — including a user
  // milestone report — were silently restore-purged during restart churn.

  const futureCutoff = () => new Date(Date.now() + 60_000).toISOString();
  const pastCutoff = () => new Date(Date.now() - 60_000).toISOString();

  it('lists queued rows older than the cutoff, text decoded utf-8', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    store.enqueue({
      delivery_id: '33333333-3333-4333-8333-333333333333',
      topic_id: 13435,
      text_hash: 'c'.repeat(64),
      text: 'MILESTONE — the message that must not vanish silently',
      http_code: 0,
      attempted_port: 4042,
    });
    const victims = store.listStaleClaimable(futureCutoff());
    expect(victims).toHaveLength(1);
    expect(victims[0].delivery_id).toBe('33333333-3333-4333-8333-333333333333');
    expect(victims[0].topic_id).toBe(13435);
    expect(victims[0].text).toContain('must not vanish silently');
    store.close();
  });

  it('excludes rows newer than the cutoff (fresh queue survives a purge listing)', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    store.enqueue({
      delivery_id: '44444444-4444-4444-8444-444444444444',
      topic_id: 9,
      text_hash: 'd'.repeat(64),
      text: 'fresh',
      http_code: 0,
      attempted_port: 4042,
    });
    expect(store.listStaleClaimable(pastCutoff())).toHaveLength(0);
    store.close();
  });

  it('excludes terminal-state rows (only queued/claimed are purge candidates)', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    store.enqueue({
      delivery_id: '55555555-5555-4555-8555-555555555555',
      topic_id: 9,
      text_hash: 'e'.repeat(64),
      text: 'already handled',
      http_code: 0,
      attempted_port: 4042,
    });
    store.transition('55555555-5555-4555-8555-555555555555', 'delivered-recovered', {});
    expect(store.listStaleClaimable(futureCutoff())).toHaveLength(0);
    store.close();
  });

  it('parity: the listing matches exactly what purgeStaleClaimable deletes', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    for (const n of ['6', '7']) {
      store.enqueue({
        delivery_id: `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`,
        topic_id: 9,
        text_hash: n.repeat(64),
        text: `victim ${n}`,
        http_code: 0,
        attempted_port: 4042,
      });
    }
    const cutoff = futureCutoff();
    const listed = store.listStaleClaimable(cutoff);
    const deleted = store.purgeStaleClaimable(cutoff);
    expect(deleted).toBe(listed.length);
    expect(store.count()).toBe(0);
    store.close();
  });
});

// ── Reap-notify spec R1.3/R1.6 additions ──────────────────────────────

import {
  buildReapNotifyDeliveryId,
  isReapNotifyDeliveryId,
  parseReapNotifyDeliveryId,
  REAP_NOTIFY_DELIVERY_PREFIX,
  REAP_NOTIFY_DELIVERY_PREFIX_UPPER,
} from '../../src/messaging/reap-notice-delivery-id.js';

describe('reap-notice-delivery-id — the ONE typed prefix helper (R1.3)', () => {
  it('builds and parses round-trip', () => {
    const id = buildReapNotifyDeliveryId('notice-abc.123_x');
    expect(id).toBe('reap-notify:notice-abc.123_x');
    expect(isReapNotifyDeliveryId(id)).toBe(true);
    expect(parseReapNotifyDeliveryId(id)).toBe('notice-abc.123_x');
  });

  it('refuses noticeIds outside the charset clamp (prefix contract stays airtight)', () => {
    expect(() => buildReapNotifyDeliveryId('')).toThrow();
    expect(() => buildReapNotifyDeliveryId('has space')).toThrow();
    expect(() => buildReapNotifyDeliveryId('semi;colon')).toThrow();
    expect(() => buildReapNotifyDeliveryId('a:b')).toThrow();
  });

  it('range semantics: prefix bounds match exactly the prefixed ids', () => {
    expect(isReapNotifyDeliveryId('reap-notify:x')).toBe(true);
    expect(isReapNotifyDeliveryId('reap-notify:')).toBe(true); // lower bound inclusive
    expect(isReapNotifyDeliveryId('reap-notify;')).toBe(false); // upper bound exclusive
    expect(isReapNotifyDeliveryId('reap-notifx')).toBe(false);
    expect(isReapNotifyDeliveryId('11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(REAP_NOTIFY_DELIVERY_PREFIX < REAP_NOTIFY_DELIVERY_PREFIX_UPPER).toBe(true);
  });
});

describe('PendingRelayStore — R1.6 held-row purge exemption', () => {
  const mkRow = (store: PendingRelayStore, id: string, nextAttemptAt: string | null) => {
    store.enqueue({
      delivery_id: id,
      topic_id: 42,
      text_hash: 'f'.repeat(64),
      text: `row ${id}`,
      next_attempt_at: nextAttemptAt,
    });
  };

  it('held-row-across-restart: a future-held row survives a restore-purge whose cutoff has passed attempted_at', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    const now = Date.now();
    // Row enqueued "2 hours ago" with a quiet-hours hold releasing in 30 min.
    store.enqueue({
      delivery_id: buildReapNotifyDeliveryId('held-notice'),
      topic_id: 42,
      text_hash: 'a'.repeat(64),
      text: 'a held quiet-hours reap notice',
      attempted_at: new Date(now - 2 * 3600_000).toISOString(),
      next_attempt_at: new Date(now + 30 * 60_000).toISOString(),
    });
    const cutoff = new Date(now - 3600_000).toISOString(); // 60-min purge age
    const nowIso = new Date(now).toISOString();
    expect(store.listStaleClaimable(cutoff, nowIso)).toHaveLength(0);
    expect(store.purgeStaleClaimable(cutoff, nowIso)).toBe(0);
    expect(store.count()).toBe(1); // the held notice survived the restart purge
    store.close();
  });

  it('a row whose hold has ALSO passed the cutoff is still purged (genuinely stale)', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    const now = Date.now();
    store.enqueue({
      delivery_id: buildReapNotifyDeliveryId('stale-notice'),
      topic_id: 42,
      text_hash: 'b'.repeat(64),
      text: 'stale held notice',
      attempted_at: new Date(now - 5 * 3600_000).toISOString(),
      next_attempt_at: new Date(now - 4 * 3600_000).toISOString(), // hold long past
    });
    const cutoff = new Date(now - 3600_000).toISOString();
    const nowIso = new Date(now).toISOString();
    const listed = store.listStaleClaimable(cutoff, nowIso);
    expect(listed).toHaveLength(1);
    expect(listed[0].farFutureClamp).toBe(false);
    expect(store.purgeStaleClaimable(cutoff, nowIso)).toBe(1);
    store.close();
  });

  it('far-future clamp: a next_attempt_at >7 days out is treated as corrupt and purged', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    const now = Date.now();
    store.enqueue({
      delivery_id: buildReapNotifyDeliveryId('corrupt-hold'),
      topic_id: 42,
      text_hash: 'c'.repeat(64),
      text: 'malformed far-future hold',
      attempted_at: new Date(now - 2 * 3600_000).toISOString(),
      next_attempt_at: new Date(now + 30 * 24 * 3600_000).toISOString(), // 30 days out
    });
    const cutoff = new Date(now - 3600_000).toISOString();
    const nowIso = new Date(now).toISOString();
    const listed = store.listStaleClaimable(cutoff, nowIso);
    expect(listed).toHaveLength(1);
    expect(listed[0].farFutureClamp).toBe(true); // flagged as clamp-purged, not ordinary staleness
    expect(store.purgeStaleClaimable(cutoff, nowIso)).toBe(1);
    expect(store.count()).toBe(0);
    store.close();
  });

  it('far-future clamp other side: a hold just inside 7 days survives', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    const now = Date.now();
    mkRow(store, buildReapNotifyDeliveryId('long-hold'), new Date(now + 6 * 24 * 3600_000).toISOString());
    // attempted_at is "now", so also age it past the cutoff:
    store.rawDb()
      .prepare("UPDATE entries SET attempted_at = @old")
      .run({ old: new Date(now - 2 * 3600_000).toISOString() });
    const cutoff = new Date(now - 3600_000).toISOString();
    const nowIso = new Date(now).toISOString();
    expect(store.purgeStaleClaimable(cutoff, nowIso)).toBe(0);
    expect(store.count()).toBe(1);
    store.close();
  });
});

describe('PendingRelayStore — origin-scoped claims (R1.3 single-owner contract)', () => {
  const enqueueBoth = (store: PendingRelayStore) => {
    store.enqueue({
      delivery_id: buildReapNotifyDeliveryId('n1'),
      topic_id: 1,
      text_hash: 'a'.repeat(64),
      text: 'reap notice',
    });
    store.enqueue({
      delivery_id: '99999999-9999-4999-8999-999999999999',
      topic_id: 2,
      text_hash: 'b'.repeat(64),
      text: 'relay row',
      http_code: 503,
      attempted_port: 4042,
    });
  };

  it('selectClaimable (DFS path) excludes reap-notify rows; selectClaimableReapNotices is the exact complement', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    enqueueBoth(store);
    const nowIso = new Date(Date.now() + 1000).toISOString();
    const dfsRows = store.selectClaimable(nowIso);
    const reapRows = store.selectClaimableReapNotices(nowIso);
    expect(dfsRows.map((r) => r.delivery_id)).toEqual(['99999999-9999-4999-8999-999999999999']);
    expect(reapRows.map((r) => r.delivery_id)).toEqual(['reap-notify:n1']);
    store.close();
  });

  it('a future hold keeps a reap-notify row unclaimable until release', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    const release = new Date(Date.now() + 3600_000).toISOString();
    store.enqueue({
      delivery_id: buildReapNotifyDeliveryId('held'),
      topic_id: 1,
      text_hash: 'a'.repeat(64),
      text: 'held notice',
      next_attempt_at: release,
    });
    expect(store.selectClaimableReapNotices(new Date().toISOString())).toHaveLength(0);
    expect(store.selectClaimableReapNotices(new Date(Date.parse(release) + 1000).toISOString())).toHaveLength(1);
    store.close();
  });

  it('claimCas: two racing claimants on the same row — exactly one wins (asserted at the query level)', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    enqueueBoth(store);
    const row = store.selectClaimableReapNotices(new Date(Date.now() + 1000).toISOString())[0];
    const winA = store.claimCas(row.delivery_id, 'boot-a:1:lease', {
      state: row.state,
      claimed_by: row.claimed_by,
    });
    const winB = store.claimCas(row.delivery_id, 'boot-b:2:lease', {
      state: row.state,
      claimed_by: row.claimed_by,
    });
    expect(winA).toBe(true);
    expect(winB).toBe(false); // CAS lost — row no longer matches the observed snapshot
    const after = store.findByDeliveryId(row.delivery_id)!;
    expect(after.state).toBe('claimed');
    expect(after.claimed_by).toBe('boot-a:1:lease');
    store.close();
  });

  it('claimCas can reclaim a stale lease by CAS-ing against the observed claimed_by', () => {
    const store = PendingRelayStore.open('echo', tmpDir);
    enqueueBoth(store);
    const id = buildReapNotifyDeliveryId('n1');
    store.claimCas(id, 'dead-boot:9:expired-lease', { state: 'queued', claimed_by: null });
    // New drain observes the stale claim and CAS-reclaims it.
    const ok = store.claimCas(id, 'live-boot:1:fresh-lease', {
      state: 'claimed',
      claimed_by: 'dead-boot:9:expired-lease',
    });
    expect(ok).toBe(true);
    expect(store.findByDeliveryId(id)!.claimed_by).toBe('live-boot:1:fresh-lease');
    store.close();
  });
});
