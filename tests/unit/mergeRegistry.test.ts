import { describe, it, expect } from 'vitest';
import { mergeRegistry } from '../../src/core/mergeRegistry.js';
import type { MachineRegistry, MachineRegistryEntry, LeaseRecord } from '../../src/core/types.js';

function entry(over: Partial<MachineRegistryEntry> & { lastSeen: string }): MachineRegistryEntry {
  return {
    name: 'm', status: 'active', role: 'standby',
    pairedAt: '2026-05-27T00:00:00.000Z',
    ...over,
  } as MachineRegistryEntry;
}

function lease(over: Partial<LeaseRecord> & { epoch: number }): LeaseRecord {
  return {
    holder: 'mA', acquiredAt: '2026-05-28T00:00:00.000Z',
    expiresAt: '2026-05-28T00:01:00.000Z', signature: 'sigA', nonce: 1,
    ...over,
  } as LeaseRecord;
}

describe('mergeRegistry', () => {
  it('reproduces + resolves the 2026-05-27 divergence: concurrent lease-bump + join', () => {
    // OURS (workstation): only machine A, but a HIGHER lease epoch (it bumped).
    const ours: MachineRegistry = {
      version: 1,
      machines: { mA: entry({ name: 'workstation', role: 'awake', lastSeen: '2026-05-28T04:02:00.000Z' }) },
      lease: lease({ holder: 'mA', epoch: 11 }),
    };
    // THEIRS (mini): BOTH machines (it joined), but a STALE lease epoch.
    const theirs: MachineRegistry = {
      version: 1,
      machines: {
        mA: entry({ name: 'workstation', role: 'awake', lastSeen: '2026-05-28T03:53:00.000Z' }),
        mB: entry({ name: 'mini', role: 'awake', lastSeen: '2026-05-28T04:01:00.000Z' }),
      },
      lease: lease({ holder: 'mA', epoch: 5 }),
    };

    const merged = mergeRegistry(ours, theirs);

    // Both machines survive (no loss — the whole point).
    expect(Object.keys(merged.machines).sort()).toEqual(['mA', 'mB']);
    // mA keeps the FRESHER view (ours, lastSeen 04:02 > 03:53).
    expect(merged.machines.mA.lastSeen).toBe('2026-05-28T04:02:00.000Z');
    // mB (only on theirs) is preserved.
    expect(merged.machines.mB.name).toBe('mini');
    // The higher lease epoch wins (11 > 5).
    expect(merged.lease?.epoch).toBe(11);
  });

  it('is order-independent (machines union + lease winner identical either way)', () => {
    const a: MachineRegistry = {
      version: 2,
      machines: { mA: entry({ lastSeen: '2026-05-28T01:00:00.000Z' }) },
      lease: lease({ epoch: 7 }),
    };
    const b: MachineRegistry = {
      version: 1,
      machines: { mB: entry({ lastSeen: '2026-05-28T02:00:00.000Z' }) },
      lease: lease({ epoch: 9, signature: 'sigB' }),
    };
    const ab = mergeRegistry(a, b);
    const ba = mergeRegistry(b, a);
    expect(Object.keys(ab.machines).sort()).toEqual(Object.keys(ba.machines).sort());
    expect(ab.lease?.epoch).toBe(ba.lease?.epoch);
    expect(ab.lease?.epoch).toBe(9);
    expect(ab.version).toBe(2); // max
  });

  it('same-epoch tie broken deterministically by signature lexical order', () => {
    const a: MachineRegistry = { version: 1, machines: {}, lease: lease({ epoch: 4, signature: 'aaa' }) };
    const b: MachineRegistry = { version: 1, machines: {}, lease: lease({ epoch: 4, signature: 'zzz' }) };
    expect(mergeRegistry(a, b).lease?.signature).toBe('zzz');
    expect(mergeRegistry(b, a).lease?.signature).toBe('zzz'); // identical regardless of order
  });

  it('revocation is sticky — a stale active entry cannot resurrect a revoked machine', () => {
    const revoked: MachineRegistry = {
      version: 1,
      machines: { mX: entry({ status: 'revoked', revokedAt: '2026-05-28T01:00:00.000Z', lastSeen: '2026-05-28T01:00:00.000Z' }) },
    };
    const staleActive: MachineRegistry = {
      version: 1,
      machines: { mX: entry({ status: 'active', lastSeen: '2026-05-28T05:00:00.000Z' }) }, // newer lastSeen!
    };
    // Even though staleActive has a LATER lastSeen, the revocation wins.
    expect(mergeRegistry(staleActive, revoked).machines.mX.status).toBe('revoked');
    expect(mergeRegistry(revoked, staleActive).machines.mX.status).toBe('revoked');
  });

  it('handles a missing lease on one or both sides', () => {
    const withLease: MachineRegistry = { version: 1, machines: {}, lease: lease({ epoch: 3 }) };
    const noLease: MachineRegistry = { version: 1, machines: {} };
    expect(mergeRegistry(withLease, noLease).lease?.epoch).toBe(3);
    expect(mergeRegistry(noLease, withLease).lease?.epoch).toBe(3);
    expect(mergeRegistry(noLease, noLease).lease).toBeUndefined();
  });

  it('same-id, no lastSeen difference → higher syncSequence wins', () => {
    const a: MachineRegistry = { version: 1, machines: { mA: entry({ lastSeen: '2026-05-28T01:00:00.000Z', syncSequence: 5 }) } };
    const b: MachineRegistry = { version: 1, machines: { mA: entry({ lastSeen: '2026-05-28T01:00:00.000Z', syncSequence: 9 }) } };
    expect(mergeRegistry(a, b).machines.mA.syncSequence).toBe(9);
  });
});
