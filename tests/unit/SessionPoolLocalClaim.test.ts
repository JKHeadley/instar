import { describe, expect, it, vi } from 'vitest';
import { confirmLocalPlacementAfterDelivery } from '../../src/core/SessionPoolLocalClaim.js';

describe('confirmLocalPlacementAfterDelivery', () => {
  it('confirms a placing row owned by this machine', () => {
    const claimOwnership = vi.fn(() => ({ confirmed: true }));
    expect(confirmLocalPlacementAfterDelivery({
      selfMachineId: 'self',
      readOwnership: () => ({ ownerMachineId: 'self', status: 'placing' }),
      claimOwnership,
    }, 'topic-1')).toBe(true);
    expect(claimOwnership).toHaveBeenCalledWith('topic-1', 'self');
  });

  it.each([
    [{ ownerMachineId: 'self', status: 'active' }, 'already active'],
    [{ ownerMachineId: 'remote', status: 'placing' }, 'placed remotely'],
    [null, 'missing'],
  ])('does not claim when the ownership row is %s (%s)', (row) => {
    const claimOwnership = vi.fn(() => ({ confirmed: true }));
    expect(confirmLocalPlacementAfterDelivery({
      selfMachineId: 'self',
      readOwnership: () => row,
      claimOwnership,
    }, 'topic-1')).toBe(false);
    expect(claimOwnership).not.toHaveBeenCalled();
  });

  it.each(['read', 'claim'])('contains a %s failure after delivery and leaves confirmation false', (failure) => {
    const error = new Error(`${failure} failed`);
    const onError = vi.fn();
    let result: boolean | undefined;
    expect(() => {
      result = confirmLocalPlacementAfterDelivery({
        selfMachineId: 'self',
        readOwnership: () => {
          if (failure === 'read') throw error;
          return { ownerMachineId: 'self', status: 'placing' };
        },
        claimOwnership: () => {
          if (failure === 'claim') throw error;
        return { confirmed: true };
        },
        onError,
      }, 'topic-1');
    }).not.toThrow();
    expect(result).toBe(false);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('keeps a committed confirmation true when its observer throws', () => {
    const error = new Error('emit failed');
    const onError = vi.fn();
    expect(confirmLocalPlacementAfterDelivery({
      selfMachineId: 'self',
      readOwnership: () => ({ ownerMachineId: 'self', status: 'placing' }),
      claimOwnership: () => ({
        confirmed: true,
        afterConfirm: () => { throw error; },
      }),
      onError,
    }, 'topic-1')).toBe(true);
    expect(onError).toHaveBeenCalledWith(error);
  });
});
