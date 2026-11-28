import { describe, it, expect } from 'vitest';
import { profileProposalPlacement } from '../../src/core/profileProposalPlacement.js';
import { InMemorySessionOwnershipStore, SessionOwnershipRegistry } from '../../src/core/SessionOwnershipRegistry.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';
const record = (key: string, owner: string, epoch: number): SessionOwnershipRecord => ({ sessionKey: key,
  ownerMachineId: owner, ownershipEpoch: epoch, status: 'active', nonce: `epoch-${epoch}`, timestamp: epoch,
  updatedAt: new Date(epoch).toISOString() });
describe('proposal placement control', () => {
  it('distinguishes standalone, unreadable configured state, and readable absent records', () => {
    expect(profileProposalPlacement(null, null, 'A', 'B')).toBe('standalone');
    expect(profileProposalPlacement(null, null, 'A', 'B', true)).toBeNull();
    expect(profileProposalPlacement({ read: () => { throw new Error('unreadable'); } }, 'self', 'A', 'B')).toBeNull();
    expect(profileProposalPlacement({ read: () => null }, 'self', 'A', 'B')).not.toBeNull();
  });
  it.each(['A', 'B'])('binds source and destination epochs even after %s moves away and back', key => {
    const store = new InMemorySessionOwnershipStore();
    const registry = new SessionOwnershipRegistry({ store, seenNonce: () => false, recordNonce: () => {} });
    store.casWrite(record('A', 'self', 1)); store.casWrite(record('B', 'self', 1));
    const first = profileProposalPlacement(registry, 'self', 'A', 'B'); expect(first).not.toBeNull();
    store.casWrite(record(key, 'peer', 2)); expect(profileProposalPlacement(registry, 'self', 'A', 'B')).toBeNull();
    store.casWrite(record(key, 'self', 3)); expect(profileProposalPlacement(registry, 'self', 'A', 'B')).not.toBe(first);
  });
});
