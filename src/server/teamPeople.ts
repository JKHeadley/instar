/**
 * The People read and the second-person notice (docs/specs/team-roles-and-access.md §3.10).
 *
 * `GET /team/people` answers "who can reach this agent, and what can they see?". With
 * `?scope=pool` it merges every machine's answer and names any machine that did not answer, so a
 * partial list never reads as complete. Peers are asked the plain route, so a read never recurses.
 *
 * The notice runs on the lease holder only, one voice for the agent. It blocks nothing.
 */
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from './peerUrlGuard.js';
import type { PersonRow, ReachablePeople, ReachNotice } from '../users/ReachablePeople.js';

export interface PeerTarget { machineId: string; url: string; kind: PeerEndpointKind }

export interface TeamPeopleReadDeps {
  people: ReachablePeople;
  selfMachineId: string | null;
  authToken: () => string | undefined;
  peers: () => PeerTarget[];
  peerUrlAllowlist?: () => string[] | undefined;
  fetchImpl?: typeof fetch;
}

export interface TeamPeopleAnswer {
  people: PersonRow[];
  count: number | 'anyone';
  privacyOn?: boolean;
  telegramOpenToGroup: boolean;
  observedKeys: string[];
  /** What this machine has raised, so a lease move does not reopen a dismissed item. */
  hold: { lastRaisedCount: number; askedBothYou: boolean };
  pool?: { complete: boolean; failed: Array<{ machineId: string; reason: string }> };
}

const PEER_TIMEOUT_MS = 5000;
const MAX_PEERS = 16;
const MAX_ROWS = 500;

const text = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, max) : '');

/** A peer's answer is untrusted data: fixed fields, bounded text, an unknown tier reads as unknown. */
export function sanitizePeerRow(raw: unknown): PersonRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = text(r.key);
  if (!key) return null;
  const tier = r.tier === 'owner' || r.tier === 'admin' || r.tier === 'member' || r.tier === 'guest' ? r.tier : 'unknown';
  const reach = Array.isArray(r.reach) ? r.reach.slice(0, 20).flatMap((x) => {
    const via = text((x as { via?: unknown })?.via, 40);
    const detail = text((x as { detail?: unknown })?.detail);
    return via && detail ? [{ via, detail }] : [];
  }) : [];
  const warnings = Array.isArray(r.warnings) ? r.warnings.slice(0, 10).map((w) => text(w, 300)).filter(Boolean) : [];
  return {
    key, name: text(r.name) || key, tier, reach, sees: text(r.sees, 300), warnings,
    ...(r.relationship === 'msp' ? { relationship: 'msp' as const } : {}),
  };
}

/** Merge rows by key: one person seen on two machines is one row with both ways in. */
export function mergeRows(rows: PersonRow[]): PersonRow[] {
  const out = new Map<string, PersonRow>();
  for (const row of rows) {
    const cur = out.get(row.key);
    if (!cur) { out.set(row.key, { ...row, reach: [...row.reach], warnings: [...row.warnings] }); continue; }
    for (const x of row.reach) if (!cur.reach.some((y) => y.via === x.via && y.detail === x.detail)) cur.reach.push(x);
    for (const w of row.warnings) if (!cur.warnings.includes(w)) cur.warnings.push(w);
  }
  return [...out.values()].slice(0, MAX_ROWS);
}

function localAnswer(deps: TeamPeopleReadDeps, peerKeys: readonly string[] = []): TeamPeopleAnswer {
  const n = deps.people.count(peerKeys);
  return {
    people: deps.people.rows(),
    count: Number.isFinite(n) ? n : 'anyone',
    telegramOpenToGroup: deps.people.telegramOpenToGroup(),
    observedKeys: deps.people.observedKeys(),
    hold: deps.people.hold(),
  };
}

async function askPeers(deps: TeamPeopleReadDeps): Promise<{ rows: PersonRow[]; keys: string[]; holds: Array<Record<string, unknown>>; failed: Array<{ machineId: string; reason: string }> }> {
  const rows: PersonRow[] = [];
  const holds: Array<Record<string, unknown>> = [];
  const keys: string[] = [];
  const failed: Array<{ machineId: string; reason: string }> = [];
  const doFetch = deps.fetchImpl ?? fetch;
  const all = deps.peers().filter((p) => p.machineId !== deps.selfMachineId);
  for (const p of all.slice(MAX_PEERS)) failed.push({ machineId: p.machineId, reason: 'omitted-cap' });
  await Promise.all(all.slice(0, MAX_PEERS).map(async (p) => {
    if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: p.kind }, deps.peerUrlAllowlist?.()).ok) {
      failed.push({ machineId: p.machineId, reason: 'url-rejected' });
      return;
    }
    try {
      const r = await doFetch(`${p.url}/team/people`, {
        headers: { Authorization: `Bearer ${deps.authToken() ?? ''}` }, signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (r.status === 404) { failed.push({ machineId: p.machineId, reason: 'route-missing' }); return; }
      if (!r.ok) { failed.push({ machineId: p.machineId, reason: `http-${r.status}` }); return; }
      const body = (await r.json()) as { people?: unknown; observedKeys?: unknown; hold?: unknown };
      if (body.hold && typeof body.hold === 'object') holds.push(body.hold as Record<string, unknown>);
      for (const raw of Array.isArray(body.people) ? body.people.slice(0, MAX_ROWS) : []) {
        const row = sanitizePeerRow(raw);
        if (row) rows.push(row);
      }
      for (const k of Array.isArray(body.observedKeys) ? body.observedKeys.slice(0, MAX_ROWS) : []) {
        const key = text(k);
        if (key) keys.push(key);
      }
    } catch (err) { // @silent-fallback-ok — the failure is a visible pool.failed row naming the machine
      failed.push({ machineId: p.machineId, reason: err instanceof Error && err.name === 'TimeoutError' ? 'deadline' : 'unreachable' });
    }
  }));
  return { rows, keys, holds, failed };
}

export async function readTeamPeople(deps: TeamPeopleReadDeps, scope: 'local' | 'pool'): Promise<TeamPeopleAnswer> {
  if (scope === 'local') return localAnswer(deps);
  const peer = await askPeers(deps);
  const local = localAnswer(deps, peer.keys);
  return {
    ...local,
    people: mergeRows([...local.people, ...peer.rows]),
    observedKeys: [...new Set([...local.observedKeys, ...peer.keys])],
    pool: { complete: peer.failed.length === 0, failed: peer.failed },
  };
}

export interface ReachNoticeDeps extends TeamPeopleReadDeps {
  /** One voice: only the lease holder raises. */
  holdsLease: () => boolean;
  /** Puts the item where the owner sees it. False means it did not land, so the next pass retries. */
  raise: (notice: ReachNotice) => Promise<boolean>;
}

/**
 * One pass of the notices. Never throws. An unreachable peer can under-count, and that is no
 * reason to stay quiet about the people this machine can already see.
 */
export async function runReachNotices(deps: ReachNoticeDeps): Promise<ReachNotice[]> {
  const raised: ReachNotice[] = [];
  try {
    if (!deps.holdsLease()) return raised;
    const { keys, holds } = await askPeers(deps);
    for (const hold of holds) deps.people.adoptHold(hold);
    /* @self-action-controller: reach-second-person-notice */
    const second = deps.people.warning(keys);
    if (second && await deps.raise(second)) { deps.people.noteRaised(second.count); raised.push(second); }
    const both = deps.people.bothYouQuestion();
    if (both && await deps.raise(both)) { deps.people.noteAskedBothYou(); raised.push(both); }
  } catch (err) {
    // @silent-fallback-ok — a notice pass is retried on the next tick and affects no message.
    console.warn(`[team-people] notice pass failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return raised;
}
