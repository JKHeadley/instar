import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationPreferencesStore, canonicalPreferenceRef } from '../../src/core/ConversationPreferences.js';
import { wirePreferenceStore } from '../../src/core/ConversationPreferencesWiring.js';
const ref = 'telegram:-1001234:42';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'preferences-'));
describe('personal conversation preferences', () => {
  it('requires durable identities and separates equal topic numbers in different chats', () => {
    expect(canonicalPreferenceRef('telegram:42')).toBeNull(); expect(canonicalPreferenceRef('slack:machine:-42')).toBeNull();
    const store = new ConversationPreferencesStore({ stateDir: dir() });
    store.applyReserved(store.prepareOperation('owner', ref, { muted: true }));
    expect(store.get('owner', 'telegram:-100999:42')?.muted).toBe(false);
    expect(store.get('team:other', ref)?.muted).toBe(false);
  });
  it('creates fresh explicit same-value actions but reuses exact reserved operation rows', () => {
    const stateDir = dir(); let now = 100; const store = new ConversationPreferencesStore({ stateDir, now: () => now });
    const first = store.prepareOperation('owner', ref, { muted: false, archived: true }); store.applyReserved(first);
    const second = store.prepareOperation('owner', ref, { muted: false }); expect(second[0].eventId).not.toBe(first[0].eventId); expect(second[0].atMs).toBe(101);
    store.applyReserved(second); store.applyReserved(second); expect(store.rows()).toHaveLength(2);
    store.applyReserved(first); expect(store.rows()).toHaveLength(2); expect(store.emissionStatus(first[0])).toBe('superseded');
    now = 1; const restarted = new ConversationPreferencesStore({ stateDir, now: () => now });
    expect(restarted.prepareOperation('owner', ref, { muted: true })[0].atMs).toBe(102);
    expect(restarted.get('owner', ref)).toEqual({ muted: false, archived: true });
    expect(restarted.emissionStatus(first[0])).toBe('superseded'); expect(restarted.emissionStatus(first[1])).toBe('pending');
  });
  it('refreshes indexed reads and pending counts after apply, peer ingest, acknowledgment and reload', () => {
    const stateDir = dir(); const store = new ConversationPreferencesStore({ stateDir, now: () => 100 });
    const rows = store.prepareOperation('owner', ref, { muted: true, archived: true }); store.applyReserved(rows);
    expect(store.get('owner', ref)).toEqual({ muted: true, archived: true }); expect(store.dueCount()).toBe(2);
    expect(store.confirmEmitted(rows[0].eventId)).toBe(true); expect(store.dueCount()).toBe(1);
    const remote = { ...rows[1], eventId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', atMs: 200, value: false };
    expect(store.ingestReplicated(remote)).toBe('accepted'); expect(store.get('owner', ref)).toEqual({ muted: true, archived: false }); expect(store.dueCount()).toBe(0);
    expect(store.emissionStatus(rows[1])).toBe('superseded');
    const restarted = new ConversationPreferencesStore({ stateDir, now: () => 1 });
    expect(restarted.get('owner', ref)).toEqual({ muted: true, archived: false }); expect(restarted.dueCount()).toBe(0);
    expect(restarted.prepareOperation('owner', ref, { archived: true })[0].atMs).toBe(201);
  });
  it('folds fields independently and orders same-field remote conflicts', () => {
    const store = new ConversationPreferencesStore({ stateDir: dir(), now: () => 10 });
    const [muted, archived] = store.prepareOperation('owner', ref, { muted: true, archived: true }); store.applyReserved([muted, archived]);
    store.ingestReplicated({ ...muted, eventId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', value: false });
    expect(store.get('owner', ref)).toEqual({ muted: false, archived: true });
  });
  it('rejects an invalid two-field batch atomically and keeps unavailable state explicit', () => {
    const stateDir = dir(); const store = new ConversationPreferencesStore({ stateDir }); const rows = store.prepareOperation('owner', ref, { muted: true, archived: true });
    expect(() => store.applyReserved([rows[0], { ...rows[1], atMs: Infinity }])).toThrow(); expect(store.get('owner', ref)).toEqual({ muted: false, archived: false });
    fs.writeFileSync(store.filePath, '{broken'); const bad = new ConversationPreferencesStore({ stateDir }); expect(bad.get('owner', ref)).toBeNull(); expect(bad.emissionStatus(rows[0])).toBe('unavailable'); expect(() => bad.applyReserved(rows)).toThrow(/unavailable/);
    const version = bad.readinessVersion; fs.writeFileSync(store.filePath, JSON.stringify({ v: 1, events: [] })); expect(bad.reload()).toBe(true); expect(bad.readinessVersion).toBeGreaterThan(version);
  });
  it('persists both fields before emission and retries refused emission after restart', () => {
    const stateDir = dir(); const store = new ConversationPreferencesStore({ stateDir }); const rows = store.prepareOperation('owner', ref, { muted: true, archived: true });
    store.setReplicationHook(() => { expect(new ConversationPreferencesStore({ stateDir }).get('owner', ref)).toEqual({ muted: true, archived: true }); return 'refused'; }); store.applyReserved(rows);
    expect(rows.map(r => store.emissionStatus(r))).toEqual(['pending', 'pending']);
    const restarted = new ConversationPreferencesStore({ stateDir }); restarted.setReplicationHook(() => 'emitted'); expect(restarted.flushEmits()).toEqual({ emitted: 2, held: 0 }); expect(rows.map(r => restarted.emissionStatus(r))).toEqual(['emitted', 'emitted']);
  });
  it('coalesces journal confirmations and retains pending state after a refused durable write', async () => {
    let calls = 0; let reject!: (reason: Error) => void;
    const store = wirePreferenceStore({ stateDir: dir(), ownMachineId: 'm1', peerStreams: null,
      emitter: { emit: () => { calls++; return { outcome: 'emitted', seq: 8 }; } } as never,
      awaitDurable: () => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }), report: () => {} });
    const rows = store.prepareOperation('owner', ref, { muted: true }); store.applyReserved(rows); store.flushEmits();
    expect(calls).toBe(1); expect(store.emissionStatus(rows[0])).toBe('pending');
    await Promise.resolve(); reject(new Error('journal refused')); await new Promise(resolve => setImmediate(resolve));
    expect(store.emissionStatus(rows[0])).toBe('pending'); store.flushEmits(); expect(calls).toBe(2);
  });
  it('batches real wiring durability completions in one save and retains failed or superseded rows safely', async () => {
    const callbacks = new Map<number, { resolve: () => void; reject: () => void }>(); let seq = 0;
    const store = wirePreferenceStore({ stateDir: dir(), ownMachineId: 'm1', peerStreams: null,
      emitter: { emit: () => ({ outcome: 'emitted', seq: ++seq }) } as never,
      awaitDurable: sequence => new Promise<void>((resolve, reject) => callbacks.set(sequence, { resolve, reject: () => reject(new Error('refused')) })), report: () => {} });
    const rows = store.prepareOperation('owner', ref, { muted: true, archived: true }); store.applyReserved(rows);
    await Promise.resolve(); const rename = vi.spyOn(fs, 'renameSync');
    try { callbacks.get(1)!.resolve(); await Promise.resolve(); expect(store.dueCount()).toBe(2);
      callbacks.get(2)!.resolve(); await new Promise(resolve => setImmediate(resolve));
      expect(rename).toHaveBeenCalledTimes(1); expect(store.dueCount()).toBe(0);
    } finally { rename.mockRestore(); }
    const older = store.prepareOperation('owner', ref, { muted: false, archived: false }); store.applyReserved(older);
    const newer = store.prepareOperation('owner', ref, { muted: true }); store.applyReserved(newer);
    await Promise.resolve(); callbacks.get(3)!.resolve(); callbacks.get(4)!.reject(); callbacks.get(5)!.resolve();
    await new Promise(resolve => setImmediate(resolve));
    expect(store.emissionStatus(older[0])).toBe('superseded'); expect(store.emissionStatus(older[1])).toBe('pending'); expect(store.emissionStatus(newer[0])).toBe('emitted');
  });
  it('saves synchronous backlog acknowledgments once and preserves a reentrant confirmation', () => {
    const store = new ConversationPreferencesStore({ stateDir: dir() });
    const rows = store.prepareOperation('owner', ref, { muted: true, archived: true }); store.applyReserved(rows);
    const rename = vi.spyOn(fs, 'renameSync');
    try {
      store.setReplicationHook(() => 'emitted');
      expect(store.flushEmits()).toEqual({ emitted: 2, held: 0 }); expect(rename).toHaveBeenCalledTimes(1);
    } finally { rename.mockRestore(); }
    const newer = store.prepareOperation('owner', ref, { muted: false, archived: false });
    store.setReplicationHook(null); store.applyReserved(newer);
    store.setReplicationHook(row => { if (row.eventId === newer[0].eventId) store.confirmEmitted(newer[1].eventId); return 'emitted'; });
    store.flushEmits(); expect(newer.map(row => store.emissionStatus(row))).toEqual(['emitted', 'emitted']);
    expect(new ConversationPreferencesStore({ stateDir: path.dirname(path.dirname(store.filePath)) }).dueCount()).toBe(0);
  });
  it('does not confuse an unconfirmed journal emit with durable emission', async () => {
    let outcome = 'unconfirmed';
    const store = wirePreferenceStore({ stateDir: dir(), ownMachineId: 'm1', peerStreams: null, awaitDurable: async () => {}, emitter: { emit: () => ({ outcome, seq: 7 }) } as never, report: () => {} });
    const rows = store.prepareOperation('owner', ref, { muted: true }); store.applyReserved(rows); expect(store.emissionStatus(rows[0])).toBe('pending'); outcome = 'emitted'; store.flushEmits(); expect(store.emissionStatus(rows[0])).toBe('pending'); await new Promise(resolve => setImmediate(resolve)); expect(store.emissionStatus(rows[0])).toBe('emitted');
  });
});
