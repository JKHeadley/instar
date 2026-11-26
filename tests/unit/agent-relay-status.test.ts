import { describe, expect, it } from 'vitest';
import { resolveAgentRelayStatus } from '../../src/threadline/agentRelayStatus.js';

const fingerprint = 'a'.repeat(32);
const peers = [{ machineId: 'studio', nickname: 'Studio', url: 'https://studio.example' }];
const base = { localConnected: false, localMachineId: 'laptop', fingerprint, peers };

describe('agent-wide Threadline status', () => {
  it('reports a verified reachable holder while the local relay is off', async () => {
    const status = await resolveAgentRelayStatus({
      ...base,
      fetchHealth: async () => ({ fingerprint, relay: { state: 'connected' } }),
    });
    expect(status.state).toBe('reachable');
    expect(status.throughMachine).toBe('Studio');
    expect(status.ifMachineAway).toMatch(/interrupted/);
  });

  it('reports unknown when the holder cannot be reached', async () => {
    const status = await resolveAgentRelayStatus({ ...base, fetchHealth: async () => { throw new Error('unreachable'); } });
    expect(status.state).toBe('unknown');
    expect(status.peersUnknown).toBe(1);
  });

  it('reports no holder only after a verified sibling responds disconnected', async () => {
    const status = await resolveAgentRelayStatus({
      ...base,
      fetchHealth: async () => ({ fingerprint, relay: { state: 'standby' } }),
    });
    expect(status.state).toBe('unreachable');
    expect(status.throughMachine).toBeNull();
  });

  it('does not trust a connected peer with the wrong identity', async () => {
    const status = await resolveAgentRelayStatus({
      ...base,
      fetchHealth: async () => ({ fingerprint: 'b'.repeat(32), relay: { state: 'connected' } }),
    });
    expect(status.state).toBe('unknown');
  });

  it('keeps an empty standby roster unknown', async () => {
    const status = await resolveAgentRelayStatus({ ...base, peers: [], expectPeers: true });
    expect(status.state).toBe('unknown');
  });

  it('does not call a daemon-owned local relay off without a live daemon read', async () => {
    const status = await resolveAgentRelayStatus({ ...base, peers: [], localUnknown: true });
    expect(status.state).toBe('unknown');
  });

  it('reports the local live connection without probing peers', async () => {
    const status = await resolveAgentRelayStatus({ ...base, localConnected: true, fetchHealth: async () => { throw new Error('must not probe'); } });
    expect(status.state).toBe('reachable');
  });
  it('bounds peer fanout and counts unprobed machines as unknown', async () => {
    let probes = 0;
    const status = await resolveAgentRelayStatus({ ...base,
      peers: Array.from({ length: 12 }, (_, n) => ({ machineId: `peer-${n}`, url: `https://peer-${n}.example` })),
      fetchHealth: async () => { probes++; return { fingerprint, relay: { state: 'standby' } }; },
    });
    expect(probes).toBe(8);
    expect(status.state).toBe('unknown');
    expect(status.peersUnknown).toBe(4);
  });
});
