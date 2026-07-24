import { describe, expect, it, vi } from 'vitest';
import { readApprenticeshipPeerCycles } from '../../src/monitoring/ApprenticeshipPeerCycleReader.js';
import type { AgentRegistryEntry } from '../../src/core/types.js';

const agent = (name: string, port: number, status: AgentRegistryEntry['status'] = 'running'): AgentRegistryEntry => ({
  name, port, status, type: 'project-bound', path: `/agents/${name}`, pid: 1,
  createdAt: '2026-07-16T00:00:00.000Z', lastHeartbeat: '2026-07-16T00:00:00.000Z',
});

const cycle = (id: string) => ({
  id, instanceId: 'echo-to-codey', cycleNumber: 1, createdAt: '2026-07-16T00:00:00.000Z',
  task: 'drive', menteeOutput: 'output', mentorFlagged: [], overseerDifferential: [], coaching: '',
  infraItems: [], kind: 'mentor-mentee-differential', status: 'open', channel: 'threadline-backup',
  operatorSeatUx: null, transcriptAudit: null,
});

describe('readApprenticeshipPeerCycles', () => {
  it('reads every live non-lifeline peer and preserves source completeness', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify({
      cycles: [cycle(String(url).includes('4042') ? 'echo-cycle' : 'gemini-cycle')],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await readApprenticeshipPeerCycles('echo-to-codey', {
      selfAgent: 'instar-codey',
      listAgents: () => [agent('instar-codey', 4044), agent('echo', 4042), agent('gemini', 4048), agent('echo-lifeline', 5042), agent('stopped', 4050, 'stopped')],
      getAgentToken: (name) => `token-${name}`,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.cycles.map((row) => row.id).sort()).toEqual(['echo-cycle', 'gemini-cycle']);
    expect(result.complete).toBe(true);
    expect(result.omittedPeerCount).toBe(0);
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'echo', cycleCount: 1 }),
      expect.objectContaining({ agent: 'gemini', cycleCount: 1 }),
    ]));
  });

  it('marks the census incomplete when the peer bound omits eligible agents', async () => {
    const result = await readApprenticeshipPeerCycles('echo-to-codey', {
      selfAgent: 'instar-codey',
      listAgents: () => [agent('echo', 4042), agent('gemini', 4048), agent('inspec', 4046)],
      getAgentToken: () => 'token',
      maxPeers: 2,
      fetchImpl: (async () => new Response(JSON.stringify({ cycles: [] }), { status: 200 })) as typeof fetch,
    });

    expect(result.complete).toBe(false);
    expect(result.omittedPeerCount).toBe(1);
    expect(result.sources).toContainEqual(expect.objectContaining({
      agent: 'registry-overflow', truncated: true, error: expect.stringContaining('omitted'),
    }));
  });

  it('returns partial evidence with an explicit failed source instead of fabricating completeness', async () => {
    const result = await readApprenticeshipPeerCycles('echo-to-codey', {
      selfAgent: 'instar-codey',
      listAgents: () => [agent('echo', 4042), agent('gemini', 4048)],
      getAgentToken: (name) => name === 'echo' ? 'token' : null,
      fetchImpl: (async () => new Response(JSON.stringify({ cycles: [cycle('echo-cycle')] }), { status: 200 })) as typeof fetch,
    });

    expect(result.cycles).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.sources).toContainEqual(expect.objectContaining({ agent: 'gemini', error: 'auth-unavailable' }));
  });
});
