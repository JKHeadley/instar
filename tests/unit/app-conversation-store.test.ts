/**
 * AppConversationStore (docs/specs/mobile-native-conversations.md §4.5): append-only per-
 * conversation JSONL as the source of truth, fsync'd commits, torn-tail truncation, ingestSeq,
 * deterministic delivery reduction, the derived SQLite index (catch-up + rebuild), browse/sync
 * reads, title resolution, tombstones, and the replicated-kind wire round trip.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
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
import { signReplyReceipt, signerKeyHashOf, verifyReplyReceipt, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import Database from 'better-sqlite3';
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
  it('syncs exact authorized removals without replaying the removed message', async () => {
    const { store } = mk();
    const readAll = () => 'allow' as const;
    try {
      store.append(created());
      store.append(msg('shown', 1));
      store.append(msg('removed', 2, 'hidden original'));
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      const awaitingAccess = store.syncRemovalAwareMessageChanges(KEY, null, 100,
        (row) => row.eventId === 'ev-shown' ? 'unknown' : 'allow');
      expect(awaitingAccess).toMatchObject({ changes: [], blocked: true });
      const prior = store.syncRemovalAwareMessageChanges(KEY, awaitingAccess?.cursor, 100, readAll);
      expect(prior?.changes).toHaveLength(2);
      store.append({ kind: 'message-removed', conversationKey: KEY, eventId: 'removal',
        targetEventId: 'ev-removed', targetMessageId: 'msg-removed', machineId: 'm1', at: at(4) });
      expect(store.syncRemovalAwareMessageChanges(KEY, prior?.cursor, 100, readAll)).toBeNull();
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      const marker = { kind: 'message-removed', conversationKey: KEY, eventId: 'removal', targetEventId: 'ev-removed' };
      expect(store.syncRemovalAwareMessageChanges(KEY, prior?.cursor, 100, readAll)?.changes).toEqual([marker]);
      const fresh = store.syncRemovalAwareMessageChanges(KEY, null, 100, readAll);
      expect(fresh?.changes).toEqual([{ kind: 'message', row: expect.objectContaining({ eventId: 'ev-shown' }) }, marker]);
      expect(JSON.stringify(fresh)).not.toContain('hidden original');
      const denied = store.syncRemovalAwareMessageChanges(KEY, null, 100, (row) => row.eventId === 'ev-shown' ? 'allow' : 'deny');
      expect(denied?.changes).toEqual([fresh?.changes[0]]);
      expect(denied?.cursor).toBe(fresh?.cursor);
      const unresolved = store.syncRemovalAwareMessageChanges(KEY, prior?.cursor, 100, () => 'unknown');
      expect(unresolved).toEqual({ changes: [], cursor: prior?.cursor, blocked: true });
      expect(store.syncRemovalAwareMessageChanges(KEY, unresolved?.cursor, 100, readAll)?.changes).toEqual([marker]);
      const earlier = store.syncRemovalAwareMessageChanges(KEY, null, 2, readAll);
      const suppressed = store.syncRemovalAwareMessageChanges(KEY, earlier?.cursor, 1, () => 'unknown');
      expect(suppressed).toMatchObject({ changes: [], blocked: false });
      expect(suppressed?.cursor).toBe(prior?.cursor);
      expect(store.syncRemovalAwareMessageChanges(KEY, suppressed?.cursor, 1, () => 'unknown')?.blocked).toBe(true);
    } finally { store.close(); }
  });

  it('cannot attach a replacement prepared proof to an earlier selected page', async () => {
    const { store } = mk();
    try {
      store.append(created());
      store.append(msg('target', 1));
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      const oldPage = store.syncRemovalAwareMessageChangesAfter(KEY, 0, 100, () => 'allow')!;
      expect(store.hasPreparedRemovalHistory(KEY, oldPage.proof)).toBe(true);
      store.append({ kind: 'message-removed', conversationKey: KEY, eventId: 'new-removal',
        targetEventId: 'ev-target', targetMessageId: 'msg-target', at: at(2), machineId: 'm1' });
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      const newPage = store.syncRemovalAwareMessageChangesAfter(KEY, 0, 100, () => 'allow')!;
      expect(store.hasPreparedRemovalHistory(KEY, oldPage.proof)).toBe(false);
      expect(store.hasPreparedRemovalHistory(KEY, newPage.proof)).toBe(true);
    } finally { store.close(); }
  });

  it('emits a single marker when a removal precedes its original across pages', async () => {
    const { store } = mk();
    try {
      store.append(created());
      const fact = { kind: 'message-removed' as const, conversationKey: KEY, eventId: 'early-removal',
        targetEventId: 'ev-late', targetMessageId: 'msg-late', machineId: 'm1', at: at(3) };
      store.append(fact);
      store.append(msg('after-fact', 4));
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      const beforeTarget = store.syncRemovalAwareMessageChanges(KEY, null, 100, () => 'allow');
      expect(beforeTarget?.changes).toEqual([]);
      expect(beforeTarget?.blocked).toBe(true);
      store.append(msg('late', 2));
      store.append({ ...fact, eventId: 'duplicate-early-removal' });
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      const updated = store.syncRemovalAwareMessageChanges(KEY, beforeTarget?.cursor, 1, () => 'allow');
      expect(updated?.changes).toEqual([{ kind: 'message-removed', conversationKey: KEY, eventId: fact.eventId, targetEventId: fact.targetEventId }]);
      const remaining = store.syncRemovalAwareMessageChanges(KEY, updated?.cursor, 100, () => 'allow');
      expect(remaining?.changes).toEqual([{ kind: 'message', row: expect.objectContaining({ eventId: 'ev-after-fact' }) }]);
      expect(remaining?.blocked).toBe(false);
    } finally { store.close(); }
  });

  it('does not consume a removal when the earlier original has an unreadable index location', async () => {
    const { dir, store } = mk();
    try {
      store.append(created());
      store.append(msg('target', 1));
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      const prior = store.syncRemovalAwareMessageChanges(KEY, null, 100, () => 'allow');
      store.append({ kind: 'message-removed', conversationKey: KEY, eventId: 'removal',
        targetEventId: 'ev-target', targetMessageId: 'msg-target', machineId: 'm1', at: at(2) });
      const db = new Database(path.join(dir, 'app-conversations', 'index.sqlite'));
      try { db.exec("UPDATE events SET byteOffset = 1 WHERE eventId = 'ev-target'"); }
      finally { db.close(); }
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      expect(store.syncRemovalAwareMessageChanges(KEY, prior?.cursor, 1, () => 'allow'))
        .toEqual({ changes: [], cursor: prior?.cursor, blocked: true });
      expect(store.syncRemovalAwareMessageChanges(KEY, null, 100, () => 'allow')).toBeNull();
    } finally { store.close(); }
  });

  it('filters exact removals before visible pagination and preserves raw recovery reads', async () => {
    const { store } = mk();
    store.append(created());
    for (const [id, second] of [['older', 1], ['anchor', 2], ['removed', 3]] as const) store.append(msg(id, second));
    const fact = { kind: 'message-removed' as const, conversationKey: KEY, machineId: 'm1', at: at(5) };
    store.append({ ...fact, eventId: 'correct-removal', targetEventId: 'ev-removed', targetMessageId: 'msg-removed' });
    store.append({ ...fact, eventId: 'wrong-binding', targetEventId: 'ev-older', targetMessageId: 'msg-anchor' });
    expect(store.browseRemovalAwareMessages(KEY, null, 1)).toBeNull();
    expect(await store.prepareRemovalHistory(KEY)).toBe(true);
    const first = store.browseRemovalAwareMessages(KEY, null, 1);
    expect(first?.messages.map((row) => row.eventId)).toEqual(['ev-anchor']);
    expect(first?.nextBefore).toBe(`${at(2)},ev-anchor`);
    expect(store.browseRemovalAwareMessages(KEY, first?.nextBefore, 1)?.messages.map((row) => row.eventId)).toEqual(['ev-older']);
    expect(store.exactRemovalAwareMessageCandidates(KEY, 'ev-removed', 'event', () => true)).toEqual([]);
    expect(store.exactRemovalAwareMessageCandidates(KEY, 'msg-removed', 'message', () => true)).toEqual([]);
    expect(store.exactRemovalAwareMessageCandidates(KEY, 'ev-older', 'event', () => true)?.map((row) => row.eventId)).toEqual(['ev-older']);
    expect(store.getEvent(KEY, 'ev-removed')).toMatchObject({ kind: 'message' });
    expect(store.browseMessages(KEY, null, 1).messages[0]?.eventId).toBe('ev-removed');
    store.append({ ...msg('collision', 6), messageId: 'ev-removed' } as AppEvent);
    expect(await store.prepareRemovalHistory(KEY)).toBe(true);
    expect(store.exactRemovalAwareMessageCandidates(KEY, 'ev-removed', 'legacy', () => true)).toEqual([]);
    expect(store.exactRemovalAwareMessageCandidates(KEY, 'ev-removed', 'legacy', (row) => row.eventId === 'ev-collision')
      ?.map((row) => row.eventId)).toEqual(['ev-collision']);
    expect(store.exactRemovalAwareMessageCandidates(KEY, 'ev-removed', 'legacy', (row) => row.eventId === 'ev-removed')).toEqual([]);
    expect(store.exactRemovalAwareMessageCandidates(KEY, 'ev-removed', 'message', () => true)?.map((row) => row.eventId)).toEqual(['ev-collision']);
  });

  it('refreshes cached history proof after a removal with another conversation open', async () => {
    const { store } = mk();
    const other = '2f0c8a3e-1b2c-4d5e-8f90-1234567890ac';
    const inspector = store as unknown as { scanRemovalIndex(key: string, path: string): Generator<void, boolean> };
    const scan = vi.spyOn(inspector, 'scanRemovalIndex');
    try {
      store.append(created());
      store.append(msg('a', 1));
      store.append({ ...created('Other'), conversationKey: other });
      store.append({ ...msg('b', 2), conversationKey: other });
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      expect(store.browseRemovalAwareMessages(KEY, null)?.messages.map((row) => row.eventId)).toEqual(['ev-a']);
      expect(await store.prepareRemovalHistory(other)).toBe(true);
      expect(store.browseRemovalAwareMessages(other, null)?.messages.map((row) => row.eventId)).toEqual(['ev-b']);
      expect(store.browseRemovalAwareMessages(KEY, null)?.messages.map((row) => row.eventId)).toEqual(['ev-a']);
      expect(scan).toHaveBeenCalledTimes(2);
      store.append({ kind: 'message-removed', conversationKey: KEY, eventId: 'remove-a',
        machineId: 'm1', at: at(3), targetEventId: 'ev-a', targetMessageId: 'msg-a' });
      expect(store.browseRemovalAwareMessages(KEY, null)).toBeNull();
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      expect(store.browseRemovalAwareMessages(KEY, null)?.messages).toEqual([]);
      expect(scan).toHaveBeenCalledTimes(3);
      expect(await store.prepareRemovalHistory(other)).toBe(true);
      expect(store.browseRemovalAwareMessages(other, null)?.messages.map((row) => row.eventId)).toEqual(['ev-b']);
    } finally { store.close(); }
  });

  it('discards a suspended history proof when the journal changes between batches', async () => {
    const { store } = mk();
    try {
      store.append(created());
      store.append(msg('target', 1));
      const prepare = store.prepareRemovalHistory(KEY);
      expect(store.prepareRemovalHistory(KEY)).toBe(prepare);
      await new Promise<void>((resolve) => setImmediate(resolve));
      store.append({ kind: 'message-removed', conversationKey: KEY, eventId: 'during-proof',
        machineId: 'm1', at: at(2), targetEventId: 'ev-target', targetMessageId: 'msg-target' });
      expect(await prepare).toBe(false);
      expect(store.browseRemovalAwareMessages(KEY, null)).toBeNull();
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      expect(store.browseRemovalAwareMessages(KEY, null)?.messages).toEqual([]);
    } finally { store.close(); }
  });

  it('keeps a suspended proof across other-chat plain messages and invalidates it on its own append', async () => {
    const { store } = mk();
    const other = '2f0c8a3e-1b2c-4d5e-8f90-1234567890ac';
    try {
      store.append(created());
      store.append(msg('target', 1));
      store.append({ ...created('Other'), conversationKey: other });
      const inspector = store as unknown as { scanRemovalIndex(key: string, path: string, journal?: fs.Stats): Generator<void, boolean> };
      const original = inspector.scanRemovalIndex.bind(store);
      let firstBatch!: () => void;
      const afterFirstBatch = new Promise<void>((resolve) => { firstBatch = resolve; });
      vi.spyOn(inspector, 'scanRemovalIndex').mockImplementationOnce(function* (...args) {
        const scanner = original(...args);
        try {
          const first = scanner.next();
          firstBatch();
          if (first.done) return first.value;
          yield;
          return yield* scanner;
        } finally { scanner.return(false); }
      });
      const crossing = store.prepareRemovalHistory(KEY);
      await afterFirstBatch;
      store.append({ ...msg('elsewhere', 2), conversationKey: other });
      store.append({ ...msg('target', 2, 'conflicting copy'), conversationKey: other });
      expect(await crossing).toBe(true);
      expect(store.browseRemovalAwareMessages(KEY, null)?.messages.map((row) => row.eventId)).toEqual(['ev-target']);
      expect(store.exactRemovalAwareMessageCandidates(KEY, 'msg-target', 'message', () => true)?.[0]?.text)
        .toBe('hello target');
      store.append(msg('new-local', 3));
      expect(store.browseRemovalAwareMessages(KEY, null)).toBeNull();
      expect(await store.prepareRemovalHistory(KEY)).toBe(true);
      expect(store.browseRemovalAwareMessages(KEY, null)?.messages.map((row) => row.eventId))
        .toEqual(['ev-target', 'ev-new-local']);
    } finally { store.close(); }
  });

  it('discards a suspended history proof after an external index-only write', async () => {
    const { dir, store } = mk();
    try {
      store.append(created());
      store.append(msg('target', 1));
      const prepare = store.prepareRemovalHistory(KEY);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const db = new Database(path.join(dir, 'app-conversations', 'index.sqlite'));
      try { db.exec("UPDATE messages SET at = '2026-01-01T00:00:00.000Z' WHERE messageId = 'msg-target'"); }
      finally { db.close(); }
      expect(await prepare).toBe(false);
      expect(store.browseRemovalAwareMessages(KEY, null)).toBeNull();
      expect(store.exactRemovalAwareMessageCandidates(KEY, 'ev-target', 'event', () => true)).toBeNull();
      expect(await store.prepareRemovalHistory(KEY)).toBe(false);
    } finally { store.close(); }
  });

  it('refuses a removal-aware page off the custodian or with an unindexed journal tail', async () => {
    const { dir, store } = mk();
    store.append(created());
    store.append(msg('a', 1));
    const peer = new AppConversationStore({ stateDir: dir, machineId: () => 'm2' });
    try {
      expect(await peer.prepareRemovalHistory(KEY)).toBe(false);
      expect(peer.browseRemovalAwareMessages(KEY, null)).toBeNull();
      expect(peer.exactRemovalAwareMessageCandidates(KEY, 'ev-a', 'event', () => true)).toBeNull();
    } finally { peer.close(); }
    expect(await store.prepareRemovalHistory(KEY)).toBe(true);
    fs.appendFileSync(fileOf(dir), JSON.stringify({ ...msg('b', 2), ingestSeq: 3 }) + '\n');
    expect(await store.prepareRemovalHistory(KEY)).toBe(false);
    expect(store.browseRemovalAwareMessages(KEY, null)).toBeNull();
  });


  it('refuses removal-aware pagination and exact lookup on a damaged message binding after reopen', async () => {
    const { dir, store } = mk();
    store.append(created());
    store.append(msg('a', 1));
    store.append(msg('b', 2));
    store.close();
    const db = new Database(path.join(dir, 'app-conversations', 'index.sqlite'));
    try { db.exec("UPDATE messages SET eventId = 'ev-b' WHERE messageId = 'msg-a'"); }
    finally { db.close(); }
    const reopened = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
    try {
      expect(await reopened.prepareRemovalHistory(KEY)).toBe(false);
      expect(reopened.browseRemovalAwareMessages(KEY, null)).toBeNull();
      expect(reopened.exactRemovalAwareMessageCandidates(KEY, 'ev-a', 'event', () => true)).toBeNull();
    } finally { reopened.close(); }
  });

  it('indexes exact removal facts across arrival order and rebuild without changing the raw target', () => {
    const { store } = mk();
    const deletion = { kind: 'message-removed' as const, conversationKey: KEY, eventId: 'removed-a',
      targetEventId: 'ev-a', targetMessageId: 'msg-a', at: at(5), machineId: 'm1' };
    expect(buildAppConversationRecordData(deletion)({ physical: 1, logical: 0, node: 'm1' }, 'm1')).toBeNull();
    expect(appEventFromReplicatedData({ ...deletion, eventKind: deletion.kind, origin: 'm1' })).toBeNull();
    store.append(deletion);
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-a')).toBeNull();
    store.append(created());
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-a')).toBeNull();
    store.append(msg('a', 1));
    store.append(msg('b', 2));
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-a')).toEqual({ eventId: 'removed-a' });
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-b')).toEqual({ eventId: null });
    expect(store.messageRemoval(KEY, 'ev-b', 'msg-b')).toEqual({ eventId: null });
    expect(store.append(deletion).appended).toBe(false);
    store.append({ ...deletion, eventId: 'removed-second' });
    store.rebuildIndex();
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-a')).toEqual({ eventId: 'removed-a' });
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-a', 'removed-a')).toEqual({ eventId: 'removed-a' });
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-a', 'removed-second')).toEqual({ eventId: 'removed-second' });
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-a', 'unrecorded')).toEqual({ eventId: null });
    expect(store.messageRemoval(KEY, 'ev-b', 'msg-b', 'removed-a')).toBeNull();
    expect(store.messageRemoval(KEY, 'ev-b', 'msg-b', 'ev-a')).toBeNull();
    expect(store.getEvent(KEY, 'ev-a')).toMatchObject({ kind: 'message', text: 'hello a' });
    expect(store.getEvent(KEY, 'removed-a')).toMatchObject(deletion);
  });

  it('keeps a wrong custodian or target binding from taking effect or blocking a valid fact', () => {
    const { store } = mk();
    store.append(created());
    store.append(msg('a', 1));
    const deletion = { kind: 'message-removed' as const, conversationKey: KEY, eventId: 'wrong-machine',
      targetEventId: 'ev-a', targetMessageId: 'msg-a', at: at(5), machineId: 'm2' };
    store.append(deletion);
    store.append({ ...deletion, eventId: 'wrong-target', targetMessageId: 'other', machineId: 'm1' });
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-a')).toEqual({ eventId: null });
    expect(store.messageRemoval(KEY, 'ev-a', 'other')).toEqual({ eventId: null });
    store.append({ ...deletion, eventId: 'right', machineId: 'm1' });
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-a')).toEqual({ eventId: 'right' });
  });

  it('reports incomplete removal evidence until a durable unindexed fact is replayed', () => {
    const { dir, store } = mk();
    store.append(created());
    store.append(msg('a', 1));
    const fact = { kind: 'message-removed', conversationKey: KEY, eventId: 'removed-a',
      targetEventId: 'ev-a', targetMessageId: 'msg-a', at: at(5), machineId: 'm1' } as const;
    expect(() => store.append({ ...fact, targetEventId: fact.eventId })).toThrow('invalid App message removal');
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-a')).toEqual({ eventId: null });
    fs.appendFileSync(fileOf(dir), JSON.stringify({ ...fact, ingestSeq: 3 }) + '\n');
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-a')).toBeNull();
    store.close();
    const reopened = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
    try {
      expect(reopened.messageRemoval(KEY, 'ev-a', 'msg-a')).toEqual({ eventId: 'removed-a' });
    } finally { reopened.close(); }
  });

  it.each([
    'ALTER TABLE message_removals RENAME TO incomplete_removal_fixture',
    "UPDATE message_removals SET targetMessageId = 'mismatched-index-fixture'",
    "UPDATE events SET kind = 'label' WHERE eventId = 'removed-a'; ALTER TABLE message_removals RENAME TO incomplete_removal_fixture",
  ])('reports unknown when removal index evidence is inconsistent (%s)', (mutateIndex) => {
    const { dir, store } = mk();
    store.append(created());
    store.append(msg('a', 1));
    store.append({ kind: 'message-removed', conversationKey: KEY, eventId: 'removed-a',
      targetEventId: 'ev-a', targetMessageId: 'msg-a', at: at(5), machineId: 'm1' });
    store.close();
    const db = new Database(path.join(dir, 'app-conversations', 'index.sqlite'));
    try { db.exec(mutateIndex); }
    finally { db.close(); }
    const reopened = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
    try {
      expect(reopened.messageRemoval(KEY, 'ev-a', 'msg-a')).toBeNull();
      expect(reopened.messageRemoval(KEY, 'ev-a', 'mismatched-index-fixture')).toBeNull();
    }
    finally { reopened.close(); }
  });

  it('refuses negative proof when the event index claims a removal absent from journal bytes', () => {
    const { dir, store } = mk();
    store.append(created());
    store.append(msg('a', 1));
    store.append(msg('b', 2));
    store.append({ kind: 'message-removed', conversationKey: KEY, eventId: 'mismatched',
      targetEventId: 'ev-a', targetMessageId: 'msg-b', at: at(5), machineId: 'm1' });
    expect(store.messageRemoval(KEY, 'ev-a', 'msg-b')).toEqual({ eventId: null });
    store.close();
    const db = new Database(path.join(dir, 'app-conversations', 'index.sqlite'));
    try {
      db.exec(`INSERT INTO events SELECT canonicalKey, ingestSeq, 'phantom', messageId, 'message-removed', at, machineId, byteOffset, byteLength FROM events WHERE eventId = 'ev-b'`);
    } finally { db.close(); }
    const reopened = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
    try {
      expect(reopened.messageRemoval(KEY, 'ev-a', 'msg-a')).toBeNull();
      expect(reopened.messageRemoval(KEY, 'ev-a', 'msg-b')).toBeNull();
      expect(reopened.messageRemoval(KEY, 'ev-a', 'msg-a', 'phantom')).toBeNull();
    } finally { reopened.close(); }
  });

  it('reuses one integrity scan for negative lookups within a journal checkpoint', () => {
    const { store } = mk();
    store.append(created());
    store.append(msg('a', 1));
    store.append({ kind: 'message-removed', conversationKey: KEY, eventId: 'removed-a',
      targetEventId: 'ev-a', targetMessageId: 'msg-a', at: at(5), machineId: 'm1' });
    const inspector = store as unknown as { verifyRemovalIndex(key: string, path: string): boolean; db: Database.Database };
    const scan = vi.spyOn(inspector, 'verifyRemovalIndex');
    for (const id of ['ev-b', 'ev-c', 'ev-d']) {
      expect(store.messageRemoval(KEY, id, 'other')).toEqual({ eventId: null });
    }
    expect(scan).toHaveBeenCalledTimes(1);
    store.append(msg('b', 6));
    expect(store.messageRemoval(KEY, 'ev-b', 'msg-b')).toEqual({ eventId: null });
    expect(scan).toHaveBeenCalledTimes(2);
    inspector.db.exec("UPDATE message_removals SET targetMessageId = 'corrupted-after-proof' WHERE eventId = 'removed-a'");
    expect(store.messageRemoval(KEY, 'ev-b', 'msg-b')).toBeNull();
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it('cannot turn a concurrent durable removal into a negative receipt', () => {
    const { dir, store } = mk();
    store.append(created());
    store.append(msg('a', 1));
    const writer = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
    const inspector = store as unknown as { verifyRemovalIndex(key: string, path: string): boolean };
    const scan = inspector.verifyRemovalIndex.bind(inspector);
    vi.spyOn(inspector, 'verifyRemovalIndex').mockImplementationOnce((key, filepath) => {
      writer.append({ kind: 'message-removed', conversationKey: KEY, eventId: 'removed-a',
        targetEventId: 'ev-a', targetMessageId: 'msg-a', at: at(5), machineId: 'm1' });
      return scan(key, filepath);
    });
    try {
      expect(store.messageRemoval(KEY, 'ev-a', 'msg-a', 'removed-a')).toBeNull();
      expect(store.messageRemoval(KEY, 'ev-a', 'msg-a', 'removed-a')).toEqual({ eventId: 'removed-a' });
    } finally { writer.close(); }
  });

  it('replicates forwarded history with a dedicated wire kind and hides the private binding in projections', () => {
    const { store } = mk('m2');
    store.append(created());
    const copy = { ...msg('copy', 1, 'Copied text'), forwarded: true as const, forwardBinding: 'a'.repeat(64) };
    const wire = buildAppConversationRecordData(copy)({ physical: 1, logical: 0, node: 'm1' }, 'm1')!;
    expect(wire.eventKind).toBe('forward-copy');
    expect(appEventFromReplicatedData({ ...wire, eventKind: 'message' })).toBeNull();
    expect(appEventFromReplicatedData({ ...wire, origin: 'm2' })).toBeNull();
    expect(appEventFromReplicatedData({ ...wire, forwardBinding: undefined })).toBeNull();
    expect(appEventFromReplicatedData({ ...wire, role: 'agent' })).toBeNull();
    const decoded = appEventFromReplicatedData(wire);
    expect(decoded).toMatchObject(copy);
    expect(store.ingestReplicated(decoded)?.appended).toBe(true);
    const projected = store.browseMessages(KEY, null, 10).messages[0];
    expect(projected).toMatchObject({ forwarded: true, deliveryState: 'delivered', text: 'Copied text' });
    expect(projected).not.toHaveProperty('forwardBinding');
    store.append(msg('ordinary', 0, 'Earlier text'));
    expect(store.browseAgentMessages(KEY, null, 1).messages)
      .toEqual([expect.objectContaining({ text: 'Earlier text' })]);
  });

  it('keeps exact ID domains distinct and seeks within the raw timestamp tuple', () => {
    const { store } = mk();
    store.append(created());
    store.append(msg('a', 1));
    const collision = { ...msg('b', 1), messageId: 'ev-a' } as AppEvent;
    store.append(collision);
    store.append(msg('newer', 2));
    expect(store.exactMessageCandidates(KEY, 'ev-a', 'event').map((row) => row.eventId)).toEqual(['ev-a']);
    expect(store.exactMessageCandidates(KEY, 'ev-a', 'message').map((row) => row.eventId)).toEqual(['ev-b']);
    expect(store.exactMessageCandidates(KEY, 'ev-a', 'legacy').map((row) => row.eventId)).toEqual(['ev-a', 'ev-b']);
    expect(store.exactMessageCandidates(KEY, 'cr-1', 'event')).toEqual([]);
    const boundary = { at: at(1), eventId: 'ev-b' };
    expect(store.exactMessageChunk(KEY, boundary, true, 4).map((row) => row.eventId)).toEqual(['ev-b', 'ev-a']);
    expect(store.exactMessageChunk(KEY, boundary, false, 4).map((row) => row.eventId)).toEqual(['ev-a']);
  });

  it('preserves quoted event, proof and timestamp through disk and replication codecs', () => {
    const { store, dir } = mk();
    store.append(created());
    const key = `app:${KEY}`;
    const receivedAt = at(2);
    const replyTo = { conversationKey: key, eventId: 'ev-original', messageId: 'msg-original' };
    const binding = { conversationKey: key, eventId: 'ev-reply', messageId: 'msg-reply', replyTo };
    const origin = { deviceId: 'device-1', host: 'fixture.example', method: 'POST', pathWithQuery: `/mobile/chat/app/${KEY}/reply`,
      timeMs: String(Date.parse(receivedAt)), bodySha256: '0'.repeat(64) };
    const signing = generateSigningKeyPair();
    const signerKeyHash = signerKeyHashOf(signing.publicKey);
    const signer: MachineSigner = {
      machineId: () => 'm1', signerKeyHash: () => signerKeyHash,
      sign: (text) => ({ machineId: 'm1', signerKeyHash, sig: edSign(text, signing.privateKey) }),
    };
    const receipt = signReplyReceipt(signer, origin, receivedAt, binding);
    const event = { ...msg('reply', 2), receivedAt, replyTo, receipt } as AppEvent;
    expect(store.append(event).appended).toBe(true);
    store.close();
    const reopened = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
    try {
      const actual = reopened.exactMessageCandidates(KEY, 'ev-reply', 'event')[0]!;
      expect(actual).toMatchObject({ receivedAt, replyTo, receipt });
      const held = reopened.getEvent(KEY, 'ev-reply')!;
      const record = buildAppConversationRecordData(held)({ physical: 1, logical: 0, node: 'm1' }, 'm1')!;
      const verifiedWire = appConversationRecordStoreSchema.validate(record, { mode: 'local' } as never)!;
      const decoded = appEventFromReplicatedData(verifiedWire);
      if (decoded?.kind !== 'message' || decoded.receipt?.v !== 3 || !decoded.receivedAt || !decoded.replyTo) {
        throw new Error('quoted record failed to round-trip');
      }
      const lookup = () => ({ status: 'ok' as const, publicKeyPem: signing.publicKey });
      const decodedBinding = { conversationKey: `app:${decoded.conversationKey}`, eventId: decoded.eventId,
        messageId: decoded.messageId, replyTo: decoded.replyTo };
      expect(verifyReplyReceipt(lookup, decoded.receipt, origin, decoded.receivedAt, decodedBinding)).toBe('ok');
      expect(verifyReplyReceipt(lookup, decoded.receipt, origin, decoded.receivedAt,
        { ...decodedBinding, conversationKey: 'app:other-conversation' })).toBe('bad');
      const unknown = validateAppEvent({ ...event, receipt: { ...receipt, v: 4 } });
      expect(unknown).toMatchObject({ replyTo });
      expect(unknown).not.toHaveProperty('receipt');
    } finally { reopened.close(); }
  });

  it('rebuilds reaction slots and refuses replica conflicts and missing revisions', () => {
    const { store, dir } = mk();
    store.append(created());
    store.append(msg('base', 1));
    const fact = (revision: number, eventId: string, emoji: '👍' | null) => ({
      kind: 'reaction' as const, eventId, conversationKey: KEY, at: at(2), machineId: 'm1',
      reactionTarget: 'ev-base', reactionActor: 'owner', reactionEmoji: emoji, reactionRevision: revision,
    });
    expect(store.ownReaction(KEY, 'ev-base', 'owner')).toEqual({ emoji: null, revision: 0 });
    store.append(fact(2, 'clear', null));
    expect(store.ownReaction(KEY, 'ev-base', 'owner')).toBeNull();
    store.append(fact(1, 'add', '👍'));
    expect(store.ownReaction(KEY, 'ev-base', 'owner')).toEqual({ emoji: null, revision: 2 });
    store.rebuildIndex();
    expect(store.ownReaction(KEY, 'ev-base', 'owner')).toEqual({ emoji: null, revision: 2 });
    const spoofed = buildAppConversationRecordData(fact(3, 'spoofed', '👍'))({ physical: 1, logical: 0, node: 'm2' }, 'm2')!;
    expect(appEventFromReplicatedData(spoofed)).toBeNull();
    store.ingestReplicated({ ...fact(3, 'non-holder', '👍'), machineId: 'm2' });
    expect(store.ownReaction(KEY, 'ev-base', 'owner')).toEqual({ emoji: null, revision: 2 });
    fs.appendFileSync(fileOf(dir), JSON.stringify({ ...fact(3, 'late-durable', '👍'), ingestSeq: 6 }) + '\n');
    expect(store.ownReaction(KEY, 'ev-base', 'owner')).toBeNull();
    const internals = store as unknown as { indexEvent: (...args: unknown[]) => void };
    const indexEvent = internals.indexEvent.bind(store);
    const interrupted = vi.spyOn(internals, 'indexEvent').mockImplementationOnce((...args) => {
      indexEvent(...args);
      throw new Error('interrupted before checkpoint');
    });
    try { expect(() => store.catchUp()).toThrow('interrupted before checkpoint'); }
    finally { interrupted.mockRestore(); }
    expect(store.getEvent(KEY, 'late-durable')).toBeNull();
    expect(store.ownReaction(KEY, 'ev-base', 'owner')).toBeNull();
    store.catchUp();
    expect(store.ownReaction(KEY, 'ev-base', 'owner')).toEqual({ emoji: '👍', revision: 3 });
    store.append(fact(2, 'conflict', '👍'));
    expect(store.ownReaction(KEY, 'ev-base', 'owner')).toBeNull();
  });

  it('captures a bounded content-free registration frontier including tombstones', () => {
    const { store } = mk();
    expect(store.inventoryFrontier()).toEqual({ keys: [], overflow: false, eventWatermark: 0, liveCount: 0 });
    store.append(created('Private title'));
    store.append({ ...created('Other private title', 1, 'm1', 'cr-2'), conversationKey: 'other-key' });
    store.append({ eventId: 'tb-frontier', kind: 'tombstone', conversationKey: KEY, at: at(2), machineId: 'm1' });
    const frontier = store.inventoryFrontier();
    expect(frontier.keys).toHaveLength(2);
    expect(frontier.keys).toContainEqual({ conversationKey: KEY, tombstoned: true });
    expect(frontier.liveCount).toBe(1);
    expect(frontier.eventWatermark).toBe(3);
    expect(frontier.overflow).toBe(false);
    expect(store.inventoryFrontier(1).overflow).toBe(true);
    expect(store.inventoryFrontier(1).keys).toHaveLength(1);
    expect(JSON.stringify(frontier)).not.toContain('Private title');
  });

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

describe('a stamp from another machine', () => {
  const message = (accessStamp: unknown) => ({ eventId: 'e', kind: 'message', conversationKey: '00000000-0000-4000-8000-000000000001', at: '2026-11-07T10:00:00.000Z', machineId: 'm', messageId: 'x', role: 'agent', text: 't', accessStamp });
  it('that cannot be read is held from everyone, not taken as none', () => {
    for (const bad of ['x', null, { origin: 'a' }, { origin: 'a', incarnation: 'i', seq: 0, access: {} }, { origin: 'a', incarnation: 'i', seq: 1, access: { s: 'no' } }]) {
      expect((validateAppEvent(message(bad)) as { accessStamp?: { seq: number } }).accessStamp?.seq).toBe(Number.MAX_SAFE_INTEGER);
    }
  });
  it('that is sound is kept, and none stays none', () => {
    const good = { origin: 'a', incarnation: 'i', seq: 3, access: { s: 1 } };
    expect((validateAppEvent(message(good)) as { accessStamp?: unknown }).accessStamp).toEqual(good);
    expect((validateAppEvent(message(undefined)) as { accessStamp?: unknown }).accessStamp).toBeUndefined();
  });
});
