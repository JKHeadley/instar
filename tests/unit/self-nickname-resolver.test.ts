import { describe, it, expect } from 'vitest';
import { resolveSelfNickname } from '../../src/core/SelfNicknameResolver.js';

describe('resolveSelfNickname', () => {
  const SELF = 'm_laptop';
  const PEER = 'm_mini';

  it('uses the local capacity view when it carries the self nickname (symmetric case)', () => {
    expect(
      resolveSelfNickname({
        selfMachineId: SELF,
        localCapacities: [{ machineId: SELF, nickname: 'Laptop' }, { machineId: PEER, nickname: 'Mac Mini' }],
      }),
    ).toBe('Laptop');
  });

  // THE REGRESSION (live-caught 2026-06-04): self nickname ABSENT from the local view
  // (laptop's own entry nickname=None) but PRESENT in a peer's view (the mini calls it
  // "Laptop"). The old fix fed self-nickname in synthetically and never hit this.
  it('falls back to a PEER view that names this machine when the local view omits it', () => {
    expect(
      resolveSelfNickname({
        selfMachineId: SELF,
        localCapacities: [{ machineId: SELF /* no nickname */ }, { machineId: PEER, nickname: 'Mac Mini' }],
        peerCapacities: [[{ machineId: SELF, nickname: 'Laptop' }, { machineId: PEER, nickname: 'Mac Mini' }]],
        derive: () => 'Justins Macbook Pro', // derive would give the WRONG name — peer view must win
      }),
    ).toBe('Laptop');
  });

  it('prefers the local view over a peer view when both have it', () => {
    expect(
      resolveSelfNickname({
        selfMachineId: SELF,
        localCapacities: [{ machineId: SELF, nickname: 'Local Name' }],
        peerCapacities: [[{ machineId: SELF, nickname: 'Peer Name' }]],
      }),
    ).toBe('Local Name');
  });

  it('falls back to derive only when neither local nor any peer view names this machine', () => {
    expect(
      resolveSelfNickname({
        selfMachineId: SELF,
        localCapacities: [{ machineId: SELF }],
        peerCapacities: [[{ machineId: PEER, nickname: 'Mac Mini' }]],
        derive: () => 'Derived Name',
      }),
    ).toBe('Derived Name');
  });

  it('returns null when nothing resolves (caller omits self nickname — pre-existing behavior)', () => {
    expect(
      resolveSelfNickname({ selfMachineId: SELF, localCapacities: [{ machineId: SELF }] }),
    ).toBeNull();
  });

  it('ignores blank/whitespace nicknames at every layer', () => {
    expect(
      resolveSelfNickname({
        selfMachineId: SELF,
        localCapacities: [{ machineId: SELF, nickname: '   ' }],
        peerCapacities: [[{ machineId: SELF, nickname: '' }]],
        derive: () => '  ',
      }),
    ).toBeNull();
  });

  it('derives (or null) when selfMachineId is unknown', () => {
    expect(
      resolveSelfNickname({ selfMachineId: null, localCapacities: [], derive: () => 'X' }),
    ).toBe('X');
  });
});
