import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MobilePushPending, evaluatePushAdmission, legacyPushFingerprint, type LegacyPushSlot } from '../../src/core/MobilePushPending.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mobile-push-pending.test.ts' }); });
function location() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-pending-')); dirs.push(dir); return path.join(dir, 'pending.json'); }
const reply = (messageId: string) => ({ kind: 'reply' as const, conversationKey: 'chat', messageId, sourceMachine: 'm', dedupeKey: messageId });

describe('reader-bound pending push evidence', () => {
  it('holds a reassigned phone even if both people can read the witness, and fails closed without preferences', () => {
    const facts = { intendedReader: 'alice', currentReader: 'bob', active: true, kind: 'reply' as const, witnessReadable: true, muted: false };
    expect(evaluatePushAdmission(facts)).toEqual({ disposition: 'hold', reason: 'reader-changed' });
    expect(evaluatePushAdmission({ ...facts, currentReader: 'alice', muted: null }).disposition).toBe('hold');
    expect(evaluatePushAdmission({ ...facts, currentReader: 'alice', muted: true }).disposition).toBe('discard');
    expect(evaluatePushAdmission({ ...facts, currentReader: 'alice', kind: 'notice', muted: true }).disposition).toBe('send');
    expect(evaluatePushAdmission({ ...facts, currentReader: 'alice', witnessReadable: false }).reason).toBe('witness-unreadable');
  });

  for (const stage of ['episode-durable', 'copy-durable', 'old-clear-durable', 'complete-durable']) {
    it(`recovers after a crash at ${stage}, imports once, and starts a fresh episode for identical later legacy bytes`, () => {
      const file = location(); let legacy: Record<string, LegacyPushSlot> = { d: { pending: { count: 2, hasUrgent: true }, dueAt: 4 } };
      const read = () => legacy;
      const clear = () => { legacy = {}; return true; };
      const first = new MobilePushPending(file, current => { if (current === stage) throw new Error('simulated crash'); });
      expect(() => first.migrate(read, clear)).toThrow('simulated crash');
      const resumed = new MobilePushPending(file);
      expect(resumed.migrate(read, clear)).toBe(true);
      expect(resumed.legacyCount()).toBe(2);
      expect(resumed.migrate(read, clear)).toBe(true);
      expect(resumed.legacyCount()).toBe(2);
      legacy = { d: { pending: { count: 2, hasUrgent: true }, dueAt: 4 } };
      expect(resumed.migrate(read, clear)).toBe(true);
      expect(resumed.legacyCount()).toBe(4);
      legacy = { d: { pending: { count: 2, hasUrgent: true }, dueAt: 4 } };
      expect(resumed.migrate(read, clear)).toBe(true); expect(resumed.legacyCount()).toBe(6);
      const durable = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(Object.keys(durable.legacy)).toEqual(['d']); expect(durable.migration.captures).toHaveLength(1);
      expect(durable.legacy.d.count).toBe(6);
    });
  }

  it('preserves changed legacy slots and refuses readiness instead of clearing an uncaptured value', () => {
    const file = location(); let slots = { d: { pending: { count: 1, hasUrgent: false }, dueAt: 3 } };
    const store = new MobilePushPending(file, stage => { if (stage === 'copy-durable') slots = { d: { pending: { count: 2, hasUrgent: true }, dueAt: 3 } }; });
    let cleared = false;
    expect(store.migrate(() => slots, () => { cleared = true; return true; })).toBe(false);
    expect(cleared).toBe(false); expect(store.ready()).toBe(false); expect(store.legacyCount()).toBe(1);
  });

  it('holds an identical legacy slot rewritten under a different durable version', () => {
    const file = location(); let slots: Record<string, LegacyPushSlot> = { d: { pending: { count: 2, hasUrgent: false }, dueAt: 1, version: 'old-file-version' } };
    const store = new MobilePushPending(file, stage => { if (stage === 'copy-durable') slots.d = { ...slots.d!, version: 'new-file-version' }; });
    let cleared = false; expect(store.migrate(() => slots, () => { cleared = true; return true; })).toBe(false);
    expect(cleared).toBe(false); expect(store.legacyCount()).toBe(2); expect(slots.d!.pending.count).toBe(2);
  });

  for (const stage of ['batch-recipient-prepared', 'batch-before-persist', 'batch-durable']) {
    it(`atomically retains all recipients and their receipt across a crash at ${stage}`, () => {
      const file = location(); const recipients = [{ deviceId: 'one', reader: 'alice', ref: 'app:chat' }, { deviceId: 'two', reader: 'alice', ref: 'app:chat' }];
      const store = new MobilePushPending(file, current => { if (current === stage) throw new Error('batch crash'); });
      expect(store.migrate(() => ({}), () => true)).toBe(true);
      expect(() => store.enqueueBatch(recipients, reply('batch'), 1)).toThrow('batch crash');
      const resumed = new MobilePushPending(file);
      expect(resumed.enqueueBatch(recipients, reply('batch'), 1)).toBe(stage === 'batch-durable' ? 'deduped' : 'accepted');
      expect(resumed.forDevice('one')).toHaveLength(1); expect(resumed.forDevice('two')).toHaveLength(1);
      expect(resumed.enqueueBatch(recipients, reply('batch'), 2)).toBe('deduped');
      expect(resumed.forDevice('one')[0]!.count).toBe(1); expect(resumed.forDevice('two')[0]!.count).toBe(1);
    });
  }

  it('keeps the latest witness and latest urgency; acknowledgement cannot erase a newer enqueue', () => {
    const store = new MobilePushPending(location()); expect(store.migrate(() => ({}), () => true)).toBe(true);
    const old = store.enqueue('d', 'alice', 'app:chat', { ...reply('public'), priority: 'URGENT' })!;
    const current = store.enqueue('d', 'alice', 'app:chat', reply('private'))!;
    store.acknowledge([old]);
    expect(store.forDevice('d')).toMatchObject([{ version: current.version, count: 1, trigger: { messageId: 'private' } }]);
    expect(store.forDevice('d')[0]!.trigger.priority).toBeUndefined();
    store.enqueue('d', 'bob', 'app:chat', reply('bob'));
    expect(store.forDevice('d')).toHaveLength(2);
    store.acknowledge([current]); expect(store.forDevice('d')[0]!.intendedReader).toBe('bob');
  });

  it('quarantines actual old-code codec fields and leaves no slot for the old drain', () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/conversation-mute-archive/previous-push-codec.json', import.meta.url), 'utf8'));
    let slots: Record<string, LegacyPushSlot> = { d: { pending: fixture.oldSavedPending, dueAt: 99 } };
    const fingerprint = legacyPushFingerprint(slots.d!);
    const store = new MobilePushPending(location());
    expect(store.migrate(() => slots, captures => { expect(captures[0]!.fingerprint).toBe(fingerprint); slots = {}; return true; })).toBe(true);
    expect(store.legacyCount()).toBe(2); expect(store.forDevice('d')).toEqual([]); expect(slots).toEqual({});
  });
});
