/** Agent-wide operational relay read. A failed peer probe is uncertainty, not evidence that Threadline is off. */
export interface AgentRelayPeer { machineId: string; url: string | null; nickname?: string }
export interface AgentRelayStatus {
  state: 'reachable' | 'unreachable' | 'unknown';
  throughMachine: string | null;
  throughMachineId: string | null;
  reason: string;
  ifMachineAway: string;
  peersChecked: number;
  peersUnknown: number;
}

export async function resolveAgentRelayStatus(input: {
  localConnected: boolean;
  localUnknown?: boolean;
  localMachineId: string | null;
  localName?: string;
  fingerprint: string | null;
  peers: AgentRelayPeer[];
  expectPeers?: boolean;
  fetchHealth?: (url: string, signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
  maxPeers?: number;
}): Promise<AgentRelayStatus> {
  if (input.localConnected) return {
    state: 'reachable', throughMachine: input.localName || input.localMachineId, throughMachineId: input.localMachineId,
    reason: 'This machine holds the live relay connection.',
    ifMachineAway: 'A standby must acquire the relay lease before Threadline is reachable again.',
    peersChecked: 0, peersUnknown: 0,
  };
  const allPeers = input.peers.filter(p => p.machineId !== input.localMachineId);
  const peers = allPeers.slice(0, input.maxPeers ?? 8);
  const unprobed = allPeers.length - peers.length;
  if (peers.length === 0 && input.expectPeers) return {
    state: 'unknown', throughMachine: null, throughMachineId: null,
    reason: 'The sibling roster is unavailable, so a relay holder cannot be checked.',
    ifMachineAway: 'Reachability cannot be confirmed until the sibling roster returns.',
    peersChecked: 0, peersUnknown: 1,
  };
  if (!input.fingerprint) return {
    state: 'unknown', throughMachine: null, throughMachineId: null,
    reason: 'The agent identity could not be verified on this machine.',
    ifMachineAway: 'Reachability cannot be confirmed until identity and a holder are verified.',
    peersChecked: 0, peersUnknown: peers.length,
  };
  let unknown = unprobed;
  const fetchHealth = input.fetchHealth ?? (async (url: string, signal: AbortSignal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`http-${response.status}`);
    return response.json();
  });
  const results = await Promise.all(peers.map(async peer => {
    if (!peer.url) { unknown++; return null; }
    try {
      const health = await fetchHealth(peer.url.replace(/\/+$/, '') + '/threadline/health?scope=local', AbortSignal.timeout(input.timeoutMs ?? 2000)) as {
        fingerprint?: string; relay?: { state?: string };
      };
      if (health?.fingerprint?.toLowerCase() !== input.fingerprint!.toLowerCase()) { unknown++; return null; }
      return health.relay?.state === 'connected' ? peer : null;
    } catch { unknown++; return null; }
  }));
  const holder = results.find((peer): peer is AgentRelayPeer => peer !== null);
  if (holder) return {
    state: 'reachable', throughMachine: holder.nickname || holder.machineId, throughMachineId: holder.machineId,
    reason: 'A verified sibling machine holds the live relay connection; standby sends forward through it.',
    ifMachineAway: 'The relay connection is interrupted until another machine acquires the lease.',
    peersChecked: peers.length, peersUnknown: unknown,
  };
  return {
    state: unknown || input.localUnknown ? 'unknown' : 'unreachable', throughMachine: null, throughMachineId: null,
    reason: unknown || input.localUnknown ? 'No holder was verified; at least one relay connection could not be checked.' : 'No verified machine currently holds a live relay connection.',
    ifMachineAway: 'Threadline is unreachable until a machine acquires the relay lease.',
    peersChecked: peers.length, peersUnknown: unknown,
  };
}
