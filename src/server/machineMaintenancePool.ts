/**
 * Pool view for machine self-maintenance (CMT-1199).
 *
 * `GET /machine-maintenance?scope=pool` and `GET /machine-maintenance/lock-state?scope=pool`
 * answer from ANY machine with every online machine's watch-only maintenance state,
 * each tagged with its machineId and verified nickname.
 *
 * Read-only by construction: each peer is asked for its PLAIN route (no scope=pool,
 * so no recursion), the merged answer carries `authority: 'none'`, `canRestart: false`
 * and `canStopWork: false`, and nothing here can start, schedule or approve a restart
 * or a close. A peer that is dark, offline, on an older version without the route, or
 * unreachable is listed under `pool.failed` with a NORMALIZED reason — never a 500,
 * never a peer URL, never a token or a raw error message.
 */
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from './peerUrlGuard.js';
import { poolPeerFetch, type PoolPeerTarget, type RopeResultRecorder } from './poolPeerFetch.js';
import type { PoolPollCache } from './PoolPollCache.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';

export type MaintenancePoolPart = 'status' | 'lock-state';

/** Closed set of reasons a machine's state is missing from the pool view. */
export type MaintenancePoolFailureReason =
  | 'offline'          // the pool registry says this machine is offline; not dialled
  | 'url-rejected'     // no rope we may send the API token over
  | 'not-enabled'      // the machine answered 503: maintenance is dark there
  | 'route-missing'    // the machine answered 404: an older version without this route
  | 'unauthorized'     // the machine refused our token (401/403)
  | 'http-error'       // any other non-2xx answer
  | 'too-large'        // the body exceeded the per-machine cap
  | 'invalid-body'     // the body was not a JSON object
  | 'read-failed'      // this machine's own reading threw
  | 'peer-unreachable'; // no answer at all (timeout, refused, DNS, TLS)

export interface MaintenancePoolFailure {
  machineId: string;
  machineNickname?: string;
  reason: MaintenancePoolFailureReason;
}

export interface MaintenancePoolMachine {
  machineId: string;
  machineNickname?: string;
  self: boolean;
  /** That machine's own plain-route answer, as data. */
  state: Record<string, unknown>;
}

export interface MaintenancePoolView {
  scope: 'pool';
  part: MaintenancePoolPart;
  /** Fixed: this view grants nothing and can trigger nothing. */
  authority: 'none';
  readOnly: true;
  canRestart: false;
  canStopWork: false;
  machines: MaintenancePoolMachine[];
  pool: {
    selfMachineId: string | null;
    peersQueried: number;
    peersOk: number;
    failed: MaintenancePoolFailure[];
    /** True when any peer body was a last-cached copy served under CPU load-shed. */
    stale: boolean;
  };
}

export const MAINTENANCE_PEER_MAX_BYTES = 1024 * 1024;
export const MAINTENANCE_PEER_TIMEOUT_MS = 2_500;
export const MAINTENANCE_POOL_MAX_PEERS = 16;
const BATCH = 4;

export function routeForPart(part: MaintenancePoolPart): string {
  return part === 'lock-state' ? '/machine-maintenance/lock-state' : '/machine-maintenance';
}

/** Map a peer's HTTP status to a normalized failure reason (2xx ⇒ null). */
export function classifyPeerStatus(status: number): MaintenancePoolFailureReason | null {
  if (status >= 200 && status < 300) return null;
  if (status === 503) return 'not-enabled';
  if (status === 404) return 'route-missing';
  if (status === 401 || status === 403) return 'unauthorized';
  return 'http-error';
}

class PeerFailure extends Error {
  constructor(readonly reason: MaintenancePoolFailureReason) { super(reason); }
}

export interface MaintenancePeerResult {
  machineId: string;
  body: Record<string, unknown>;
}

export interface MaintenanceFanOutDeps {
  peers: PoolPeerTarget[];
  authToken: string;
  /** Registry view: `online === false` skips the dial. */
  getCapacity?: (machineId: string) => { online?: boolean; nickname?: string | null } | null | undefined;
  recordRopeResult?: RopeResultRecorder;
  poolPollCache?: PoolPollCache | null;
  /** Test seam; production dials through poolPeerFetch. */
  fetchPeer?: (peer: PoolPeerTarget, path: string, init: Parameters<typeof fetch>[1]) => Promise<globalThis.Response>;
  timeoutMs?: number;
}

/** Ask every peer for its plain maintenance route. Never throws. */
export async function fetchMaintenancePool(
  deps: MaintenanceFanOutDeps,
  part: MaintenancePoolPart,
): Promise<{ results: MaintenancePeerResult[]; failed: MaintenancePoolFailure[]; stale: boolean; queried: number }> {
  const route = routeForPart(part);
  const peers = deps.peers.slice(0, MAINTENANCE_POOL_MAX_PEERS);
  const results: MaintenancePeerResult[] = [];
  const failed: MaintenancePoolFailure[] = [];
  let stale = false;
  const dial = deps.fetchPeer ?? ((peer, p, init) => poolPeerFetch(deps.recordRopeResult, peer, p, init));

  const fetchOne = async (peer: PoolPeerTarget): Promise<Record<string, unknown>> => {
    let response: globalThis.Response;
    try {
      response = await dial(peer, route, {
        headers: { Authorization: `Bearer ${deps.authToken}` },
        signal: AbortSignal.timeout(deps.timeoutMs ?? MAINTENANCE_PEER_TIMEOUT_MS),
        redirect: 'manual',
      });
    } catch {
      // @silent-fallback-ok — a dial failure becomes a classified `peer-unreachable` row in pool.failed
      throw new PeerFailure('peer-unreachable');
    }
    const reason = classifyPeerStatus(response.status);
    if (reason) throw new PeerFailure(reason);
    let text: string;
    try { text = await response.text(); } catch { throw new PeerFailure('peer-unreachable'); }
    if (Buffer.byteLength(text) > MAINTENANCE_PEER_MAX_BYTES) throw new PeerFailure('too-large');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new PeerFailure('invalid-body'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PeerFailure('invalid-body');
    return parsed as Record<string, unknown>;
  };

  for (let i = 0; i < peers.length; i += BATCH) {
    await Promise.all(peers.slice(i, i + BATCH).map(async (peer) => {
      const cap = deps.getCapacity?.(peer.machineId);
      if (cap && cap.online === false) { failed.push({ machineId: peer.machineId, reason: 'offline' }); return; }
      if (!isPeerUrlAllowedForCredentials({ url: peer.url, kind: (peer.kind ?? 'last-known-url') as PeerEndpointKind }).ok) {
        failed.push({ machineId: peer.machineId, reason: 'url-rejected' });
        return;
      }
      try {
        let body: Record<string, unknown>;
        if (deps.poolPollCache) {
          const r = await deps.poolPollCache.fetchPeer(peer.machineId, route, () => fetchOne(peer));
          body = r.body;
          if (r.stale) stale = true;
        } else {
          body = await fetchOne(peer);
        }
        results.push({ machineId: peer.machineId, body });
      } catch (err) {
        // @silent-fallback-ok — every peer failure is listed in pool.failed with a normalized reason
        failed.push({ machineId: peer.machineId, reason: err instanceof PeerFailure ? err.reason : 'peer-unreachable' });
      }
    }));
  }
  return { results, failed, stale, queried: peers.length };
}

/** Pure merge: self first, then peers by name; every machine tagged; read-only flags fixed. */
export function mergeMaintenancePool(input: {
  part: MaintenancePoolPart;
  selfMachineId: string | null;
  selfNickname?: string | null;
  /** This machine's own answer, or the reason it has none. */
  self: { body: Record<string, unknown> } | { reason: MaintenancePoolFailureReason };
  results: MaintenancePeerResult[];
  failed: MaintenancePoolFailure[];
  queried: number;
  stale: boolean;
  nicknameOf?: (machineId: string) => string | null | undefined;
}): MaintenancePoolView {
  const name = (id: string, candidate: unknown): string | undefined => verifiedEntityName(id, candidate) ?? undefined;
  const selfId = input.selfMachineId ?? 'self';
  const machines: MaintenancePoolMachine[] = [];
  const failed: MaintenancePoolFailure[] = [];
  if ('body' in input.self) {
    machines.push({ machineId: selfId, machineNickname: name(selfId, input.selfNickname), self: true, state: input.self.body });
  } else {
    failed.push({ machineId: selfId, machineNickname: name(selfId, input.selfNickname), reason: input.self.reason });
  }
  const seen = new Set<string>([selfId]);
  const peers: MaintenancePoolMachine[] = [];
  for (const r of input.results) {
    if (seen.has(r.machineId)) continue;
    seen.add(r.machineId);
    peers.push({ machineId: r.machineId, machineNickname: name(r.machineId, input.nicknameOf?.(r.machineId)), self: false, state: r.body });
  }
  peers.sort((a, b) => (a.machineNickname ?? a.machineId).localeCompare(b.machineNickname ?? b.machineId));
  machines.push(...peers);
  for (const f of input.failed) {
    if (seen.has(f.machineId)) continue;
    seen.add(f.machineId);
    failed.push({ machineId: f.machineId, machineNickname: name(f.machineId, input.nicknameOf?.(f.machineId)), reason: f.reason });
  }
  return {
    scope: 'pool',
    part: input.part,
    authority: 'none',
    readOnly: true,
    canRestart: false,
    canStopWork: false,
    machines,
    pool: {
      selfMachineId: input.selfMachineId,
      peersQueried: input.queried,
      peersOk: input.results.length,
      failed,
      stale: input.stale,
    },
  };
}
