/**
 * Tier-1 tests for LocalSessionOwnershipStore (spec §7.2 transfer fix): the DURABLE
 * per-session ownership substrate. Proves the property the in-memory store lacked —
 * an ownership record written here SURVIVES a process restart (a fresh store instance
 * over the same dir reads it back) — plus the fast-forward CAS contract the registry
 * FSM depends on, and corrupt-file self-healing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LocalSessionOwnershipStore } from '../../src/core/LocalSessionOwnershipStore.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';

function rec(over: Partial<SessionOwnershipRecord> & { sessionKey: string; ownerMachineId: string; ownershipEpoch: number }): SessionOwnershipRecord {
  return {
    status: 'active',
    nonce: `${over.ownerMachineId}:${over.ownershipEpoch}`,
    timestamp: 1_000_000,
    updatedAt: new Date(1_000_000).toISOString(),
    ...over,
  };
}

describe('LocalSessionOwnershipStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-store-'));
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: "live-test-cleanup" }); } catch { /* best-effort */ }
  });

  it('persists a record and reads it back', () => {
    const store = new LocalSessionOwnershipStore({ dir });
    const r = rec({ sessionKey: '13481', ownerMachineId: 'mini', ownershipEpoch: 1 });
    expect(store.casWrite(r).ok).toBe(true);
    expect(store.read('13481')?.ownerMachineId).toBe('mini');
  });

  it('SURVIVES RESTART — a fresh store instance over the same dir reads the record', () => {
    // The exact property InMemorySessionOwnershipStore lacked (the live bug).
    const first = new LocalSessionOwnershipStore({ dir });
    first.casWrite(rec({ sessionKey: '13481', ownerMachineId: 'mini', ownershipEpoch: 3 }));

    const afterRestart = new LocalSessionOwnershipStore({ dir }); // new process lifetime
    const read = afterRestart.read('13481');
    expect(read).not.toBeNull();
    expect(read?.ownerMachineId).toBe('mini');
    expect(read?.ownershipEpoch).toBe(3);
  });

  it('fast-forward CAS: a higher epoch wins, a stale-or-equal epoch loses', () => {
    const store = new LocalSessionOwnershipStore({ dir });
    expect(store.casWrite(rec({ sessionKey: 't', ownerMachineId: 'a', ownershipEpoch: 2 })).ok).toBe(true);

    // Stale (lower) epoch is rejected; observed reflects the committed record.
    const stale = store.casWrite(rec({ sessionKey: 't', ownerMachineId: 'b', ownershipEpoch: 1 }));
    expect(stale.ok).toBe(false);
    expect(stale.observed?.ownerMachineId).toBe('a');

    // Equal epoch is NOT a fast-forward → rejected (monotonic advance only).
    expect(store.casWrite(rec({ sessionKey: 't', ownerMachineId: 'b', ownershipEpoch: 2 })).ok).toBe(false);

    // Higher epoch advances ownership to the new machine.
    expect(store.casWrite(rec({ sessionKey: 't', ownerMachineId: 'b', ownershipEpoch: 3 })).ok).toBe(true);
    expect(store.read('t')?.ownerMachineId).toBe('b');
  });

  it('the advance is DURABLE — a higher-epoch transfer is readable after restart', () => {
    const a = new LocalSessionOwnershipStore({ dir });
    a.casWrite(rec({ sessionKey: 't', ownerMachineId: 'laptop', ownershipEpoch: 1 }));
    a.casWrite(rec({ sessionKey: 't', ownerMachineId: 'mini', ownershipEpoch: 2 })); // the "move"

    const b = new LocalSessionOwnershipStore({ dir });
    expect(b.read('t')?.ownerMachineId).toBe('mini');
    expect(b.read('t')?.ownershipEpoch).toBe(2);
  });

  it('read returns null for an unknown session', () => {
    const store = new LocalSessionOwnershipStore({ dir });
    expect(store.read('nope')).toBeNull();
  });

  it('all() returns every persisted record, including across a restart', () => {
    const a = new LocalSessionOwnershipStore({ dir });
    a.casWrite(rec({ sessionKey: '1', ownerMachineId: 'm', ownershipEpoch: 1 }));
    a.casWrite(rec({ sessionKey: '2', ownerMachineId: 'm', ownershipEpoch: 1 }));

    const b = new LocalSessionOwnershipStore({ dir });
    const keys = b.all().map((r) => r.sessionKey).sort();
    expect(keys).toEqual(['1', '2']);
  });

  it('a corrupt single-session file reads as null (self-healing), does not throw', () => {
    const store = new LocalSessionOwnershipStore({ dir });
    store.casWrite(rec({ sessionKey: 'good', ownerMachineId: 'm', ownershipEpoch: 1 }));
    // Corrupt one file directly on disk.
    fs.writeFileSync(path.join(dir, 'good.json'), '{ not valid json');
    const fresh = new LocalSessionOwnershipStore({ dir });
    expect(fresh.read('good')).toBeNull(); // null, not a throw
    // A new write over the corrupt key recovers it.
    expect(fresh.casWrite(rec({ sessionKey: 'good', ownerMachineId: 'm2', ownershipEpoch: 1 })).ok).toBe(true);
    expect(fresh.read('good')?.ownerMachineId).toBe('m2');
  });

  it('jails a path-traversal session key to the store dir', () => {
    const store = new LocalSessionOwnershipStore({ dir });
    store.casWrite(rec({ sessionKey: '../escape', ownerMachineId: 'm', ownershipEpoch: 1 }));
    // The file lands inside dir (sanitized), never the parent.
    const parentEscape = path.join(path.dirname(dir), 'escape.json');
    expect(fs.existsSync(parentEscape)).toBe(false);
    expect(store.read('../escape')?.ownerMachineId).toBe('m');
  });
});
