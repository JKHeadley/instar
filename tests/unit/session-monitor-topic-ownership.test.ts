import { describe, expect, it } from 'vitest';
import { isForeignTopicOwner } from '../../src/monitoring/SessionMonitor.js';

describe('SessionMonitor topic ownership', () => {
  const self = 'studio';
  const foreign = 'mama-pc';

  it.each(['placing', 'active', 'transferring'] as const)(
    'does not monitor a topic assigned to another machine while %s',
    (status) => {
      expect(isForeignTopicOwner({ status, ownerMachineId: foreign }, self)).toBe(true);
    },
  );

  it('does not treat an unreachable peer as permission to announce a session death', () => {
    // Reachability is intentionally absent from the ownership decision.
    expect(isForeignTopicOwner({ status: 'active', ownerMachineId: foreign }, self)).toBe(true);
  });

  it('monitors local, released, and unrecorded topics', () => {
    expect(isForeignTopicOwner({ status: 'active', ownerMachineId: self }, self)).toBe(false);
    expect(isForeignTopicOwner({ status: 'released', ownerMachineId: foreign }, self)).toBe(false);
    expect(isForeignTopicOwner(null, self)).toBe(false);
    expect(isForeignTopicOwner({ status: 'active', ownerMachineId: foreign }, null)).toBe(false);
  });
});
