import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationStore, validateAppEvent, type CreatedEvent } from '../../src/core/AppConversationStore.js';
import { validateAppCreationContext, normalizeCreationParentRef, type AppCreationContext } from '../../src/core/AppCreationContext.js';
import { appEventFromReplicatedData, appConversationRecordStoreSchema } from '../../src/core/AppConversationsReplicatedStore.js';
const key = '2f0c8a3e-1b2c-4d5e-8f90-1234567890ab';
const context: AppCreationContext = { v: 1, source: { kind: 'work-board-card', cardId: 'wc_26e234784f116ae6', projectKey: 'project-a' }, parentConversationKey: 'telegram:145738', parentBasis: 'project' };
const event = (creationContext?: AppCreationContext): CreatedEvent => ({ kind: 'created', eventId: 'created-a', conversationKey: key, title: 'App', at: '2026-11-22T01:00:00.000Z', machineId: 'm1', ...(creationContext ? { creationContext } : {}) });
const stores: AppConversationStore[] = [];
function open(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creation-context-'))) { const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' }); stores.push(store); return { dir, store }; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
describe('creation context validation', () => {
  it('distinguishes unknown parent from explicitly unparented and rejects invented authority', () => {
    expect(validateAppCreationContext({ v: 1, source: { kind: 'person' } })).toEqual({ v: 1, source: { kind: 'person' } });
    expect(validateAppCreationContext({ v: 1, source: { kind: 'person' }, parentConversationKey: null })?.parentConversationKey).toBeNull();
    for (const raw of [{ ...context, parentConversationKey: '-12' }, { ...context, access: 'all' }, { v: 1, source: { kind: 'session' } }, { v: 1, source: { kind: 'person', cardId: 'wc_26e234784f116ae6' } }]) expect(validateAppCreationContext(raw)).toBeNull();
    expect(normalizeCreationParentRef(key)).toBe(`app:${key}`);
    expect(normalizeCreationParentRef('telegram:001')).toBeNull();
    expect(validateAppEvent({ ...event(), creationContext: { v: 2 } })).toBeNull();
  });
  it('preserves validated optional metadata and owner through the new codec while accepting old stripped copies', () => {
    const wire = { ...event(context), kind: undefined, eventKind: 'created', ownerPerson: { machineId: 'm1', userId: 'u1' } };
    const validated = appConversationRecordStoreSchema.validate(wire, {} as never)!;
    expect(validated.creationContext).toEqual(context);
    expect(validated.ownerPerson).toEqual(wire.ownerPerson);
    expect(appEventFromReplicatedData(validated)).toMatchObject(event(context));
    expect(appEventFromReplicatedData({ ...wire, creationContext: undefined })).not.toHaveProperty('creationContext');
  });
});
describe('durable creation observations', () => {
  it('includes hidden live rows in the internal inventory with ordinary pagination', () => {
    const { store } = open(); const other = '3f0c8a3e-1b2c-4d5e-8f90-1234567890ab';
    store.append(event(context)); store.append({ ...event(), conversationKey: other, eventId: 'other' });
    store.hiddenConversationKeys = () => new Set([key]);
    expect(store.listConversations().conversations.map(row => row.conversationKey)).toEqual([other]);
    const first = store.creationInventoryPage({ limit: 1 });
    expect(first.conversations).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
    const second = store.creationInventoryPage({ limit: 1, cursor: first.nextCursor });
    expect([...first.conversations, ...second.conversations].map(row => row.conversationKey).sort()).toEqual([key, other].sort());
    expect(second.nextCursor).toBeNull();
  });
  for (const fullFirst of [false, true]) it(`recovers a complete copy in either duplicate arrival order: ${fullFirst}`, () => {
    let { store, dir } = open();
    store.append(event(fullFirst ? context : undefined));
    const before = store.getCreationGeneration();
    store.appendWithEmit(event(fullFirst ? undefined : context));
    expect(store.getCreationRecord(key)?.creationContext).toEqual(context);
    expect(store.hasCreationConflict(key)).toBe(false);
    if (!fullFirst) expect(store.getCreationGeneration()).toBeGreaterThan(before);
    store.close(); store = open(dir).store;
    expect(store.getCreationRecord(key)?.creationContext).toEqual(context);
    store.rebuildIndex();
    expect(store.getCreationRecord(key)?.creationContext).toEqual(context);
    expect(store.syncEvents(key, null, 100).events).toHaveLength(1);
  });
  for (const baseConflict of [false, true]) it(`persists conflicting ${baseConflict ? 'base' : 'context'} uncertainty across reopen and rebuild`, () => {
    let { store, dir } = open(); store.append(event(context));
    store.append(baseConflict ? { ...event(context), title: 'Different' } : event({ ...context, parentConversationKey: 'telegram:12' }));
    expect(store.hasCreationConflict(key)).toBe(true); expect(store.getCreationRecord(key)).toBeNull();
    store.close(); store = open(dir).store;
    expect(store.hasCreationConflict(key)).toBe(true); store.rebuildIndex();
    expect(store.getCreationRecord(key)).toBeNull();
  });
  it('makes conflict uncertainty visible to another already-open reader', () => {
    const { store, dir } = open(); store.append(event(context)); const reader = open(dir).store;
    const generation = reader.getCreationGeneration();
    store.append(event({ ...context, parentConversationKey: null }));
    expect(reader.getCreationGeneration()).toBeGreaterThan(generation);
    expect(reader.hasCreationConflict(key)).toBe(true);
    reader.append(event(context)); expect(reader.getCreationRecord(key)).toBeNull();
  });
  it('retains conflicts when independent writers learn different complete copies of a stripped event', () => {
    const { store, dir } = open(); store.append(event()); const other = open(dir).store;
    other.append(event()); // Establish its evidence frontier before another writer changes it.
    store.append(event(context));
    other.append(event({ ...context, parentConversationKey: null }));
    expect(other.hasCreationConflict(key)).toBe(true);
    other.rebuildIndex(); expect(other.getCreationRecord(key)).toBeNull();
  });
  it('withholds a deterministic metadata winner that disagrees with the effective existing owner', () => {
    const { store } = open();
    store.append({ ...event(context), eventId: 'z', machineId: 'z', ownerPerson: { machineId: 'z', userId: 'one' } });
    store.append({ ...event(context), eventId: 'a', machineId: 'a', ownerPerson: { machineId: 'a', userId: 'two' } });
    expect(store.getConversation(key)?.ownerPerson?.userId).toBe('one');
    expect(store.hasCreationConflict(key)).toBe(true); expect(store.getCreationRecord(key)).toBeNull();
  });
  it('does not repair unreadable evidence on reads and refuses to silently discard a new observation', () => {
    let { store, dir } = open(); store.append(event(context)); store.close();
    const log = path.join(dir, 'app-conversations', 'creation-evidence.jsonl'); fs.appendFileSync(log, '{torn');
    const before = fs.readFileSync(log, 'utf8'); store = open(dir).store;
    expect(store.getCreationRecord(key)).toBeNull(); expect(fs.readFileSync(log, 'utf8')).toBe(before);
    expect(() => store.append(event({ ...context, parentConversationKey: null }))).toThrow(/unreadable/);
    expect(fs.readFileSync(log, 'utf8')).toBe(before);
  });
});
