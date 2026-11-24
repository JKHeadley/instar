import { describe, expect, it } from 'vitest';
import { parseWorkDiscoveryQuery } from '../../src/server/workDiscoveryRoutes.js';

describe('work discovery request shape', () => {
  it('uses all enrolled sources, or only a requested enrolled source', () => {
    expect(parseWorkDiscoveryQuery({ query: ' instar.sh ' })).toEqual({
      query: 'instar.sh', sources: new Set(['conversations', 'pullRequests', 'specs']),
    });
    expect(parseWorkDiscoveryQuery({ query: 'SEC-123', sources: ['conversations'] })?.sources).toEqual(new Set(['conversations']));
  });

  it('does not accept a caller-supplied destination, role, or future source', () => {
    expect(parseWorkDiscoveryQuery({ query: 'instar.sh', destination: 'owner' })).toBeNull();
    expect(parseWorkDiscoveryQuery({ query: 'instar.sh', role: 'owner' })).toBeNull();
    expect(parseWorkDiscoveryQuery({ query: 'instar.sh', sources: ['projects'] })).toBeNull();
    expect(parseWorkDiscoveryQuery({ query: 'instar.sh', sources: [] })).toBeNull();
    expect(parseWorkDiscoveryQuery({ query: '***' })).toBeNull();
    expect(parseWorkDiscoveryQuery({ query: 'x'.repeat(201) })).toBeNull();
  });
});
