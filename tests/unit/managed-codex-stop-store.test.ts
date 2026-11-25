import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ManagedCodexStopStore } from '../../src/core/ManagedCodexStopStore.js';

const identity = { sessionId: 'session', machineId: 'machine', ownerEpoch: 4 };
const first = { ...identity, enabled: true, cycle: 'first', marker: 'first-marker' };

describe('managed Codex Stop work claims', () => {
  it('reserves pending work once and owns classification through activation and rollback', () => {
    const db = new Database(':memory:');
    try {
      const store = new ManagedCodexStopStore(db);
      expect(store.reserve('work', { ...identity, remaining: 2 })).toBe(true);
      expect(store.reserve('work', { ...identity, sessionId: 'other', remaining: 2 })).toBe(false);
      expect(store.reserve('other-work', { ...identity, remaining: 2 })).toBe(false);
      expect(store.decide(first)).toEqual({ managed: true, directive: undefined });
      expect(store.activate(identity.sessionId)).toBe(true);
      expect(store.decide({ ...first, enabled: false })).toEqual({ managed: true, directive: undefined });
      expect(store.decide({ ...first, sessionId: 'ordinary' })).toEqual({ managed: false });
    } finally {
      db.close();
    }
  });

  it('upgrades a prior fence without releasing the hold and binds worker evidence once', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE ordinary_project_work_fences (work_key TEXT PRIMARY KEY, execution_id TEXT)');
      db.prepare('INSERT INTO ordinary_project_work_fences VALUES (?, ?)').run('round', 'original');
      const store = new ManagedCodexStopStore(db);
      expect(store.reserveOrdinaryWork(['round'], 'other')).toBe(false);
      const worker = { pid: 123, procStart: 1000, startedAt: '2026-11-25T00:00:00.000Z' };
      expect(store.recordOrdinaryProcess('other', worker)).toBe(false);
      expect(store.recordOrdinaryProcess('original', worker)).toBe(true);
      expect(store.recordOrdinaryProcess('original', { ...worker, pid: 456 })).toBe(false);
      expect(db.prepare('SELECT worker_json FROM ordinary_project_work_fences').get())
        .toEqual({ worker_json: JSON.stringify(worker) });
      store.settleOrdinaryWork('original');
      expect(store.reserveOrdinaryWork(['round'], 'replacement')).toBe(true);
      expect(store.recordOrdinaryProcess('original', worker)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('keeps ordinary launch fences across restart until the exact execution settles', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-project-fence-'));
    const file = path.join(directory, 'claims.sqlite');
    const db = new Database(file);
    try {
      const store = new ManagedCodexStopStore(db);
      expect(store.reserveOrdinaryWork(['round', 'one', 'two'], 'ordinary-before-restart')).toBe(true);
    } finally {
      db.close();
    }
    const reopened = new Database(file);
    try {
      const store = new ManagedCodexStopStore(reopened);
      expect(store.reserve('one', { ...identity, remaining: 2 })).toBe(false);
      expect(store.reserve('new-item', { ...identity, remaining: 2 }, 'round')).toBe(false);
      expect(store.reserveOrdinaryWork(['round', 'new-item'], 'edited-round')).toBe(false);
      expect(store.reserveOrdinaryWork(['two', 'three'], 'replacement')).toBe(false);
      expect(store.reserveOrdinaryWork(['three'], 'unrelated')).toBe(true);
      store.settleOrdinaryWork('different-execution');
      expect(store.reserve('one', { ...identity, remaining: 2 })).toBe(false);

      store.settleOrdinaryWork('ordinary-before-restart');
      expect(store.reserve('one', { ...identity, remaining: 2 }, 'round')).toBe(true);
      expect(store.reserveOrdinaryWork(['round', 'new-item'], 'edited-round')).toBe(false);
      expect(store.reserveOrdinaryWork(['one', 'two'], 'replacement')).toBe(false);
      expect(store.reserveOrdinaryWork(['two'], 'replacement')).toBe(true);
      store.settleOrdinaryWork('ordinary-before-restart');
      expect(store.reserve('two', { ...identity, sessionId: 'different', remaining: 2 })).toBe(false);
    } finally {
      reopened.close();
      SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'ordinary-project-fence-fixture' });
    }
  });

  it('keeps a recorded directive across reconnect and settles it under pause', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-stop-store-'));
    const file = path.join(directory, 'claims.sqlite');
    const db = new Database(file);
    const nativeStop = { ...first, sessionId: 'native-worker' };
    let receipt;
    try {
      const store = new ManagedCodexStopStore(db);
      store.reserve('work', { ...identity, remaining: 2 });
      expect(store.bindNative(identity.sessionId, nativeStop.sessionId)).toBe(true);
      receipt = store.decide({
        ...nativeStop, boundary: { fileKey: 'launch-rollout', turnId: 'native-turn', endOffset: 42 },
      }).directive;
      expect(receipt).toEqual({ cycle: 'first', marker: 'first-marker' });
    } finally {
      db.close();
    }
    const reopened = new Database(file);
    try {
      const store = new ManagedCodexStopStore(reopened);
      expect(store.reserve('work', { ...identity, sessionId: 'replacement', remaining: 2 })).toBe(false);
      expect(store.hasEnrollment('replacement')).toBe(false);
      expect(store.decide(nativeStop)).toEqual({ managed: true, directive: undefined });
      expect(store.decide({ ...nativeStop, cycle: 'second' }).directive).toBeUndefined();
      expect(store.pause(identity.sessionId)).toBe(true);
      expect(store.decide({ ...nativeStop, cycle: 'second', receipt }).directive).toBeUndefined();
      const row = reopened.prepare('SELECT claim_json FROM managed_codex_work_claims').get() as { claim_json: string };
      expect(JSON.parse(row.claim_json).enrollment).toMatchObject({ remaining: 1, issuedCycles: ['first'], rolloutFileKey: 'launch-rollout' });
      expect(JSON.parse(row.claim_json).enrollment.outstanding).toBeUndefined();
    } finally {
      reopened.close();
      SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'managed-stop-store-fixture' });
    }
  });

  it.each([false, true])('blocks issuance after completion with outstanding directive=%s', (outstanding) => {
    const db = new Database(':memory:');
    try {
      const store = new ManagedCodexStopStore(db);
      expect(store.reserve('work', { ...identity, remaining: 3 })).toBe(true);
      const native = { ...first, sessionId: 'native' };
      expect(store.bindNative(identity.sessionId, native.sessionId)).toBe(true);
      const receipt = outstanding ? store.decide(native).directive : undefined;
      if (outstanding) expect(receipt).toEqual({ cycle: 'first', marker: 'first-marker' });

      expect(store.complete(identity.sessionId)).toBe(true);
      expect(store.complete(identity.sessionId)).toBe(false);
      expect(store.decide({ ...native, cycle: 'second', receipt }))
        .toEqual({ managed: true, directive: undefined });
      expect(store.decide({ ...native, cycle: 'third' }))
        .toEqual({ managed: true, directive: undefined });

      const row = db.prepare('SELECT claim_json FROM managed_codex_work_claims').get() as { claim_json: string };
      expect(JSON.parse(row.claim_json)).toMatchObject({
        actionOpen: false,
        enrollment: { remaining: outstanding ? 2 : 3, issuedCycles: outstanding ? ['first'] : [] },
      });
      expect(JSON.parse(row.claim_json).enrollment.outstanding).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('rejects a duplicate callback carrying a receipt for a newer directive', () => {
    const db = new Database(':memory:');
    try {
      const store = new ManagedCodexStopStore(db);
      store.reserve('work', { ...identity, remaining: 3 });
      store.activate(identity.sessionId);
      const a = store.decide(first).directive;
      const second = { ...first, cycle: 'second', marker: 'second-marker' };
      const b = store.decide({ ...second, receipt: a }).directive;
      expect(b?.cycle).toBe('second');
      expect(store.decide({ ...first, receipt: b }).directive).toBeUndefined();
      expect(store.decide({ ...first, cycle: 'third' }).directive).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('managed Codex startup enrollment', () => {
  it('binds native identity after launch and preserves the original administrative key', () => {
    const db = new Database(':memory:');
    try {
      const store = new ManagedCodexStopStore(db);
      expect(store.reserve('work', { ...identity, remaining: 2 })).toBe(true);
      expect(store.decide(first)).toEqual({ managed: true, directive: undefined });
      expect(store.bindNative(identity.sessionId, 'native')).toBe(true);
      expect(store.bindNative(identity.sessionId, 'replacement')).toBe(false);
      expect(store.decide(first)).toEqual({ managed: true, directive: undefined });
      const native = { ...first, sessionId: 'native' };
      const firstDirective = store.decide(native).directive;
      expect(firstDirective?.cycle).toBe('first');
      expect(store.pause(identity.sessionId)).toBe(true);
      expect(store.decide({ ...native, cycle: 'second', receipt: firstDirective }).directive).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('refuses ownership collisions and preserves a failed-launch classification', () => {
    const db = new Database(':memory:');
    try {
      const store = new ManagedCodexStopStore(db);
      expect(store.reserve('first', { ...identity, remaining: 1 })).toBe(true);
      expect(store.reserve('second', { ...identity, sessionId: 'reserved', remaining: 1 })).toBe(true);
      expect(store.bindNative(identity.sessionId, 'reserved')).toBe(false);
      expect(store.abortPending(identity.sessionId)).toBe(true);
      expect(store.bindNative(identity.sessionId, 'native')).toBe(false);
      expect(store.activate(identity.sessionId)).toBe(false);
      expect(store.decide(first)).toEqual({ managed: true, directive: undefined });
    } finally {
      db.close();
    }
  });
});

it('holds the write lock from verified enrollment read through issuance', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-stop-lock-'));
  const file = path.join(directory, 'claims.sqlite');
  const ownerDb = new Database(file);
  const pauseDb = new Database(file, { timeout: 0 });
  try {
    const owner = new ManagedCodexStopStore(ownerDb);
    const pauseWriter = new ManagedCodexStopStore(pauseDb);
    owner.reserve('work', { ...identity, remaining: 2 });
    let verified = false;
    expect(owner.decideVerified(identity.sessionId, true, () => {
      verified = true;
      return first;
    })).toMatchObject({ managed: true, directive: undefined });
    expect(verified).toBe(false);
    owner.activate(identity.sessionId);

    const issued = owner.decideVerified(identity.sessionId, true, current => {
      expect(current.outstanding).toBeUndefined();
      expect(() => pauseWriter.pause(identity.sessionId)).toThrow(/database is locked/);
      return first;
    }).directive;
    expect(issued?.cycle).toBe('first');
    expect(pauseWriter.pause(identity.sessionId)).toBe(true);
    expect(owner.decideVerified(identity.sessionId, true, current => {
      expect(current.outstanding).toMatchObject(issued!);
      return { ...first, cycle: 'second', marker: 'second-marker', receipt: issued };
    }).directive).toBeUndefined();
  } finally {
    ownerDb.close();
    pauseDb.close();
    SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'managed-stop-lock-fixture' });
  }
});
