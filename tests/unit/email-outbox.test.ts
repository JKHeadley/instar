/**
 * docs/specs/backup-email-sending.md, A durable outbox: record bound and admission cut, the live-set bound,
 * owner text holder-local and deleted at terminal, tombstones a day after terminal (never before), the fold
 * tolerating a tombstone whose put rotated away, rotation with the hourly checkpoint keeping every live row,
 * the budget record (absence is zero, unreadable is exhausted), the emit rate bucket and replication.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  EmailOutbox, OUTBOX_LIVE_SET_MAX, TOMBSTONE_AFTER_MS, budgetKey, validateOutboxRecord, type OutboxRecord,
} from '../../src/email/EmailOutbox.js';
import { EMAIL_OUTBOX_MAX_ENTRY_BYTES, TOPIC_TEXT_MAX_BYTES } from '../../src/email/emailCore.js';
import { emailOutboxStoreSchema, buildEmailOutboxRecordData } from '../../src/email/EmailOutboxReplicatedStore.js';

let dir: string;
let now: number;
const mk = (extra: Partial<ConstructorParameters<typeof EmailOutbox>[0]> = {}) => new EmailOutbox({ stateDir: dir, machineId: 'm_a', now: () => now, ...extra });
const admitOne = (o: EmailOutbox, id: string, topicText = 'the report', ownerText = 'owner text') =>
  o.admit({ id, kind: 'report', subjectHash: 'sh', textHash: 'th', topicText, statusLine: 'Daily: Done', fallbackTopicId: 7, ownerText });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-outbox-'));
  now = Date.parse('2026-11-08T12:00:00Z');
});
afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/email-outbox.test.ts' }));

describe('admission', () => {
  it('writes a pending row, keeps the owner text holder-local and never in a record', () => {
    const o = mk();
    const row = admitOne(o, 'em-row-00000001', 'topic copy', 'SECRET OWNER TEXT');
    expect(row).toMatchObject({ status: 'pending', attempts: 0, topicText: 'topic copy', fallbackTopicId: 7 });
    expect(o.readOwnerText('em-row-00000001')).toBe('SECRET OWNER TEXT');
    expect(fs.readFileSync(path.join(dir, 'state', 'email-outbox', 'outbox.jsonl'), 'utf8')).not.toContain('SECRET OWNER TEXT');
  });
  it('cuts the topic copy to fit the 8 KB field and the 24 KB record, with a closing line', () => {
    const o = mk();
    const row = admitOne(o, 'em-row-00000002', 'x'.repeat(30_000));
    expect(Buffer.byteLength(row.topicText)).toBeLessThanOrEqual(TOPIC_TEXT_MAX_BYTES);
    expect(row.topicText).toMatch(/full report is in our conversation/);
    // JSON escaping can inflate a record: quotes double in size.
    const row2 = admitOne(o, 'em-row-00000003', '"\\'.repeat(4000));
    const line = fs.readFileSync(path.join(dir, 'state', 'email-outbox', 'outbox.jsonl'), 'utf8').trim().split('\n').pop()!;
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(EMAIL_OUTBOX_MAX_ENTRY_BYTES);
    expect(row2.id).toBe('em-row-00000003');
  });
  it('past 200 live rows, admits the status line only', () => {
    const o = mk();
    for (let i = 0; i < OUTBOX_LIVE_SET_MAX; i++) admitOne(o, `em-row-${String(i).padStart(8, '0')}`, 'long report text');
    const row = admitOne(o, 'em-row-overflow1', 'long report text');
    expect(row.topicText).toBe('Daily: Done');
  });
  it('answers an existing row for a repeated id', () => {
    const o = mk();
    admitOne(o, 'em-row-00000004', 'first');
    expect(admitOne(o, 'em-row-00000004', 'second').topicText).toBe('first');
  });
});

describe('terminal rows and tombstones', () => {
  it('deletes the owner text at terminal and tombstones only a day later', () => {
    const o = mk();
    admitOne(o, 'em-row-00000005');
    o.update('em-row-00000005', { status: 'sent', providerId: 'p' });
    expect(o.tombstoneDue()).toBe(0);
    o.update('em-row-00000005', { status: 'delivered' });
    expect(o.readOwnerText('em-row-00000005')).toBeNull();
    now += TOMBSTONE_AFTER_MS - 1000;
    expect(o.tombstoneDue()).toBe(0);
    now += 2000;
    expect(o.tombstoneDue()).toBe(1);
    expect(o.get('em-row-00000005')).toBeNull();
    expect(o.known('em-row-00000005')).toBe(true);
  });
  it('a live row is never tombstoned, however old', () => {
    const o = mk();
    admitOne(o, 'em-row-00000006');
    o.update('em-row-00000006', { status: 'relay-queued', relayId: 'em-row-00000006' });
    now += 10 * TOMBSTONE_AFTER_MS;
    expect(o.tombstoneDue()).toBe(0);
    expect(o.get('em-row-00000006')?.status).toBe('relay-queued');
  });
  it('the fold tolerates a tombstone whose put rotated away', () => {
    fs.mkdirSync(path.join(dir, 'state', 'email-outbox'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'email-outbox', 'outbox.jsonl'), `${JSON.stringify({ recordKey: 'em-row-gone0001', op: 'delete', v: 5 })}\n`);
    const o = mk();
    expect(o.get('em-row-gone0001')).toBeNull();
    expect(o.rows()).toEqual([]);
  });
});

describe('rotation and the hourly checkpoint', () => {
  it('keeps every live row and the day’s budget through rotations past the archives', () => {
    const o = mk({ maxFileBytes: 4096, rotateKeep: 3 });
    admitOne(o, 'em-row-live0001', 'live one');
    o.reserve('2026-11-08');
    o.reserve('2026-11-08');
    // A long relay outage: many terminal rows churn the file through every archive.
    for (let i = 0; i < 200; i++) {
      const id = `em-row-churn${String(i).padStart(3, '0')}`;
      admitOne(o, id, 'x'.repeat(200));
      o.update(id, { status: 'fallen-back' });
      // The spec's premise: retained files hold far more than one checkpoint interval of records.
      if (i % 4 === 0) o.checkpoint('2026-11-08');
    }
    o.checkpoint('2026-11-08');
    const reopened = mk({ maxFileBytes: 4096, rotateKeep: 3 });
    expect(reopened.get('em-row-live0001')?.status).toBe('pending');
    expect(reopened.budget('2026-11-08')).toEqual({ day: '2026-11-08', attempts: 2 });
    expect(fs.existsSync(path.join(dir, 'state', 'email-outbox', 'outbox.jsonl.4'))).toBe(false);
  });
  it('an emit the journal dropped is re-emitted by the next checkpoint', () => {
    let accept = false;
    const emitted: OutboxRecord[] = [];
    const o = mk({ emit: (r) => { if (accept) emitted.push(r); return accept; } });
    admitOne(o, 'em-row-drop0001');
    expect(o.pendingEmits()).toBe(1);
    accept = true;
    now += 1000;
    o.checkpoint('2026-11-08');
    expect(emitted.map((r) => r.recordKey)).toContain('em-row-drop0001');
    expect(o.pendingEmits()).toBe(0);
  });
  it('the emitter’s own bucket admits 20 records a second; the rest wait for the checkpoint', () => {
    let n = 0;
    const o = mk({ emit: () => { n++; return true; } });
    for (let i = 0; i < 30; i++) admitOne(o, `em-row-burst${String(i).padStart(3, '0')}`);
    expect(n).toBe(20);
    expect(o.pendingEmits()).toBe(10);
  });
});

describe('the budget record', () => {
  it('absence is zero, never exhaustion', () => {
    expect(mk().budget('2026-11-08')).toEqual({ day: '2026-11-08', attempts: 0 });
  });
  it('counts a reservation before every attempt, survives a restart, and keeps the exhausted mark', () => {
    const o = mk();
    o.reserve('2026-11-08');
    o.markExhausted('2026-11-08');
    expect(mk().budget('2026-11-08')).toEqual({ day: '2026-11-08', attempts: 1, exhausted: true });
  });
  it('an unreadable record reads as exhausted', () => {
    fs.mkdirSync(path.join(dir, 'state', 'email-outbox'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'email-outbox', 'outbox.jsonl'), `${JSON.stringify({ recordKey: budgetKey('2026-11-08'), op: 'delete', v: 9 })}\n`);
    expect(mk().budget('2026-11-08')).toBe('unreadable');
  });
});

describe('replication', () => {
  it('a peer’s newer version wins; an older one is stale; a malformed one is refused', () => {
    const a = mk();
    const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-outbox-peer-'));
    const b = new EmailOutbox({ stateDir: peerDir, machineId: 'm_b', now: () => now });
    const records: OutboxRecord[] = [];
    const a2 = new EmailOutbox({ stateDir: dir, machineId: 'm_a', now: () => now, emit: (r) => { records.push(r); return true; } });
    admitOne(a2, 'em-row-repl0001');
    now += 10;
    a2.update('em-row-repl0001', { status: 'sent', providerId: 'p', sentAt: new Date(now).toISOString() });
    expect(b.ingestReplicated(records[1])).toBe('added');
    expect(b.ingestReplicated(records[0])).toBe('stale');
    expect(b.get('em-row-repl0001')?.status).toBe('sent');
    expect(b.ingestReplicated({ recordKey: 'x', op: 'put', v: 1 })).toBe('invalid');
    expect(a.rows().length).toBeGreaterThanOrEqual(0);
    SafeFsExecutor.safeRmSync(peerDir, { recursive: true, force: true, operation: 'tests/unit/email-outbox.test.ts' });
  });
  it('the store schema carries the record whole and validates it', () => {
    const rec: OutboxRecord = { recordKey: budgetKey('2026-11-08'), op: 'put', v: 1, budget: { day: '2026-11-08', attempts: 3 } };
    const data = buildEmailOutboxRecordData(rec)({ physical: 1, logical: 0, node: 'm_a' } as never, 'm_a')!;
    expect(emailOutboxStoreSchema.validate(data, {} as never)).toEqual({ rec });
    expect(emailOutboxStoreSchema.validate({ rec: { recordKey: budgetKey('2026-11-08'), op: 'put', v: 1, budget: { day: 'bad', attempts: 1 } } }, {} as never)).toBeNull();
    expect(validateOutboxRecord({ recordKey: 'em-row-x0000001', op: 'put', v: 1, row: { id: 'other' } })).toBeNull();
  });
});
