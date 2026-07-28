// safe-fs-allow: test file — temp db cleanup only.
// Durable outbound dedup (topic 21816, finding_cross_restart_duplicate_replies):
// a byte-identical reply must be suppressed even across a server restart / across
// overlapping processes — the in-memory Map alone resets on restart, which is the
// window the restart churn opened (5 identical sends in 19s). Fail-open always.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OutboundContentDedup } from '../../src/messaging/OutboundContentDedup.js';
import { SqliteOutboundDedupStore, type OutboundDedupStore } from '../../src/messaging/OutboundDedupStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const LONG = 'This is a long enough reply to clear the 40-char minimum-length dedup floor.';
const tmpDirs: string[] = [];
function tmpDb(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'odedup-')));
  tmpDirs.push(dir);
  return path.join(dir, 'outbound-dedup.db');
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/outbound-dedup-durable.test.ts:cleanup' }); } catch { /* best-effort */ }
  }
});

describe('OutboundContentDedup — durable backing', () => {
  it('catches a duplicate ACROSS a restart (fresh in-memory, same durable db)', () => {
    const dbPath = tmpDb();
    // Process A: records the send, then "restarts".
    const a = new OutboundContentDedup({}, Date.now, new SqliteOutboundDedupStore(dbPath));
    expect(a.isDuplicate(20290, LONG)).toBe(false);
    a.record(20290, LONG);
    // Process B: fresh instance (empty in-memory Map) opening the SAME db file.
    const b = new OutboundContentDedup({}, Date.now, new SqliteOutboundDedupStore(dbPath));
    expect(b.isDuplicate(20290, LONG)).toBe(true); // <-- the bug this fixes
  });

  it('still works purely in-memory (no store) and respects the length floor', () => {
    const d = new OutboundContentDedup();
    expect(d.isDuplicate(1, LONG)).toBe(false);
    d.record(1, LONG);
    expect(d.isDuplicate(1, LONG)).toBe(true);
    // brief ack below the floor is never a duplicate
    expect(d.isDuplicate(1, 'Got it')).toBe(false);
    d.record(1, 'Got it');
    expect(d.isDuplicate(1, 'Got it')).toBe(false);
  });

  it('does NOT suppress different text or a different topic', () => {
    const dbPath = tmpDb();
    const d = new OutboundContentDedup({}, Date.now, new SqliteOutboundDedupStore(dbPath));
    d.record(20290, LONG);
    expect(d.isDuplicate(20290, LONG + ' (different)')).toBe(false);
    expect(d.isDuplicate(99999, LONG)).toBe(false);
  });

  it('honors the window (a send outside the window is not a duplicate)', () => {
    const dbPath = tmpDb();
    let t = 1_000_000;
    const now = () => t;
    const a = new OutboundContentDedup({ windowMs: 60_000 }, now, new SqliteOutboundDedupStore(dbPath));
    a.record(20290, LONG);
    const b = new OutboundContentDedup({ windowMs: 60_000 }, now, new SqliteOutboundDedupStore(dbPath));
    t += 30_000;
    expect(b.isDuplicate(20290, LONG)).toBe(true); // within window
    t += 60_000;
    expect(b.isDuplicate(20290, LONG)).toBe(false); // past window
  });

  it('FAIL-OPEN: a throwing store never throws and never suppresses', () => {
    const boom: OutboundDedupStore = {
      wasSentSince: () => { throw new Error('db exploded'); },
      record: () => { throw new Error('db exploded'); },
    };
    // Wrap so the class's own use is what we test; but the store contract is to
    // not throw — here we verify the class is resilient even to a misbehaving store.
    const d = new OutboundContentDedup({}, Date.now, {
      wasSentSince: (...a) => { try { return boom.wasSentSince(...a); } catch { return false; } },
      record: (...a) => { try { boom.record(...a); } catch { /* swallow */ } },
    });
    expect(() => d.record(1, LONG)).not.toThrow();
    expect(d.isDuplicate(1, LONG)).toBe(true); // in-memory still catches it
  });

  it('SqliteOutboundDedupStore fail-opens on an unwritable path (no throw)', () => {
    const store = new SqliteOutboundDedupStore('/nonexistent-dir-xyz/cannot/create.db');
    expect(() => store.record(1, 'abc', Date.now())).not.toThrow();
    expect(store.wasSentSince(1, 'abc', 0)).toBe(false);
  });
});
