/**
 * Reading from this agent's other machines. Spec section 2: parallel, one shared 6s deadline, at
 * most 16 peers, 512KB per response, `redirect: 'manual'`. Anything but a 2xx JSON answer counts
 * as no answer, so an older peer's 404 reads `unreachable` and never as absence.
 */
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from '../../server/peerUrlGuard.js';
import { poolPeerFetch, type PoolPeerTarget, type RopeResultRecorder } from '../../server/poolPeerFetch.js';
import type { SourceRef } from './marker.js';
import type { LocalLookup, PeerAnswer } from './SourceResolver.js';

export const PEER_DEADLINE_MS = 6_000;
export const MAX_PEERS = 16;
export const MAX_PEER_RESPONSE_BYTES = 512 * 1024;

export interface PeerFanoutDeps {
  peers: () => PoolPeerTarget[];
  /** Every active machine of this agent. One missing from `peers` has no usable URL yet. */
  registeredMachines?: () => string[];
  authToken: () => string | undefined;
  recordRope?: RopeResultRecorder;
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
}

export interface PeerJson { machine: string; answered: boolean; json?: unknown }

async function readBounded(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('no-body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PEER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('too-large');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class PeerFanout {
  constructor(private readonly deps: PeerFanoutDeps) {}

  get peerCount(): number {
    return this.deps.peers().length;
  }

  /** GETs a `scope=local` path from every peer. A peer past the limit is reported as not answering. */
  async getAll(pathWithQuery: string): Promise<PeerJson[]> {
    const peers = this.deps.peers();
    const signal = AbortSignal.timeout(this.deps.deadlineMs ?? PEER_DEADLINE_MS);
    const token = this.deps.authToken();
    const asked = peers.slice(0, MAX_PEERS).map(async (peer): Promise<PeerJson> => {
      if (!isPeerUrlAllowedForCredentials({ url: peer.url, kind: peer.kind as PeerEndpointKind }).ok) {
        return { machine: peer.machineId, answered: false };
      }
      try {
        const response = await poolPeerFetch(this.deps.recordRope, peer, pathWithQuery, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal,
          redirect: 'manual',
        }, this.deps.fetchImpl);
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          return { machine: peer.machineId, answered: false };
        }
        return { machine: peer.machineId, answered: true, json: await readBounded(response) };
      } catch {
        // @silent-fallback-ok — reported to the caller as this machine not answering.
        return { machine: peer.machineId, answered: false };
      }
    });
    const rest = peers.slice(MAX_PEERS).map((peer): PeerJson => ({ machine: peer.machineId, answered: false }));
    // A registered machine with no URL could not be asked, so it cannot have said "no".
    const dialable = new Set(peers.map((peer) => peer.machineId));
    const unasked = (this.deps.registeredMachines?.() ?? [])
      .filter((machine) => !dialable.has(machine))
      .map((machine): PeerJson => ({ machine, answered: false }));
    return [...(await Promise.all(asked)), ...rest, ...unasked];
  }

  async askResolve(ref: SourceRef): Promise<PeerAnswer[]> {
    const query = new URLSearchParams({ scope: 'local', channel: ref.channel, conversation: ref.conversation, message: ref.message, date: ref.date });
    const answers = await this.getAll(`/attribution/resolve?${query.toString()}`);
    return answers.map((answer) => {
      const lookup = answer.answered ? parseLookup(answer.json) : undefined;
      return lookup ? { machine: answer.machine, answered: true, lookup } : { machine: answer.machine, answered: false };
    });
  }
}

const AUTHORSHIP = new Set(['agent-outbound', 'agent-verified', 'human', 'rejected', 'UNRESOLVED', 'unclassifiable']);

/** A peer's answer is data: only the expected shape gets through, and eligibility re-runs here. */
function parseLookup(json: unknown): LocalLookup | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const value = json as Record<string, unknown>;
  const row = value.row && typeof value.row === 'object' && !Array.isArray(value.row) ? (value.row as Record<string, unknown>) : null;
  return {
    row,
    retainedFrom: typeof value.retainedFrom === 'string' ? value.retainedFrom : null,
    ...(value.removed === true ? { removed: true } : {}),
    ...(value.pinned === true ? { pinned: true } : {}),
    ...(typeof value.authorship === 'string' && AUTHORSHIP.has(value.authorship) ? { authorship: value.authorship as LocalLookup['authorship'] } : {}),
  };
}
