/**
 * Conversation-list pins (docs/specs/conversation-list-pins.md): the fold (latest row per person ×
 * conversation by atMs then eventId, order-independent), the pin order (newest pin first), the cap,
 * idempotency, strict validation of replicated rows, landing peers' rows, the outbox re-send at boot,
 * the state file, the kind schema, and the off switch.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  ConversationListPinStore, LIST_PINS_KIND_REGISTRATION, MAX_LIST_PINS_PER_READER, compareListPinEvents, foldListPins,
  isConversationListPinsEnabled, listPinStoreSchema, pinnedRefsOf, validateListPinEvent, deriveListPinRecordKey, buildListPinRecordData,
  type ListPinEvent,
} from '../../src/core/ConversationListPins.js';
import { wireListPinStore } from '../../src/core/ConversationListPinsWiring.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/conversation-list-pins.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'listpins-')); dirs.push(d); return d; };
const A = 'app:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const B = 'telegram:4242';
const C = 'slack:m1:-5';
const ev = (o: Partial<ListPinEvent> = {}): ListPinEvent => ({ eventId: crypto.randomUUID(), reader: 'owner', ref: A, pinned: true, atMs: 1000, ...o });

describe('validation', () => {
  it('accepts exactly the row shape and refuses everything else', () => {
    const good = ev();
    expect(validateListPinEvent(good)).toEqual(good);
    expect(validateListPinEvent({ ...good, eventId: 'nope' })).toBeNull();
    expect(validateListPinEvent({ ...good, eventId: good.eventId.toUpperCase() })).toBeNull();
    expect(validateListPinEvent({ ...good, reader: 'someone' })).toBeNull();
    expect(validateListPinEvent({ ...good, ref: 'telegram:007' })).toBeNull(); // not canonical
    expect(validateListPinEvent({ ...good, ref: 'app:3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B' })).toBeNull();
    expect(validateListPinEvent({ ...good, pinned: 'yes' })).toBeNull();
    expect(validateListPinEvent({ ...good, atMs: -1 })).toBeNull();
    expect(validateListPinEvent({ ...good, atMs: 1.5 })).toBeNull();
    expect(validateListPinEvent(null)).toBeNull();
    expect(validateListPinEvent({ ...good, ref: C, reader: 'team:pk-1' })).toMatchObject({ ref: C, reader: 'team:pk-1' });
  });
});

describe('fold and order', () => {
  it('the latest row per person × conversation wins, in any order', () => {
    const pin = ev({ atMs: 1000, pinned: true });
    const unpin = ev({ atMs: 2000, pinned: false });
    for (const order of [[pin, unpin], [unpin, pin]]) {
      const f = foldListPins(order);
      expect([...f.values()]).toHaveLength(1);
      expect([...f.values()][0]!.pinned).toBe(false);
    }
    // Same atMs: the larger eventId wins, the same on every machine.
    const x = ev({ eventId: '00000000-0000-4000-8000-000000000001', atMs: 5, pinned: true });
    const y = ev({ eventId: 'ffffffff-0000-4000-8000-000000000001', atMs: 5, pinned: false });
    expect(compareListPinEvents(y, x)).toBeGreaterThan(0);
    expect([...foldListPins([y, x]).values()][0]!.pinned).toBe(false);
    expect([...foldListPins([x, y]).values()][0]!.pinned).toBe(false);
  });

  it('a person\'s pinned refs: newest pin first, other people and unpins left out', () => {
    const rows = [ev({ ref: A, atMs: 10 }), ev({ ref: B, atMs: 30 }), ev({ ref: C, atMs: 20, pinned: false }), ev({ ref: C, reader: 'team:pk-1', atMs: 40 })];
    expect(pinnedRefsOf(rows, 'owner')).toEqual([{ ref: B, atMs: 30 }, { ref: A, atMs: 10 }]);
    expect(pinnedRefsOf(rows, 'team:pk-1')).toEqual([{ ref: C, atMs: 40 }]);
  });
});

describe('the store', () => {
  it('pins, is idempotent, unpins, and keeps one row per person × conversation', () => {
    let now = 1000;
    const s = new ConversationListPinStore({ stateDir: tmp(), now: () => now });
    expect(s.setPinned('owner', A, true).outcome).toBe('changed');
    expect(s.setPinned('owner', A, true).outcome).toBe('unchanged');
    now = 2000;
    expect(s.setPinned('owner', B, true).pinned).toEqual([{ ref: B, atMs: 2000 }, { ref: A, atMs: 1000 }]);
    expect(s.setPinned('owner', A, false)).toMatchObject({ outcome: 'changed', pinned: [{ ref: B, atMs: 2000 }] });
    expect(s.setPinned('owner', A, false).outcome).toBe('unchanged');
    expect(s.setPinned('owner', C, false).outcome).toBe('unchanged'); // never pinned: nothing written
    expect(s.rows()).toHaveLength(2);
    expect(s.isPinned('owner', B)).toBe(true);
    expect(s.pinnedFor('team:pk-1')).toEqual([]);
  });

  it('a local change wins over the row it replaces even when the clock runs behind', () => {
    let now = 5000;
    const s = new ConversationListPinStore({ stateDir: tmp(), now: () => now });
    s.setPinned('owner', A, true);
    now = 10; // the clock jumped back
    s.setPinned('owner', A, false);
    expect(s.isPinned('owner', A)).toBe(false);
    expect(s.rows()[0]!.atMs).toBe(5001);
  });

  it('refuses a pin past the cap, but an unpin still works', () => {
    const s = new ConversationListPinStore({ stateDir: tmp(), maxPerReader: 2 });
    s.setPinned('owner', A, true); s.setPinned('owner', B, true);
    expect(s.setPinned('owner', C, true).outcome).toBe('pin-limit');
    expect(s.isPinned('owner', C)).toBe(false);
    expect(s.setPinned('team:pk-1', C, true).outcome).toBe('changed'); // the cap is per person
    expect(s.setPinned('owner', A, false).outcome).toBe('changed');
    expect(s.setPinned('owner', C, true).outcome).toBe('changed');
    expect(MAX_LIST_PINS_PER_READER).toBe(50);
  });

  it('throws on a bad reader or ref (the route validates first)', () => {
    const s = new ConversationListPinStore({ stateDir: tmp() });
    expect(() => s.setPinned('nobody', A, true)).toThrow();
    expect(() => s.setPinned('owner', 'app:not-a-uuid', true)).toThrow();
  });

  it('lands peers\' rows: newer wins, older and invalid are not taken, and a landed row is never re-sent', () => {
    const s = new ConversationListPinStore({ stateDir: tmp(), now: () => 1000 });
    s.setPinned('owner', A, true);
    expect(s.ingestReplicated(ev({ ref: A, atMs: 500, pinned: false }))).toBe('ignored');
    expect(s.isPinned('owner', A)).toBe(true);
    expect(s.ingestReplicated(ev({ ref: A, atMs: 2000, pinned: false }))).toBe('accepted');
    expect(s.isPinned('owner', A)).toBe(false);
    expect(s.ingestReplicated({ ...ev(), reader: 'x' })).toBe('invalid');
    expect(s.ingestReplicatedAll([ev({ ref: B, atMs: 3000 }), { junk: true }])).toBe(1);
    const sent: ListPinEvent[] = [];
    s.setReplicationHook((r) => { sent.push(r); return 'emitted'; });
    expect(s.flushEmits().emitted).toBe(0); // every row here is either emitted already or a peer's
    expect(sent).toHaveLength(0);
  });

  it('the state file is the outbox: a refused emit is sent at the next boot; the file survives a restart', () => {
    const dir = tmp();
    const s = new ConversationListPinStore({ stateDir: dir, now: () => 1000 });
    s.setReplicationHook(() => 'refused');
    s.setPinned('owner', A, true);
    expect(s.dueCount()).toBe(1);
    const mode = fs.statSync(s.filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    const again = new ConversationListPinStore({ stateDir: dir });
    expect(again.pinnedFor('owner')).toEqual([{ ref: A, atMs: 1000 }]);
    const sent: ListPinEvent[] = [];
    again.setReplicationHook((r) => { sent.push(r); return 'emitted'; });
    expect(again.flushEmits()).toEqual({ emitted: 1, held: 0 });
    expect(sent[0]).toMatchObject({ reader: 'owner', ref: A, pinned: true });
    expect(new ConversationListPinStore({ stateDir: dir }).dueCount()).toBe(0);
  });

  it('a throwing emit hook leaves the row due and is reported, never fails the pin', () => {
    const reports: string[] = [];
    const s = new ConversationListPinStore({ stateDir: tmp(), report: (w) => reports.push(w) });
    s.setReplicationHook(() => { throw new Error('journal down'); });
    expect(s.setPinned('owner', A, true).outcome).toBe('changed');
    expect(s.dueCount()).toBe(1);
    expect(reports).toContain('ConversationListPins.emit');
  });

  it('an unreadable state file starts empty and is reported', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'conversation-list-pins.json'), '{not json');
    const reports: string[] = [];
    const s = new ConversationListPinStore({ stateDir: dir, report: (w) => reports.push(w) });
    expect(s.rows()).toEqual([]);
    expect(reports).toContain('ConversationListPins.load');
  });
});

describe('replicated kind and wiring', () => {
  it('registers conversation-list-pin under listPins; the schema keeps a valid row and refuses deletes and junk', () => {
    expect(LIST_PINS_KIND_REGISTRATION).toMatchObject({ kind: 'conversation-list-pin', store: 'listPins' });
    const row = ev();
    const ctx = {} as never;
    expect(listPinStoreSchema.validate({ row }, ctx)).toEqual({ row });
    expect(listPinStoreSchema.validate({ row: { ...row, pinned: 1 } }, ctx)).toBeNull();
    expect(listPinStoreSchema.validate({ row, op: 'delete' }, ctx)).toBeNull();
    const data = buildListPinRecordData(row)({ physical: 1, logical: 0, node: 'm1' } as never, 'm1');
    expect(data).toMatchObject({ row, recordKey: deriveListPinRecordKey(row.eventId), op: 'put', origin: 'm1' });
  });

  it('wiring lands other machines\' rows from the peer streams and sends this machine\'s unsent rows', () => {
    const dir = tmp();
    const pre = new ConversationListPinStore({ stateDir: dir, now: () => 100 });
    pre.setPinned('owner', B, true); // written while the journal was off: unsent
    const peerRow = ev({ ref: A, atMs: 50 });
    const ownRow = ev({ ref: C, atMs: 60 });
    const emitted: Array<{ store: string; key: string }> = [];
    const store = wireListPinStore({
      stateDir: dir, ownMachineId: 'm1', report: () => undefined,
      peerStreams: {
        listRecordKeys: () => ['k1', 'k2'],
        loadOriginRecords: (_s, rk) => (rk === 'k1' ? [{ origin: 'm2', data: { row: peerRow } }] : [{ origin: 'm1', data: { row: ownRow } }]),
      },
      emitter: { emit: (store: string, key: string | null | undefined) => { emitted.push({ store, key: String(key) }); return { outcome: 'emitted' } as never; } },
    });
    expect(store.isPinned('owner', A)).toBe(true); // a peer's row landed
    expect(store.isPinned('owner', C)).toBe(false); // this machine's own stream rows are not re-landed
    expect(emitted).toEqual([{ store: 'listPins', key: expect.stringMatching(/^[0-9a-f]{64}$/) }]); // the unsent local row went out
    expect(store.dueCount()).toBe(0);
  });

  it('a dark store leaves rows unsent for the next boot', () => {
    const dir = tmp();
    const store = wireListPinStore({ stateDir: dir, ownMachineId: 'm1', report: () => undefined, peerStreams: null, emitter: { emit: () => ({ outcome: 'disabled' }) as never } });
    store.setPinned('owner', A, true);
    expect(store.dueCount()).toBe(1);
  });

  it('the off switch: absent means on, false turns it off', () => {
    expect(isConversationListPinsEnabled({} as never)).toBe(true);
    expect(isConversationListPinsEnabled({ mobilePairing: { native: { listPins: { enabled: true } } } } as never)).toBe(true);
    expect(isConversationListPinsEnabled({ mobilePairing: { native: { listPins: { enabled: false } } } } as never)).toBe(false);
  });
});
