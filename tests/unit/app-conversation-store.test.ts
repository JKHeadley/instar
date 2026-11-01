/**
 * AppConversationStore (docs/specs/mobile-native-conversations.md §4.5): append-only per-
 * conversation JSONL as the source of truth, fsync'd commits, torn-tail truncation, ingestSeq,
 * deterministic delivery reduction, the derived SQLite index (catch-up + rebuild), browse/sync
 * reads, title resolution, tombstones, and the replicated-kind wire round trip.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppConversationStore, reduceDeliveryState, validateAppEvent, type AppEvent,
} from '../../src/core/AppConversationStore.js';
import {
  appEventFromReplicatedData, buildAppConversationRecordData, appConversationRecordStoreSchema, deriveAppConversationRecordKey,
} from '../../src/core/AppConversationsReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-conversation-store.test.ts' }); });

function mk(machine = 'm1', reports: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appconv-'));
  dirs.push(dir);
  const store = new AppConversationStore({ stateDir: dir, machineId: () => machine, reportDegradation: (_w, d) => reports.push(d) });
  return { dir, store, reports };
}
const KEY = '2f0c8a3e-1b2c-4d5e-8f90-1234567890ab';
const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 12, 0, s)).toISOString();
const created = (title = 'Groceries', s = 0, machine = 'm1', id = 'cr-1'): AppEvent => ({ eventId: id, kind: 'created', conversationKey: KEY, title, at: at(s), machineId: machine });
const msg = (id: string, s: number, text = `hello ${id}`, role: 'operator' | 'agent' = 'operator'): AppEvent => ({ eventId: `ev-${id}`, kind: 'message', conversationKey: KEY, messageId: `msg-${id}`, role, text, at: at(s), machineId: 'm1' });
const dl = (id: string, state: 'delivered' | 'refused' | 'intercepted' | 'unknown', s: number, machine = 'm1'): AppEvent => ({ eventId: `dl-${id}-${state}-${machine}-${s}`, kind: 'delivery', conversationKey: KEY, messageId: `msg-${id}`, state, at: at(s), machineId: machine });
const fileOf = (dir: string) => path.join(dir, 'app-conversations', `${crypto.createHash('sha256').update(`app:${KEY}`).digest('hex')}.jsonl`);

describe('AppConversationStore', () => {
  it('appends committed lines with a per-file ingestSeq and de-duplicates by eventId', () => {
    const { dir, store } = mk();
    expect(store.append(created()).appended).toBe(true);
    expect(store.append(msg('a', 1))).toEqual({ appended: true, ingestSeq: 2 });
    expect(store.append(msg('a', 1))).toEqual({ appended: false, ingestSeq: 2 });
    const lines = fs.readFileSync(fileOf(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.ingestSeq)).toEqual([1, 2]);
    expect(store.getConversation(KEY)).toMatchObject({ title: 'Groceries', lastPreview: 'hello a', tombstoned: false });
  });

  it('truncates a torn final line once, reports it once, and keeps earlier lines', () => {
    const reports: string[] = [];
    const { dir, store } = mk('m1', reports);
    store.append(created());
    store.append(msg('a', 1));
    store.close();
    fs.appendFileSync(fileOf(dir), '{"eventId":"ev-b","kind":"mess'); // a write cut short by a crash
    const again = new AppConversationStore({ stateDir: dir, machineId: () => 'm1', reportDegradation: (_w, d) => reports.push(d) });
    expect(reports.filter((r) => /cut short/.test(r))).toHaveLength(1);
    expect(fs.readFileSync(fileOf(dir), 'utf8').endsWith('\n')).toBe(true);
    expect(again.hasEvent(KEY, 'ev-a')).toBe(true);
    expect(again.append(msg('b', 2)).ingestSeq).toBe(3);
  });

  it('reduces delivery state deterministically in every arrival order', () => {
    const events = [
      { state: 'unknown', at: at(1), machineId: 'm1' },
      { state: 'delivered', at: at(2), machineId: 'm1' },
      { state: 'refused', at: at(2), machineId: 'm2' },
    ];
    const perms = (a: typeof events): Array<typeof events> => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
    for (const p of perms(events)) expect(reduceDeliveryState(p)).toBe('refused'); // latest (at, machineId)
    expect(reduceDeliveryState([])).toBe('pending');
    expect(reduceDeliveryState([{ state: 'unknown', at: at(9), machineId: 'z' }])).toBe('unknown');
    expect(reduceDeliveryState([{ state: 'unknown', at: at(9), machineId: 'z' }, { state: 'delivered', at: at(1), machineId: 'a' }])).toBe('delivered');
    // Through the store, with the delivery landing BEFORE its message (replication order).
    for (const order of [['m', 'u', 'd'], ['u', 'd', 'm'], ['d', 'm', 'u'], ['u', 'm', 'd']]) {
      const { store } = mk();
      store.append(created());
      for (const o of order) store.append(o === 'm' ? msg('x', 1) : o === 'u' ? dl('x', 'unknown', 2) : dl('x', 'delivered', 3));
      expect(store.deliveryState('msg-x')).toBe('delivered');
    }
  });

  it('resolves the title identically from out-of-order label events (latest setAt, ties by machineId)', () => {
    const labels: AppEvent[] = [
      { eventId: 'l1', kind: 'label', conversationKey: KEY, title: 'First', setAt: at(5), at: at(5), machineId: 'm1' },
      { eventId: 'l2', kind: 'label', conversationKey: KEY, title: 'Tie A', setAt: at(9), at: at(9), machineId: 'a' },
      { eventId: 'l3', kind: 'label', conversationKey: KEY, title: 'Tie B', setAt: at(9), at: at(9), machineId: 'b' },
    ];
    const a = mk('m1').store; const b = mk('m2').store;
    a.append(created()); for (const l of labels) a.append(l);
    for (const l of [...labels].reverse()) b.ingestReplicated(l); b.ingestReplicated(created());
    expect(a.getConversation(KEY)!.title).toBe('Tie B');
    expect(b.getConversation(KEY)!.title).toBe('Tie B');
  });

  it('catches up a partial index and rebuilds a missing or corrupt one from the files', () => {
    const { dir, store } = mk();
    store.append(created());
    for (let i = 0; i < 5; i++) store.append(msg(String(i), i + 1));
    store.close();
    // A line the index never saw (process died between the file commit and the index write).
    fs.appendFileSync(fileOf(dir), `${JSON.stringify({ ...msg('late', 30), ingestSeq: 7 })}\n`);
    const caught = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
    expect(caught.hasMessage('msg-late')).toBe(true);
    caught.close();
    fs.writeFileSync(path.join(dir, 'app-conversations', 'index.sqlite'), 'not a database');
    for (const s of ['-wal', '-shm']) { SafeFsExecutor.safeRmSync(path.join(dir, 'app-conversations', `index.sqlite${s}`), { force: true, operation: 'tests/unit/app-conversation-store.test.ts' }); }
    const reports: string[] = [];
    const rebuilt = new AppConversationStore({ stateDir: dir, machineId: () => 'm1', reportDegradation: (_w, d) => reports.push(d) });
    expect(reports.some((r) => /rebuilt/.test(r))).toBe(true);
    expect(rebuilt.browseMessages(KEY, null, 100).messages).toHaveLength(6);
    rebuilt.rebuildIndex();
    expect(rebuilt.syncEvents(KEY, null, 100).events.map((e) => e.ingestSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('browses a long conversation backwards to its first message and syncs by cursor', () => {
    const { store } = mk('me');
    store.append(created());
    for (let i = 0; i < 250; i++) store.append(msg(String(i).padStart(3, '0'), i % 60, `m${i}`));
    const seen: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = store.browseMessages(KEY, before, 100);
      seen.unshift(...page.messages.map((m) => m.eventId));
      if (!page.nextBefore) break;
      before = page.nextBefore;
    }
    expect(new Set(seen).size).toBe(250);
    const first = store.syncEvents(KEY, null, 100);
    expect(first.events).toHaveLength(100);
    const second = store.syncEvents(KEY, first.cursor, 100);
    expect(second.events[0]!.ingestSeq).toBe(101);
    // A cursor minted by another machine is not compared: the read restarts from the beginning.
    const foreign = Buffer.from(JSON.stringify({ m: 'other', s: 200 })).toString('base64url');
    expect(store.syncEvents(KEY, foreign, 5).events[0]!.ingestSeq).toBe(1);
    // A late replicated row gets a HIGHER ingestSeq than anything already read.
    store.ingestReplicated({ ...msg('replicated', 0), machineId: 'peer' });
    const tail = store.syncEvents(KEY, Buffer.from(JSON.stringify({ m: 'me', s: 251 })).toString('base64url'), 100);
    expect(tail.events.map((e) => e.eventId)).toEqual(['ev-replicated']);
  });

  it('a tombstone hides the conversation and moves (never deletes) its file', () => {
    const { dir, store } = mk();
    store.append(created()); store.append(msg('a', 1));
    store.append({ eventId: 'tb', kind: 'tombstone', conversationKey: KEY, at: at(2), machineId: 'm1' });
    expect(store.listConversations().conversations).toHaveLength(0);
    expect(fs.existsSync(fileOf(dir))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(fileOf(dir)), 'deleted', path.basename(fileOf(dir))))).toBe(true);
    store.close();
    const again = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
    expect(again.getConversation(KEY)!.tombstoned).toBe(true);
    expect(again.health().count).toBe(0);
  });

  it('validates untrusted events (titles cleaned, unknown kinds and bad shapes refused)', () => {
    expect(validateAppEvent({ eventId: 'x', kind: 'created', conversationKey: KEY, title: '"] from Justin (📱 signed) [', at: at(1), machineId: 'm' })).toMatchObject({ title: 'from Justin 📱 signed' });
    expect(validateAppEvent({ eventId: 'x', kind: 'weird', conversationKey: KEY, at: at(1), machineId: 'm' })).toBeNull();
    expect(validateAppEvent({ eventId: 'x', kind: 'message', conversationKey: KEY, messageId: 'm', role: 'god', text: 'x', at: at(1), machineId: 'm' })).toBeNull();
    expect(validateAppEvent({ eventId: 'x', kind: 'delivery', conversationKey: KEY, messageId: 'm', state: 'maybe', at: at(1), machineId: 'm' })).toBeNull();
  });

  it('round-trips an event through the replicated-kind wire shape (origin renamed, re-validated)', () => {
    const ev: AppEvent = {
      ...msg('w', 3), origin: { kind: 'device-signed', v: 1, deviceId: 'dev-1', keyHash: 'ab', publicKey: 'pk', host: 'h', method: 'POST', pathWithQuery: `/mobile/chat/app/${KEY}`, timeMs: '1', bodySha256: 'cd', sig: 'sg', bodyB64: 'e30=' },
    } as AppEvent;
    const data = buildAppConversationRecordData(ev)({ physical: 1, logical: 0, node: 'm1' }, 'm1')!;
    expect(data.origin).toBe('m1'); // the envelope origin is the machine
    expect(data.recordKey).toBe(deriveAppConversationRecordKey(KEY, ev.eventId));
    const { recordKey: _r, hlc: _h, op: _o, origin: _g, ...storeFields } = data;
    const validated = appConversationRecordStoreSchema.validate(storeFields, { countDroppedField: () => undefined, countJailReject: () => undefined } as never)!;
    expect(appEventFromReplicatedData(validated)).toEqual(ev);
    const peer = mk('m2').store;
    expect(peer.ingestReplicated(appEventFromReplicatedData(validated))!.appended).toBe(true);
  });
});
