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

  it('keeps a recorded directive across reconnect and settles it under pause', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-stop-store-'));
    const file = path.join(directory, 'claims.sqlite');
    const db = new Database(file);
    let receipt;
    try {
      const store = new ManagedCodexStopStore(db);
      store.reserve('work', { ...identity, remaining: 2 });
      store.activate(identity.sessionId);
      receipt = store.decide(first).directive;
      expect(receipt).toEqual({ cycle: 'first', marker: 'first-marker' });
    } finally {
      db.close();
    }
    const reopened = new Database(file);
    try {
      const store = new ManagedCodexStopStore(reopened);
      expect(store.decide(first).directive).toBeUndefined();
      expect(store.decide({ ...first, cycle: 'second' }).directive).toBeUndefined();
      expect(store.pause(identity.sessionId)).toBe(true);
      expect(store.decide({ ...first, cycle: 'second', receipt }).directive).toBeUndefined();
      const row = reopened.prepare('SELECT claim_json FROM managed_codex_work_claims').get() as { claim_json: string };
      expect(JSON.parse(row.claim_json).enrollment).toMatchObject({ remaining: 1, issuedCycles: ['first'] });
      expect(JSON.parse(row.claim_json).enrollment.outstanding).toBeUndefined();
    } finally {
      reopened.close();
      SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'managed-stop-store-fixture' });
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
