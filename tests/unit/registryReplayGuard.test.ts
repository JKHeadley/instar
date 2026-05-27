/**
 * Tier-1 + security-negative tests for the registry replay/freshness guard (spec §8 G2).
 * Both sides of every boundary: stale sequence, epoch floor, unknown-key constraint.
 */

import { describe, it, expect } from 'vitest';
import { evaluateRegistryEntry, reconcileRegistryEntries } from '../../src/core/registryReplayGuard.js';
import type { MachineRegistryEntry } from '../../src/core/types.js';

function entry(over?: Partial<MachineRegistryEntry>): MachineRegistryEntry {
  return {
    name: 'm',
    status: 'active' as any,
    role: 'standby',
    pairedAt: '2026-01-01T00:00:00Z',
    lastSeen: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('evaluateRegistryEntry — replay/freshness', () => {
  it('accepts a fresh entry (higher sequence, current epoch)', () => {
    const d = evaluateRegistryEntry({
      machineId: 'A',
      incoming: entry({ syncSequence: 5, authoredUnderEpoch: 3 }),
      local: entry({ syncSequence: 4, authoredUnderEpoch: 3 }),
      currentCommittedEpoch: 3,
    });
    expect(d.accept).toBe(true);
  });

  it('rejects a stale (replayed) sequence', () => {
    const d = evaluateRegistryEntry({
      machineId: 'A',
      incoming: entry({ syncSequence: 4, authoredUnderEpoch: 3 }),
      local: entry({ syncSequence: 4, authoredUnderEpoch: 3 }),
      currentCommittedEpoch: 3,
    });
    expect(d.accept).toBe(false);
    expect(d.reason).toContain('stale-sync-sequence');
  });

  it('rejects an entry authored under a stale epoch (wiped/re-keyed sequence reset)', () => {
    // A machine wiped local state: sequence resets to a high number again, but
    // its authoredUnderEpoch is stale → caught by the epoch floor.
    const d = evaluateRegistryEntry({
      machineId: 'A',
      incoming: entry({ syncSequence: 99, authoredUnderEpoch: 2 }),
      local: entry({ syncSequence: 4, authoredUnderEpoch: 5 }),
      currentCommittedEpoch: 5,
    });
    expect(d.accept).toBe(false);
    expect(d.reason).toContain('below-epoch-floor');
  });
});

describe('evaluateRegistryEntry — unknown-key first commit', () => {
  it('accepts an unknown key only as standby + rejoined', () => {
    const d = evaluateRegistryEntry({
      machineId: 'NEW',
      incoming: entry({ role: 'standby', rejoined: true }),
      local: undefined,
      currentCommittedEpoch: 5,
    });
    expect(d.accept).toBe(true);
  });

  it('REJECTS an unknown key asserting an awake role (security-negative)', () => {
    const d = evaluateRegistryEntry({
      machineId: 'EVIL',
      incoming: entry({ role: 'awake', rejoined: true }),
      local: undefined,
      currentCommittedEpoch: 5,
    });
    expect(d.accept).toBe(false);
    expect(d.reason).toContain('unknown-key-first-commit');
  });

  it('REJECTS an unknown key that is standby but not flagged rejoined', () => {
    const d = evaluateRegistryEntry({
      machineId: 'EVIL',
      incoming: entry({ role: 'standby', rejoined: false }),
      local: undefined,
      currentCommittedEpoch: 5,
    });
    expect(d.accept).toBe(false);
  });

  it('accepts an unknown key with a valid pairing-join record', () => {
    const d = evaluateRegistryEntry({
      machineId: 'PAIRED',
      incoming: entry({ role: 'awake' }),
      local: undefined,
      currentCommittedEpoch: 5,
      hasValidJoinRecord: true,
    });
    expect(d.accept).toBe(true);
  });
});

describe('reconcileRegistryEntries', () => {
  it('applies accepted entries and reports rejected ones', () => {
    const result = reconcileRegistryEntries({
      localEntries: {
        A: entry({ syncSequence: 4, authoredUnderEpoch: 5 }),
        B: entry({ syncSequence: 1, authoredUnderEpoch: 5 }),
      },
      incomingEntries: {
        A: entry({ syncSequence: 5, authoredUnderEpoch: 5 }), // fresh → accept
        B: entry({ syncSequence: 1, authoredUnderEpoch: 5 }), // stale → reject
        EVIL: entry({ role: 'awake' }),                       // unknown awake → reject
      },
      currentCommittedEpoch: 5,
    });
    expect(Object.keys(result.accepted)).toEqual(['A']);
    expect(result.rejected.map((r) => r.machineId).sort()).toEqual(['B', 'EVIL']);
  });
});
