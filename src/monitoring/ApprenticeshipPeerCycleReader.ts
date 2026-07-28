/**
 * Bounded same-host peer read for apprenticeship cycle evidence.
 *
 * Each agent owns its own SQLite cycle store. Role coverage is an agent-wide
 * question, so the serving agent asks every other live, non-lifeline agent for
 * the named instance's cycles and reports failures/truncation explicitly.
 * This module is observe-only: it never writes, repairs, or relocates a cycle.
 */
import type { AgentRegistryEntry } from '../core/types.js';
import type { ApprenticeshipCycleRecord } from './ApprenticeshipCycleStore.js';

export interface ApprenticeshipPeerCycleSource {
  agent: string;
  port: number;
  cycleCount: number;
  truncated: boolean;
  error?: string;
}

export interface ApprenticeshipPeerCycleRead {
  cycles: ApprenticeshipCycleRecord[];
  sources: ApprenticeshipPeerCycleSource[];
  complete: boolean;
  /** Eligible peers omitted by the maxPeers bound. Non-zero always makes complete=false. */
  omittedPeerCount: number;
}

export interface ApprenticeshipPeerCycleReaderOptions {
  selfAgent: string;
  listAgents: () => AgentRegistryEntry[];
  getAgentToken: (agentName: string) => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxPeers?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PEERS = 32;
const PEER_CYCLE_LIMIT = 500;

function isCycleRecord(value: unknown, instanceId: string): value is ApprenticeshipCycleRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && record.id.length > 0
    && record.instanceId === instanceId
    && typeof record.createdAt === 'string'
    && typeof record.kind === 'string'
    && typeof record.channel === 'string';
}

/** Read peer cycle stores concurrently, with one bounded request per live agent. */
export async function readApprenticeshipPeerCycles(
  instanceId: string,
  options: ApprenticeshipPeerCycleReaderOptions,
): Promise<ApprenticeshipPeerCycleRead> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPeers = options.maxPeers ?? DEFAULT_MAX_PEERS;
  const eligiblePeers = options.listAgents()
    .filter((agent) => agent.status === 'running')
    .filter((agent) => agent.name !== options.selfAgent && !agent.name.endsWith('-lifeline'));
  const peers = eligiblePeers.slice(0, maxPeers);
  const omittedPeerCount = Math.max(0, eligiblePeers.length - peers.length);

  const results = await Promise.all(peers.map(async (peer): Promise<{
    cycles: ApprenticeshipCycleRecord[];
    source: ApprenticeshipPeerCycleSource;
  }> => {
    const token = options.getAgentToken(peer.name);
    if (!token) {
      return { cycles: [], source: { agent: peer.name, port: peer.port, cycleCount: 0, truncated: false, error: 'auth-unavailable' } };
    }
    try {
      const url = `http://localhost:${peer.port}/a2a/apprenticeship/cycles?instanceId=${encodeURIComponent(instanceId)}&limit=${PEER_CYCLE_LIMIT}`;
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { cycles?: unknown };
      if (!Array.isArray(body.cycles)) throw new Error('invalid cycles response');
      const cycles = body.cycles.filter((cycle) => isCycleRecord(cycle, instanceId));
      const malformedCount = body.cycles.length - cycles.length;
      const truncated = body.cycles.length >= PEER_CYCLE_LIMIT;
      return {
        cycles,
        source: {
          agent: peer.name,
          port: peer.port,
          cycleCount: cycles.length,
          truncated,
          ...(malformedCount > 0 ? { error: `${malformedCount} malformed cycle record(s)` } : {}),
        },
      };
    } catch (error) {
      return {
        cycles: [],
        source: {
          agent: peer.name,
          port: peer.port,
          cycleCount: 0,
          truncated: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }));

  const sources = results.map((result) => result.source);
  if (omittedPeerCount > 0) {
    sources.push({
      agent: 'registry-overflow', port: 0, cycleCount: 0, truncated: true,
      error: `${omittedPeerCount} eligible peer(s) omitted by maxPeers=${maxPeers}`,
    });
  }
  return {
    cycles: results.flatMap((result) => result.cycles),
    sources,
    complete: omittedPeerCount === 0 && results.every((result) => !result.source.error && !result.source.truncated),
    omittedPeerCount,
  };
}
