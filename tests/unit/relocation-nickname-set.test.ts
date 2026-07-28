import { describe, it, expect } from 'vitest';
import { buildRelocationNicknameSet } from '../../src/core/RelocationNicknameSet.js';

describe('buildRelocationNicknameSet', () => {
  const SELF = 'm_self_laptop';
  const PEER = 'm_peer_mini';

  it('includes every capacities nickname with its machineId mapping', () => {
    const { knownNicknames, nickToMachine } = buildRelocationNicknameSet({
      capacities: [
        { machineId: SELF, nickname: 'Laptop' },
        { machineId: PEER, nickname: 'Mac Mini' },
      ],
      selfMachineId: SELF,
      selfNickname: 'Laptop',
    });
    expect(knownNicknames).toEqual(['Laptop', 'Mac Mini']);
    expect(nickToMachine.get('laptop')).toBe(SELF);
    expect(nickToMachine.get('mac mini')).toBe(PEER);
  });

  // THE REGRESSION: capacities omits the self nickname (the back-transfer bug).
  // Before the fix, "move to Laptop" found no match on the laptop and silently
  // fell through. The unioned self nickname must rescue it.
  it('rescues the self nickname when capacities omits it (back-transfer bug)', () => {
    const { knownNicknames, nickToMachine } = buildRelocationNicknameSet({
      capacities: [
        { machineId: SELF }, // self present but nickname missing
        { machineId: PEER, nickname: 'Mac Mini' },
      ],
      selfMachineId: SELF,
      selfNickname: 'Laptop',
    });
    expect(knownNicknames).toContain('Laptop');
    expect(knownNicknames).toContain('Mac Mini');
    expect(nickToMachine.get('laptop')).toBe(SELF);
  });

  it('rescues the self nickname when self is entirely absent from capacities', () => {
    const { nickToMachine } = buildRelocationNicknameSet({
      capacities: [{ machineId: PEER, nickname: 'Mac Mini' }],
      selfMachineId: SELF,
      selfNickname: 'Laptop',
    });
    expect(nickToMachine.get('laptop')).toBe(SELF);
    expect(nickToMachine.get('mac mini')).toBe(PEER);
  });

  it('does not override an explicit capacities mapping with the self fallback', () => {
    const { nickToMachine } = buildRelocationNicknameSet({
      capacities: [{ machineId: SELF, nickname: 'Laptop' }],
      selfMachineId: SELF,
      selfNickname: 'Laptop',
    });
    // First (capacities) mapping wins; no duplicate entry.
    expect(nickToMachine.get('laptop')).toBe(SELF);
    expect(nickToMachine.size).toBe(1);
  });

  it('de-duplicates case-insensitively and trims', () => {
    const { knownNicknames } = buildRelocationNicknameSet({
      capacities: [
        { machineId: PEER, nickname: 'Mac Mini' },
        { machineId: PEER, nickname: 'mac mini ' },
      ],
      selfMachineId: SELF,
      selfNickname: '  ',
    });
    expect(knownNicknames).toEqual(['Mac Mini']);
  });

  it('is a no-op for self when selfNickname is missing/blank', () => {
    const { knownNicknames, nickToMachine } = buildRelocationNicknameSet({
      capacities: [{ machineId: PEER, nickname: 'Mac Mini' }],
      selfMachineId: SELF,
      selfNickname: null,
    });
    expect(knownNicknames).toEqual(['Mac Mini']);
    expect(nickToMachine.has('laptop')).toBe(false);
  });

  it('ignores capacity entries with no nickname and no self fallback', () => {
    const { knownNicknames } = buildRelocationNicknameSet({
      capacities: [{ machineId: SELF }, { machineId: PEER }],
      selfMachineId: null,
      selfNickname: null,
    });
    expect(knownNicknames).toEqual([]);
  });
});
