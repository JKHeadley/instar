/**
 * PeerPresencePuller — the HTTP presence transport for the Multi-Machine Session
 * Pool. The pool registry's "online" was originally fed ONLY by the git-synced
 * MachineHeartbeat, so a credential-less standby (paired over HTTP, no push
 * access to the shared agent repo) never appeared online and the placement
 * engine refused to transfer to it. This puller pulls each reachable peer's
 * self-capacity over the signed /mesh/rpc `session-status` command and records
 * it into the pool registry — marking the peer online without ever touching git.
 *
 * These tests pin the loop semantics with injected fakes (no live mesh):
 *  - a peer that answers is recorded (id + loadAvg + selfReportedLastSeen)
 *  - self is never polled
 *  - a peer with no resolvable URL is skipped
 *  - a fetch that REJECTS does not throw and does not record (peer ages out)
 *  - a fetch that resolves null does not record
 *  - selfReportedLastSeen falls back to the injected clock when the peer omits it
 */
import { describe, it, expect, vi } from 'vitest';
import { PeerPresencePuller, type PeerPresenceMachine } from '../../src/core/PeerPresencePuller.js';

function makePuller(opts: {
  self: string;
  peers: PeerPresenceMachine[];
  fetchImpl: (machineId: string, url: string) => Promise<{ selfReportedLastSeen?: string; loadAvg?: number } | null>;
  now?: () => Date;
}) {
  const recorded: Array<{ machineId: string; selfReportedLastSeen: string; loadAvg?: number }> = [];
  const puller = new PeerPresencePuller({
    selfMachineId: opts.self,
    listPeers: () => opts.peers,
    fetchPeerCapacity: opts.fetchImpl,
    recordHeartbeat: (obs) => recorded.push(obs),
    now: opts.now,
  });
  return { puller, recorded };
}

describe('PeerPresencePuller.pullOnce', () => {
  it('records a peer that answers with its self-capacity (online over HTTP, no git)', async () => {
    const { puller, recorded } = makePuller({
      self: 'm_self',
      peers: [{ machineId: 'm_mini', url: 'https://mini.example.dev' }],
      fetchImpl: async () => ({ selfReportedLastSeen: '2026-05-29T10:00:00.000Z', loadAvg: 1.25 }),
    });

    const res = await puller.pullOnce();

    expect(res.recorded).toEqual(['m_mini']);
    expect(recorded).toEqual([
      { machineId: 'm_mini', selfReportedLastSeen: '2026-05-29T10:00:00.000Z', loadAvg: 1.25 },
    ]);
  });

  it('never polls or records itself', async () => {
    const fetchImpl = vi.fn(async () => ({ loadAvg: 0.1 }));
    const { puller, recorded } = makePuller({
      self: 'm_self',
      peers: [
        { machineId: 'm_self', url: 'https://self.example.dev' },
        { machineId: 'm_mini', url: 'https://mini.example.dev' },
      ],
      fetchImpl,
    });

    const res = await puller.pullOnce();

    expect(res.recorded).toEqual(['m_mini']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('m_mini', 'https://mini.example.dev');
    expect(recorded.map((r) => r.machineId)).toEqual(['m_mini']);
  });

  it('skips a peer with no resolvable URL (unreachable / not yet advertised)', async () => {
    const fetchImpl = vi.fn(async () => ({ loadAvg: 0.1 }));
    const { puller, recorded } = makePuller({
      self: 'm_self',
      peers: [{ machineId: 'm_mini', url: null }],
      fetchImpl,
    });

    const res = await puller.pullOnce();

    expect(res.recorded).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('does not throw and does not record when a peer fetch REJECTS (peer ages out of online)', async () => {
    const { puller, recorded } = makePuller({
      self: 'm_self',
      peers: [
        { machineId: 'm_down', url: 'https://down.example.dev' },
        { machineId: 'm_up', url: 'https://up.example.dev' },
      ],
      fetchImpl: async (id) => {
        if (id === 'm_down') throw new Error('ETIMEDOUT');
        return { loadAvg: 0.5 };
      },
    });

    const res = await puller.pullOnce(); // must resolve, not reject

    expect(res.recorded).toEqual(['m_up']); // the reachable peer still recorded
    expect(recorded.map((r) => r.machineId)).toEqual(['m_up']);
  });

  it('does not record a peer that resolves null (answered but no capacity / rejected RBAC)', async () => {
    const { puller, recorded } = makePuller({
      self: 'm_self',
      peers: [{ machineId: 'm_mini', url: 'https://mini.example.dev' }],
      fetchImpl: async () => null,
    });

    const res = await puller.pullOnce();

    expect(res.recorded).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('falls back to the injected clock for selfReportedLastSeen when the peer omits it', async () => {
    const fixed = new Date('2026-05-29T12:34:56.000Z');
    const { puller, recorded } = makePuller({
      self: 'm_self',
      peers: [{ machineId: 'm_mini', url: 'https://mini.example.dev' }],
      fetchImpl: async () => ({ loadAvg: 2.0 }), // no selfReportedLastSeen
      now: () => fixed,
    });

    await puller.pullOnce();

    expect(recorded[0].selfReportedLastSeen).toBe(fixed.toISOString());
    expect(recorded[0].loadAvg).toBe(2.0);
  });

  it('re-reads listPeers each pass so a newly paired peer is picked up', async () => {
    let peers: PeerPresenceMachine[] = [];
    const recorded: string[] = [];
    const puller = new PeerPresencePuller({
      selfMachineId: 'm_self',
      listPeers: () => peers,
      fetchPeerCapacity: async () => ({ loadAvg: 0.1 }),
      recordHeartbeat: (obs) => recorded.push(obs.machineId),
    });

    expect((await puller.pullOnce()).recorded).toEqual([]); // no peers yet
    peers = [{ machineId: 'm_late', url: 'https://late.example.dev' }];
    expect((await puller.pullOnce()).recorded).toEqual(['m_late']); // picked up next pass
    expect(recorded).toEqual(['m_late']);
  });
});
