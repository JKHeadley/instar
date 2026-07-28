import { describe, it, expect } from 'vitest';
import { describeTopicPlacement } from '../../src/core/TopicPlacementDescription.js';

describe('describeTopicPlacement', () => {
  const SELF = 'm_self';
  const PEER = 'm_peer';
  const nicknameOf = (id: string | null): string | null =>
    id === SELF ? 'Laptop' : id === PEER ? 'Mac Mini' : null;

  it('reports a deliberate pin as reason "pinned" with target', () => {
    const d = describeTopicPlacement({
      topicId: '13481',
      owner: PEER,
      pinnedTo: PEER,
      leaseHolder: SELF,
      selfMachineId: SELF,
      nicknameOf,
    });
    expect(d.reason).toBe('pinned');
    expect(d.pinnedTo).toBe(PEER);
    expect(d.pinnedToNickname).toBe('Mac Mini');
    expect(d.ownerNickname).toBe('Mac Mini');
    expect(d.leaseHolderNickname).toBe('Laptop');
    expect(d.isThisMachine).toBe(false);
  });

  // The exact ambiguity that caused the confusion: owned but NOT pinned = load-placed,
  // NOT a deliberate move. The describer must NOT report this as "pinned".
  it('reports an unpinned owned topic as reason "placed" (load-balanced, not a move)', () => {
    const d = describeTopicPlacement({
      topicId: '13481',
      owner: PEER,
      pinnedTo: null,
      leaseHolder: SELF,
      selfMachineId: SELF,
      nicknameOf,
    });
    expect(d.reason).toBe('placed');
    expect(d.pinnedTo).toBeNull();
    expect(d.owner).toBe(PEER);
  });

  it('reports an unowned topic as reason "unowned"', () => {
    const d = describeTopicPlacement({
      topicId: '99',
      owner: null,
      pinnedTo: null,
      leaseHolder: SELF,
      selfMachineId: SELF,
      nicknameOf,
    });
    expect(d.reason).toBe('unowned');
    expect(d.ownerNickname).toBeNull();
  });

  it('sets isThisMachine when the answering machine owns the topic', () => {
    const d = describeTopicPlacement({
      topicId: '7',
      owner: SELF,
      pinnedTo: SELF,
      leaseHolder: SELF,
      selfMachineId: SELF,
      nicknameOf,
    });
    expect(d.isThisMachine).toBe(true);
    expect(d.thisMachine).toBe(SELF);
  });

  it('does not claim isThisMachine when owner is null even if self is null', () => {
    const d = describeTopicPlacement({
      topicId: '7',
      owner: null,
      pinnedTo: null,
      leaseHolder: null,
      selfMachineId: null,
      nicknameOf,
    });
    expect(d.isThisMachine).toBe(false);
  });
});
