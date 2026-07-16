import { describe, expect, it, vi } from 'vitest';
import { SpawnAdmission, type SpawnAdmissionDeps } from '../../src/core/SpawnAdmission.js';

describe('respawn-dead SpawnAdmission integration', () => {
  function deps(alive: boolean): SpawnAdmissionDeps {
    return {
      selfMachineId: () => 'mini',
      poolStage: () => 'live',
      readOwnership: () => ({ owner: 'laptop', epoch: 4, status: 'owned' }),
      readHardPinOwner: () => 'laptop',
      isMachineAlive: () => alive,
      durableCustodyLive: () => true,
      journal: vi.fn(), raiseAttention: vi.fn(), provenance: vi.fn(), log: vi.fn(),
    };
  }

  it('graduates only the live-owner respawn row and preserves the dark-owner dry-run path', () => {
    const flag = { enabled: true, dryRun: true, enforceLiveOwner: true };
    const input = { sessionKey: '29723', callsite: 'telegram-respawn-dead' as const, routerVerdict: { messageId: 'm1', action: 'queued', acked: true } };
    expect(new SpawnAdmission(flag, deps(true)).admit(input)).toMatchObject({ allow: false, mode: 'enforce', refusalAction: 'forward' });
    expect(new SpawnAdmission(flag, deps(false)).admit(input)).toMatchObject({ allow: true, mode: 'dry-run', wouldBlock: true });
  });
});
