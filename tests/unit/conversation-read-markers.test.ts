/**
 * Unit tests for the read markers (docs/specs/mobile-unread-messages.md §3.1–§3.4, §10):
 * positions and order across platforms, refs and reader keys, the forward-only merge (order
 * independence, replay, an older write ignored, the earliest baseline), the counting walk per
 * platform (own reply, other people, a page past 100, the window ending early, no marker plus a
 * baseline, mixed timestamp precision), the replicated kind's schema, the coalesced emit with
 * retry after a refusal, the state file as the outbox, removal evidence and the size alarm.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConversationReadMarkerStore, canonicalConversationRef, comparePositions, countUnread, deriveReadMarkerRecordKey, isReaderKey,
  parseReaderKey, readMarkerRecordStoreSchema, readerKeyFor, telegramRowId, validateReadMarkerWire, buildReadMarkerRecordData,
  READ_MARKERS_KIND_REGISTRATION, BASELINE_REF, type CountRow,
} from '../../src/core/ConversationReadMarkers.js';
import { ConversationUnreadService, type Reader } from '../../src/core/ConversationUnreadService.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { ResolvedPerson } from '../../src/core/MobilePeople.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/conversation-read-markers.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'read-markers-')); dirs.push(d); return d; };
const UUID = '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const owner: ResolvedPerson = { ok: true, role: 'owner', userId: null, name: 'Justin', telegramUserId: 42 };
const ctx = { countDroppedField: () => undefined } as never;

describe('positions, refs and reader keys (§3.1)', () => {
  it('orders by milliseconds, then id by code units', () => {
    expect(comparePositions({ atMs: 1, id: 'b' }, { atMs: 2, id: 'a' })).toBeLessThan(0);
    expect(comparePositions({ atMs: 2, id: 'a' }, { atMs: 2, id: 'b' })).toBeLessThan(0);
    expect(comparePositions({ atMs: 2, id: 'b' }, { atMs: 2, id: 'b' })).toBe(0);
    expect(comparePositions({ atMs: 2, id: 'in:10' }, { atMs: 2, id: '' })).toBeGreaterThan(0); // a baseline position sorts first at its time
  });
  it('derives Telegram ids as the history route does: eventId, else in:/out: + the message number', () => {
    expect(telegramRowId({ eventId: 'ev-1', fromUser: true, messageId: 5 })).toBe('ev-1');
    expect(telegramRowId({ fromUser: true, messageId: 5 })).toBe('in:5');
    expect(telegramRowId({ fromUser: false, messageId: 6 })).toBe('out:6');
    expect(telegramRowId({ fromUser: false })).toBeNull();
  });
  it('canonicalises refs and refuses the rest', () => {
    expect(canonicalConversationRef(UUID.toUpperCase())).toBe(`app:${UUID}`);
    expect(canonicalConversationRef(`app:${UUID}`)).toBe(`app:${UUID}`);
    expect(canonicalConversationRef('telegram:007')).toBe('telegram:7');
    expect(canonicalConversationRef('telegram:0')).toBeNull();
    expect(canonicalConversationRef('slack:m1:-12')).toBe('slack:m1:-12');
    expect(canonicalConversationRef('slack:m1:12')).toBeNull();
    expect(canonicalConversationRef('slack:-12')).toBeNull();
    expect(canonicalConversationRef('x')).toBeNull();
  });
  it('reader keys: owner, msp (machine-namespaced), team; a bearer or an unresolved person has none', () => {
    expect(readerKeyFor(owner, 'm1')).toBe('owner');
    expect(readerKeyFor({ ok: true, role: 'msp', userId: 'u1', name: 'Pat', telegramUserId: null }, 'm1')).toBe('msp:m1:u1');
    expect(readerKeyFor({ ok: true, role: 'team', userId: 'p-7', name: 'Lee', telegramUserId: null, tier: 'member' }, 'm1')).toBe('team:p-7');
    expect(readerKeyFor(null, 'm1')).toBeNull();
    expect(isReaderKey('owner')).toBe(true);
    expect(isReaderKey('msp:m1:u1')).toBe(true);
    expect(isReaderKey('nobody')).toBe(false);
    expect(parseReaderKey('msp:m1:u:1')).toEqual({ role: 'msp', machineId: 'm1', userId: 'u:1' });
  });
});

describe('counting (§3.4)', () => {
  const rows = (...xs: Array<[number, string, boolean?]>): CountRow[] => xs.map(([atMs, id, own]) => ({ atMs, id, own: own === true }));
  it('counts messages after the position that are not the reader\'s own; exact when the position is reached', () => {
    const r = countUnread(rows([50, 'e'], [40, 'd', true], [30, 'c'], [20, 'b'], [10, 'a']), { atMs: 20, id: 'b' }, true);
    // d is the reader's own message: everything before it is read, so only e counts.
    expect(r).toMatchObject({ count: 1, more: false, ownNewest: { atMs: 40, id: 'd' }, effective: { atMs: 40, id: 'd' } });
  });
  it('without an own message, counts down to the marker and stops', () => {
    const r = countUnread(rows([50, 'e'], [30, 'c'], [20, 'b'], [10, 'a']), { atMs: 20, id: 'b' }, false);
    expect(r).toMatchObject({ count: 2, more: false, ownNewest: null });
  });
  it('a baseline counts everything after it; no position counts nothing', () => {
    expect(countUnread(rows([50, 'e'], [30, 'c'], [10, 'a']), { atMs: 30, id: '' }, true).count).toBe(2); // c is at the baseline time, later id ⇒ counted
    expect(countUnread(rows([50, 'e']), null, true)).toMatchObject({ count: 0, more: false });
  });
  it('caps at 100 and says so; a window that ends before the position is a floor', () => {
    const many = Array.from({ length: 150 }, (_, i) => [1000 - i, `m${1000 - i}`] as [number, string]);
    expect(countUnread(rows(...many), { atMs: 1, id: '' }, true)).toMatchObject({ count: 100, more: true });
    expect(countUnread(rows([50, 'e'], [40, 'd']), { atMs: 10, id: 'a' }, false)).toMatchObject({ count: 2, more: true });
    expect(countUnread(rows([50, 'e'], [40, 'd']), { atMs: 10, id: 'a' }, true)).toMatchObject({ count: 2, more: false });
  });
  it('mixed precision: a later row listed after the stop point within one second is still counted', () => {
    // Text order put the 1000 ms row before the 1500 ms row; the marker is the 1000 ms row.
    const r = countUnread(rows([2000, 'z'], [1000, 'm'], [1500, 'n'], [0, 'old']), { atMs: 1000, id: 'm' }, true);
    expect(r.count).toBe(2); // z and n
  });
  it('an own message after the position is never counted and does not move the position once reached', () => {
    const r = countUnread(rows([50, 'e'], [20, 'b'], [15, 'own', true]), { atMs: 20, id: 'b' }, true);
    expect(r).toMatchObject({ count: 1, ownNewest: null, effective: { atMs: 20, id: 'b' } });
  });
});

describe('the replicated kind (§3.3)', () => {
  it('validates markers and baselines, refuses deletes and malformed records', () => {
    expect(validateReadMarkerWire({ reader: 'owner', ref: `app:${UUID}`, atMs: 5, id: 'e1' })).toEqual({ reader: 'owner', ref: `app:${UUID}`, atMs: 5, id: 'e1' });
    expect(validateReadMarkerWire({ reader: 'owner', ref: '*', sinceMs: 9 })).toEqual({ reader: 'owner', ref: '*', sinceMs: 9 });
    expect(validateReadMarkerWire({ reader: 'owner', ref: `APP:${UUID}`, atMs: 5, id: 'e1' })).toBeNull(); // not canonical
    expect(validateReadMarkerWire({ reader: 'owner', ref: 'telegram:1', atMs: -1, id: 'in:1' })).toBeNull();
    expect(validateReadMarkerWire({ reader: 'owner', ref: 'telegram:1', atMs: 1, id: 'bad id with spaces' })).toBeNull();
    expect(readMarkerRecordStoreSchema.validate({ op: 'delete', reader: 'owner', ref: 'telegram:1' }, ctx)).toBeNull();
    expect(readMarkerRecordStoreSchema.validate({ reader: 'owner', ref: 'telegram:1', atMs: 1, id: 'in:1', hlc: {}, op: 'put' }, ctx)).toEqual({ reader: 'owner', ref: 'telegram:1', atMs: 1, id: 'in:1' });
    expect(READ_MARKERS_KIND_REGISTRATION).toMatchObject({ kind: 'conversation-read-marker', store: 'readMarkers' });
    const data = buildReadMarkerRecordData({ reader: 'owner', ref: 'telegram:1', atMs: 1, id: 'in:1' })({ physical: 1, logical: 0, node: 'm1' } as never, 'm1');
    expect(data).toMatchObject({ recordKey: deriveReadMarkerRecordKey('owner', 'telegram:1'), op: 'put', origin: 'm1', atMs: 1 });
  });
});

describe('the store (§3.2, §3.3)', () => {
  it('forward-only advance; earliest baseline; a replay is a no-op', () => {
    const s = new ConversationReadMarkerStore({ stateDir: tmp() });
    expect(s.advance('owner', 'telegram:1', { atMs: 10, id: 'in:1' })).toBe('advanced');
    expect(s.advance('owner', 'telegram:1', { atMs: 5, id: 'in:0' })).toBe('no-op');
    expect(s.advance('owner', 'telegram:1', { atMs: 10, id: 'in:1' })).toBe('no-op');
    expect(s.advance('owner', 'telegram:1', { atMs: 10, id: 'in:2' })).toBe('advanced');
    expect(s.markerFor('owner', 'telegram:1')).toEqual({ atMs: 10, id: 'in:2' });
    expect(s.setBaseline('owner', 100)).toBe('set');
    expect(s.setBaseline('owner', 200)).toBe('no-op');
    expect(s.setBaseline('owner', 50)).toBe('set');
    expect(s.baselineFor('owner')).toBe(50);
    expect(s.storedPosition('owner', 'telegram:9')).toEqual({ atMs: 50, id: '' });
    s.stop();
  });
  it('landing merges order-independently and never emits; a landed key is not re-sent', () => {
    const a = new ConversationReadMarkerStore({ stateDir: tmp() });
    const b = new ConversationReadMarkerStore({ stateDir: tmp() });
    const r1 = { reader: 'owner', ref: 'telegram:1', atMs: 10, id: 'in:1' };
    const r2 = { reader: 'owner', ref: 'telegram:1', atMs: 20, id: 'in:2' };
    const b1 = { reader: 'owner', ref: '*', sinceMs: 300 };
    const b2 = { reader: 'owner', ref: '*', sinceMs: 100 };
    expect([a.ingestReplicated(r1), a.ingestReplicated(r2), a.ingestReplicated(b1), a.ingestReplicated(b2)]).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect([b.ingestReplicated(r2), b.ingestReplicated(r1), b.ingestReplicated(b2), b.ingestReplicated(b1)]).toEqual(['accepted', 'ignored', 'accepted', 'ignored']);
    expect(a.markerFor('owner', 'telegram:1')).toEqual(b.markerFor('owner', 'telegram:1'));
    expect(a.baselineFor('owner')).toBe(100);
    expect(b.baselineFor('owner')).toBe(100);
    expect(a.ingestReplicated({ reader: 'owner', ref: 'telegram:1', atMs: 1 })).toBe('invalid');
    const emitted: unknown[] = [];
    a.setReplicationHook((w) => { emitted.push(w); return 'accepted'; });
    expect(a.flushEmits(true)).toEqual({ emitted: 0, held: 0 }); // learned from a peer ⇒ nothing due
    expect(emitted).toEqual([]);
    a.stop(); b.stop();
  });
  it('removal evidence refuses a landing; a removed ref stays refused after a reload', () => {
    const dir = tmp();
    const s = new ConversationReadMarkerStore({ stateDir: dir, removalEvidence: (_r, ref) => ref === 'slack:m1:-5' });
    expect(s.ingestReplicated({ reader: 'owner', ref: 'slack:m1:-5', atMs: 1, id: 'slack:1.0' })).toBe('refused');
    s.advance('owner', 'slack:m1:-6', { atMs: 1, id: 'slack:1.0' });
    expect(s.removeRef('slack:m1:-6', true)).toBe(2);
    s.stop();
    const again = new ConversationReadMarkerStore({ stateDir: dir });
    expect(again.isRemovedRef('slack:m1:-6')).toBe(true);
    expect(again.ingestReplicated({ reader: 'owner', ref: 'slack:m1:-6', atMs: 1, id: 'slack:1.0' })).toBe('refused');
    // Telegram markers are never removed; a marker that arrives before its conversation is kept.
    expect(again.ingestReplicated({ reader: 'owner', ref: 'telegram:777', atMs: 1, id: 'in:1' })).toBe('accepted');
    again.stop();
  });
  it('emits are coalesced per key, retried after a refusal, and the file is the outbox across a restart', () => {
    vi.useFakeTimers();
    try {
      const dir = tmp();
      let now = 1_000_000;
      const s = new ConversationReadMarkerStore({ stateDir: dir, now: () => now, flushIntervalMs: 5, emitThrottleMs: 10_000 });
      const out: Array<{ ref: string; atMs?: number }> = [];
      let refuse = false;
      s.setReplicationHook((w) => { out.push({ ref: w.ref, ...('atMs' in w ? { atMs: w.atMs } : {}) }); return refuse ? 'refused' : 'accepted'; });
      s.advance('owner', 'telegram:1', { atMs: 1, id: 'in:1' });
      vi.advanceTimersByTime(10_000); now += 10_000;
      expect(out).toEqual([{ ref: 'telegram:1', atMs: 1 }]); // the first advance went within the window
      // Continuous scrolling: several advances fold into one emit per window.
      for (let i = 2; i <= 6; i++) { s.advance('owner', 'telegram:1', { atMs: i, id: `in:${i}` }); vi.advanceTimersByTime(1000); now += 1000; }
      expect(out).toHaveLength(1);
      vi.advanceTimersByTime(10_000); now += 10_000;
      expect(out).toHaveLength(2);
      expect(out[1]).toEqual({ ref: 'telegram:1', atMs: 6 });
      // A refused emit leaves the key due; it is retried.
      refuse = true;
      s.advance('owner', 'telegram:1', { atMs: 7, id: 'in:7' });
      vi.advanceTimersByTime(10_000); now += 10_000;
      expect(out).toHaveLength(3);
      expect(s.dueCount()).toBe(1);
      refuse = false;
      vi.advanceTimersByTime(10_000); now += 10_000;
      expect(out).toHaveLength(4);
      expect(s.dueCount()).toBe(0);
      // An advance flushed before a crash is emitted after the restart.
      s.setReplicationHook(null);
      s.advance('owner', 'telegram:2', { atMs: 1, id: 'in:1' });
      vi.advanceTimersByTime(10);
      expect(fs.existsSync(path.join(dir, 'state', 'conversation-read-markers.json'))).toBe(true);
      const reborn = new ConversationReadMarkerStore({ stateDir: dir, now: () => now });
      const after: string[] = [];
      reborn.setReplicationHook((w) => { after.push(w.ref); return 'accepted'; });
      vi.advanceTimersByTime(1);
      expect(after).toEqual(['telegram:2']);
      reborn.stop(); s.stop();
    } finally { vi.useRealTimers(); }
  });
  it('the size alarm reports once and drops nothing; the catch-up page is ordered and complete', () => {
    const reports: string[] = [];
    const s = new ConversationReadMarkerStore({ stateDir: tmp(), sizeAlarm: 3, report: (what) => reports.push(what) });
    for (let i = 1; i <= 5; i++) s.advance('owner', `telegram:${i}`, { atMs: i, id: `in:${i}` });
    s.setBaseline('owner', 1);
    expect(reports.filter((r) => r === 'ConversationReadMarkers.size')).toHaveLength(1);
    expect(s.markerCount()).toBe(5);
    const p1 = s.exportPage(null, 4);
    expect(p1.records).toHaveLength(4);
    expect(p1.nextCursor).toBe(p1.records[3]!.recordKey);
    const p2 = s.exportPage(p1.nextCursor, 4);
    expect(p2.records).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    const keys = [...p1.records, ...p2.records].map((r) => r.recordKey);
    expect([...keys].sort()).toEqual(keys);
    expect([...p1.records, ...p2.records].some((r) => r.ref === BASELINE_REF)).toBe(true);
    s.stop();
  });
});

describe('the service (§3.4–§3.5)', () => {
  type Row = { eventId: string; messageId: string; role: 'operator' | 'agent'; text: string; at: string; machineId: string; deliveryState: 'delivered'; senderRole?: 'owner' | 'msp' | 'team'; senderPerson?: { machineId: string; userId: string } };
  function appStore(rowsByKey: Record<string, Row[]>, tombstoned: string[] = []) {
    let seq = 1;
    return {
      browseMessages: (key: string, _b: unknown, limit = 100) => { const all = [...(rowsByKey[key] ?? [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); return { messages: all.slice(-limit), nextBefore: all.length > limit ? 'more' : null }; },
      getConversation: (key: string) => (rowsByKey[key] || tombstoned.includes(key) ? { conversationKey: key, canonicalKey: `app:${key}`, title: 't', createdAt: null, lastActivity: rowsByKey[key]?.at(-1)?.at ?? null, lastPreview: null, tombstoned: tombstoned.includes(key), ownerPerson: null } : null),
      listConversations: () => ({ conversations: Object.keys(rowsByKey).map((key) => ({ conversationKey: key, canonicalKey: `app:${key}`, title: 't', createdAt: null, lastActivity: rowsByKey[key]!.at(-1)?.at ?? null, lastPreview: null, tombstoned: false, ownerPerson: null })), nextCursor: null }),
      eventAt: (key: string, eventId: string) => rowsByKey[key]?.find((r) => r.eventId === eventId)?.at ?? null,
      newestIngestSeq: (key: string) => (rowsByKey[key]?.length ?? 0) + seq++ * 0,
    };
  }
  const t = (ms: number) => new Date(ms).toISOString();
  const op = (eventId: string, ms: number, extra: Partial<Row> = {}): Row => ({ eventId, messageId: eventId, role: 'operator', text: 'x', at: t(ms), machineId: 'm1', deliveryState: 'delivered', ...extra });
  const ag = (eventId: string, ms: number): Row => ({ eventId, messageId: eventId, role: 'agent', text: 'y', at: t(ms), machineId: 'm1', deliveryState: 'delivered' });

  function service(opts: { rows?: Record<string, Row[]>; telegram?: Array<{ messageId: number; timestamp: string; fromUser: boolean; telegramUserId?: number; via?: string; senderRole?: string; eventId?: string }>; hlc?: number; settled?: boolean }) {
    const store = new ConversationReadMarkerStore({ stateDir: tmp() });
    if (opts.settled !== false) store.markCatchUpSettled();
    const tgRows = opts.telegram ?? [];
    const svc = new ConversationUnreadService({
      store, enabled: () => true, machineId: () => 'm1', app: appStore(opts.rows ?? {}),
      telegram: { history: (id, limit) => (id === 7 ? tgRows.slice(-limit) : []), version: () => tgRows.length, exists: (id) => id === 7 },
      ownerIdentity: () => ({ ownerName: 'Justin', telegramOwnerId: 42, slackOwnerUserId: null }),
      personOfReaderKey: (key) => (key === 'owner' ? owner : null),
      mayUse: () => true, authToken: () => 'tok', hlcNowMs: opts.hlc ? () => opts.hlc! : undefined, now: () => 5_000_000,
    });
    return { svc, store };
  }
  const reader: Reader = { key: 'owner', person: owner, viaDevice: true };

  it('a phone gets its baseline (never ahead of the wall clock); a Bearer reader never does', () => {
    const { svc, store } = service({ hlc: 9_000_000 });
    svc.touchBaseline({ key: 'owner', person: owner, viaDevice: false });
    expect(store.hasBaseline('owner')).toBe(false);
    svc.touchBaseline(reader);
    expect(store.baselineFor('owner')).toBe(5_000_000); // the earlier of the HLC and the wall clock
    svc.stop();
  });
  it('no baseline until the first catch-up has settled', () => {
    const { svc, store } = service({ settled: false });
    svc.touchBaseline(reader);
    expect(store.hasBaseline('owner')).toBe(false);
    svc.stop();
  });
  it('app conversation by uuid: the own-reply inference is stored as a marker and the pre-filter zeros a read row', () => {
    const { svc, store } = service({ rows: { [UUID]: [ag('a1', 100), op('o1', 200), ag('a2', 300)] } });
    store.setBaseline('owner', 0);
    expect(svc.rowFields(reader, { platform: 'app', id: UUID, lastActivity: t(300) })).toEqual({ hasUnread: true, unreadCount: 1, readUpTo: { atMs: 200, id: 'o1' } });
    expect(store.markerFor('owner', `app:${UUID}`)).toEqual({ atMs: 200, id: 'o1' });
    store.advance('owner', `app:${UUID}`, { atMs: 300, id: 'a2' });
    expect(svc.rowFields(reader, { platform: 'app', id: UUID, lastActivity: t(300) })).toEqual({ hasUnread: false, unreadCount: 0, readUpTo: { atMs: 300, id: 'a2' } }); // within the one-second margin ⇒ walked, exact 0
    store.advance('owner', `app:${UUID}`, { atMs: 5000, id: 'zz' });
    expect(svc.rowFields(reader, { platform: 'app', id: UUID, lastActivity: t(300) })).toEqual({ hasUnread: false, unreadCount: 0, readUpTo: { atMs: 5000, id: 'zz' } });
    // No marker and no baseline: nothing is counted.
    const fresh = service({ rows: { [UUID]: [ag('a1', 100)] } });
    expect(fresh.svc.rowFields(reader, { platform: 'app', id: UUID, lastActivity: t(100) })).toEqual({ hasUnread: false, unreadCount: 0, readUpTo: null });
    fresh.svc.stop(); svc.stop();
  });
  it('another person\'s operator message counts; a team phone\'s own message does not count for the team reader', () => {
    const team: ResolvedPerson = { ok: true, role: 'team', userId: 'p-7', name: 'Lee', telegramUserId: null, tier: 'member' };
    const { svc, store } = service({ rows: { [UUID]: [op('o1', 100, { senderRole: 'team', senderPerson: { machineId: 'm1', userId: 'p-7' } }), ag('a1', 200), op('o2', 300)] } });
    store.setBaseline('owner', 0); store.setBaseline('team:p-7', 0);
    expect(svc.rowFields(reader, { platform: 'app', id: UUID, lastActivity: t(300) })!.unreadCount).toBe(0); // the owner's o2 is newest: everything before it is read
    expect(svc.rowFields({ key: 'team:p-7', person: team, viaDevice: true }, { platform: 'app', id: UUID, lastActivity: t(300) })!.unreadCount).toBe(2); // a1 and the owner's o2
    svc.stop();
  });
  it('Telegram: the owner\'s own rows by Telegram id or app role; agent rows and others count; ids follow the history route', () => {
    const tg = [
      { messageId: 1, timestamp: t(100), fromUser: false },
      { messageId: 2, timestamp: t(200), fromUser: true, telegramUserId: 42 },
      { messageId: 3, timestamp: t(300), fromUser: false },
      { messageId: 4, timestamp: t(400), fromUser: true, telegramUserId: 99 },
    ];
    const { svc, store } = service({ telegram: tg });
    store.setBaseline('owner', 0);
    expect(svc.rowFields(reader, { platform: 'telegram', id: 7, lastActivity: t(400) })).toEqual({ hasUnread: true, unreadCount: 2, readUpTo: { atMs: 200, id: 'in:2' } });
    expect(svc.readUpTo(reader, 'telegram:7')).toEqual({ atMs: 200, id: 'in:2' });
    expect(svc.holdsRef('telegram:7')).toBe(true);
    expect(svc.holdsRef('telegram:8')).toBe(false);
    svc.stop();
  });
  it('read reports: a held message stores its own position; an unheld one is limited to the newest held; forward-only; the same answer for unknown and forbidden', async () => {
    const { svc, store } = service({ rows: { [UUID]: [ag('a1', 100), ag('a2', 200)] }, telegram: [{ messageId: 1, timestamp: t(100), fromUser: false }] });
    store.setBaseline('owner', 0);
    const r = await svc.report(reader, [{ ref: `app:${UUID}`, id: 'a1', atMs: 999 }], { forwarded: false });
    expect(r).toEqual([{ ref: `app:${UUID}`, ok: true, readUpTo: { atMs: 100, id: 'a1' }, unreadCount: 1 }]);
    // A future position for a message not held here is limited to the newest message here.
    const r2 = await svc.report(reader, [{ ref: `app:${UUID}`, id: 'ghost', atMs: 5_000_000 }], { forwarded: false });
    expect(r2[0]).toMatchObject({ ok: true, readUpTo: { atMs: 200, id: 'a2' }, unreadCount: 0 });
    // Older than the marker: no-op, the answer reads the stored position.
    const r3 = await svc.report(reader, [{ ref: `app:${UUID}`, id: 'a1', atMs: 100 }], { forwarded: false });
    expect(r3[0]).toMatchObject({ ok: true, readUpTo: { atMs: 200, id: 'a2' } });
    // Unknown here with no machine named ⇒ pending; a forwarded request never forwards again ⇒ unknown-conversation.
    expect((await svc.report(reader, [{ ref: 'telegram:555', id: 'in:1', atMs: 1 }], { forwarded: false }))[0]).toMatchObject({ ok: false, error: 'pending' });
    expect((await svc.report(reader, [{ ref: 'telegram:555', id: 'in:1', atMs: 1 }], { forwarded: true }))[0]).toMatchObject({ ok: false, error: 'unknown-conversation' });
    // A key that does not resolve here.
    expect((await svc.report({ key: 'msp:m9:u', person: null, viaDevice: false }, [{ ref: 'telegram:7', id: 'out:1', atMs: 100 }], { forwarded: true }))[0]).toMatchObject({ ok: false, error: 'reader-unknown-here' });
    svc.stop();
  });
  it('parseMarks: 1–50 marks with canonical refs; anything else is refused whole', () => {
    expect(ConversationUnreadService.parseMarks({ marks: [{ ref: UUID.toUpperCase(), id: 'e', atMs: 1, machine: 'm2' }] })).toEqual([{ ref: `app:${UUID}`, id: 'e', atMs: 1, machine: 'm2' }]);
    expect(ConversationUnreadService.parseMarks({ marks: [] })).toBeNull();
    expect(ConversationUnreadService.parseMarks({ marks: Array.from({ length: 51 }, () => ({ ref: 'telegram:1', id: 'in:1', atMs: 1 })) })).toBeNull();
    expect(ConversationUnreadService.parseMarks({ marks: [{ ref: 'telegram:1', id: 'in:1', atMs: 1.5 }] })).toBeNull();
    expect(ConversationUnreadService.parseMarks({ marks: [{ ref: 'nope', id: 'in:1', atMs: 1 }] })).toBeNull();
  });
  it('the badge sums app-conversation unread and counts a triggering reply not landed yet', () => {
    const { svc, store } = service({ rows: { [UUID]: [ag('a1', 100), ag('a2', 200)] } });
    store.setBaseline('owner', 0);
    expect(svc.badgeFor(reader)).toBe(2);
    expect(svc.badgeFor(reader, { conversationKey: UUID, messageId: 'a2' })).toBe(2);
    expect(svc.badgeFor(reader, { conversationKey: UUID, messageId: 'not-here-yet' })).toBe(3);
    expect(svc.badgeFor({ key: 'owner', person: null, viaDevice: true })).toBeNull();
    svc.stop();
  });
  it('a reader is removed only on positive evidence: an unresolvable team key alone is "not known here yet"', () => {
    const { svc, store } = service({});
    store.advance('team:p-9', 'telegram:7', { atMs: 1, id: 'in:1' });
    store.setBaseline('team:p-9', 1);
    expect(svc.gc()).toBe(0); // personOfReaderKey answers null for p-9, but no readerRemoved evidence was given
    expect(store.markerFor('team:p-9', 'telegram:7')).not.toBeNull();
    expect(svc.removalEvidence('team:p-9', 'telegram:7')).toBe(false);
    (svc as unknown as { deps: { readerRemoved?: (k: string) => boolean } }).deps.readerRemoved = (k) => k === 'team:p-9';
    expect(svc.removalEvidence('team:p-9', 'telegram:7')).toBe(true);
    expect(svc.gc()).toBe(2); // the marker and the baseline
    expect(store.hasBaseline('team:p-9')).toBe(false);
    svc.stop();
  });
  it('a mark for a held conversation with no message yet is limited to now, never a future position', async () => {
    const { svc, store } = service({ telegram: [], hlc: 4_000_000 });
    store.setBaseline('owner', 0);
    const r = await svc.report(reader, [{ ref: 'telegram:7', id: 'in:1', atMs: 9_000_000_000 }], { forwarded: false });
    expect(r[0]).toMatchObject({ ok: true, readUpTo: { atMs: 4_000_000, id: 'in:1' } });
    svc.stop();
  });
  it('gc removes markers of a tombstoned app conversation and keeps Telegram markers', () => {
    const rows = { [UUID]: [ag('a1', 100)] };
    const { svc, store } = service({ rows });
    const dead = '11111111-2222-4333-8444-555555555555';
    store.advance('owner', `app:${dead}`, { atMs: 1, id: 'x' });
    store.advance('owner', 'telegram:999', { atMs: 1, id: 'in:1' });
    (svc as unknown as { deps: { app: ReturnType<typeof appStore> } }).deps.app = appStore(rows, [dead]);
    expect(svc.gc()).toBe(1);
    expect(store.markerFor('owner', `app:${dead}`)).toBeNull();
    expect(store.markerFor('owner', 'telegram:999')).not.toBeNull();
    svc.stop();
  });
});
