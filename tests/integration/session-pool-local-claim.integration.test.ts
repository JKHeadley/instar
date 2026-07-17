import { describe, expect, it } from 'vitest';
import { confirmLocalPlacementAfterDelivery } from '../../src/core/SessionPoolLocalClaim.js';
import { InMemorySessionOwnershipStore, SessionOwnershipRegistry } from '../../src/core/SessionOwnershipRegistry.js';

describe('session-pool local placement confirmation', () => {
  it('advances the real ownership FSM only after the delivery-success callback runs', () => {
    const seen = new Set<string>();
    const registry = new SessionOwnershipRegistry({
      store: new InMemorySessionOwnershipStore(),
      seenNonce: (nonce) => seen.has(nonce),
      recordNonce: (nonce) => { seen.add(nonce); },
    });
    let nonce = 0;
    const transition = () => confirmLocalPlacementAfterDelivery({
      selfMachineId: 'mini',
      readOwnership: (sessionKey) => registry.read(sessionKey),
      claimOwnership: (sessionKey, machineId) => ({
        confirmed: registry.cas(
          { type: 'claim', machineId },
          { sessionKey, sender: 'mini', nonce: `claim:${++nonce}` },
        ).ok,
      }),
    }, '3461');

    expect(registry.cas(
      { type: 'place', machineId: 'mini' },
      { sessionKey: '3461', sender: 'mini', nonce: 'place:1' },
    ).ok).toBe(true);
    expect(registry.read('3461')?.status).toBe('placing');

    // A failed local spawn never invokes the success callback.
    expect(registry.read('3461')?.status).toBe('placing');

    expect(transition()).toBe(true);
    expect(registry.read('3461')?.status).toBe('active');
    expect(transition()).toBe(false);
    expect(registry.read('3461')?.status).toBe('active');
  });
});
