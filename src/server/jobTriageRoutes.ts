/**
 * GET /jobs/triage — recent script-job triage decisions, counts and triage
 * sessions on this machine (job-cost-reduction §5.6.2, §8 item 6, §13).
 * `?scope=pool` merges every online machine's view through the injected pool
 * fan-out; a failed peer is listed under `pool.failed`, never dropped.
 *
 * Read-only. Never returns run output text except triage sessions' final
 * answers, already scrubbed and clamped (first line ≤200 characters for
 * structured-only slugs).
 */
import type { Router, Request, Response } from 'express';
import { readTriageAudit, type TriageAuditRow } from '../scheduler/JobResultTriage.js';
import type { JobTriageStateStore } from '../scheduler/JobTriageStateStore.js';
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from './peerUrlGuard.js';
import { poolPeerFetch, type PoolPeerTarget, type RopeResultRecorder } from './poolPeerFetch.js';

export interface PoolFanOutResult {
  results: Array<{ machineId: string; machineNickname?: string; body: unknown }>;
  failed: Array<{ machineId: string; machineNickname?: string; reason: string }>;
}

export interface JobTriageRoutesDeps {
  /** Null ⇒ triage is not constructed here (503). */
  state: () => JobTriageStateStore | null;
  auditPath: string;
  machineId: string | null;
  enabled: () => boolean;
  /** GET the given path (with query) on every online peer. Absent ⇒ pool scope answers self only. */
  fetchPool?: (pathWithQuery: string) => Promise<PoolFanOutResult>;
  now?: () => number;
}

/** Bounded, credential-safe fan-out shared by the pool view and cooldown admission. */
export function createJobTriagePoolFetcher(deps: {
  resolvePeerUrls: () => PoolPeerTarget[];
  authToken?: string;
  recordRopeResult?: RopeResultRecorder;
  fetchPeer?: (peer: PoolPeerTarget, path: string, init: Parameters<typeof fetch>[1]) => Promise<globalThis.Response>;
}): (pathWithQuery: string) => Promise<PoolFanOutResult> {
  return async pathWithQuery => {
    const results: PoolFanOutResult['results'] = [];
    const failed: PoolFanOutResult['failed'] = [];
    const peers = deps.resolvePeerUrls().slice(0, 16);
    const dial = deps.fetchPeer ?? ((peer, route, init) => poolPeerFetch(deps.recordRopeResult, peer, route, init));
    for (let i = 0; i < peers.length; i += 4) {
      await Promise.all(peers.slice(i, i + 4).map(async peer => {
        if (!isPeerUrlAllowedForCredentials({ url: peer.url, kind: (peer.kind ?? 'last-known-url') as PeerEndpointKind }).ok) {
          failed.push({ machineId: peer.machineId, reason: 'url-rejected' }); return;
        }
        try {
          const response = await dial(peer, pathWithQuery, {
            headers: { Authorization: `Bearer ${deps.authToken ?? ''}` },
            signal: AbortSignal.timeout(2_000),
            redirect: 'manual',
          });
          if (!response.ok) { failed.push({ machineId: peer.machineId, reason: `http-${response.status}` }); return; }
          const bodyText = await response.text();
          if (Buffer.byteLength(bodyText) > 2 * 1024 * 1024) { failed.push({ machineId: peer.machineId, reason: 'truncated' }); return; }
          const body: unknown = JSON.parse(bodyText);
          if (!body || typeof body !== 'object' || !('cooldowns' in body) || !('sessions' in body)) {
            failed.push({ machineId: peer.machineId, reason: 'invalid-body' }); return;
          }
          results.push({ machineId: peer.machineId, body });
        } catch {
          failed.push({ machineId: peer.machineId, reason: 'peer-unreachable' });
        }
      }));
    }
    return { results, failed };
  };
}

export interface JobTriageView {
  machineId: string | null;
  enabled: boolean;
  since: string;
  counts: {
    byDecider: Record<string, number>;
    byDecision: Record<string, number>;
    byAction: Record<string, number>;
    sessionsSpawned: number;
    floorRequiredRefused: number;
    backupDisagreements: number;
  };
  perSlug: Record<string, { decisions: number; sessions: number; suppressed: number; refused: number; lastTs: string }>;
  recent: TriageAuditRow[];
  sessions: Array<{ sessionName: string; slug: string; runId: string; startedAt: string; endedAt?: string; output?: string; outcome?: string; origin: string }>;
  cooldowns: Record<string, string>;
  daily: { day: string; perSlug: Record<string, number>; machine: number };
  backup: { lastPassAt?: string; consecutiveFailures: number; lastConsidered?: Record<string, { considered: number; read: number; unread: number; at: string }> };
}

/** Builds this machine's view over the last `sinceHours` (default 24). */
export function buildJobTriageView(deps: JobTriageRoutesDeps, store: JobTriageStateStore, sinceHours = 24, limit = 50): JobTriageView {
  const now = (deps.now ?? Date.now)();
  const sinceMs = now - sinceHours * 3_600_000;
  const rows = readTriageAudit(deps.auditPath, now).filter((r) => Date.parse(r.ts) >= sinceMs);
  const counts: JobTriageView['counts'] = { byDecider: {}, byDecision: {}, byAction: {}, sessionsSpawned: 0, floorRequiredRefused: 0, backupDisagreements: 0 };
  const perSlug: JobTriageView['perSlug'] = {};
  for (const r of rows) {
    if (r.kind !== 'decision') continue;
    const inc = (m: Record<string, number>, k: unknown) => { if (typeof k === 'string') m[k] = (m[k] ?? 0) + 1; };
    inc(counts.byDecider, r.decider);
    inc(counts.byDecision, r.decision);
    const action = typeof r.action === 'string' ? r.action : 'none';
    inc(counts.byAction, action.split(':')[0]);
    if (action.startsWith('spawned')) counts.sessionsSpawned++;
    if (r.floor === true && (action.startsWith('refused') || action === 'suppressed-cap')) counts.floorRequiredRefused++;
    if (r.note === 'backup-disagrees') counts.backupDisagreements++;
    if (typeof r.slug === 'string') {
      const s = (perSlug[r.slug] ??= { decisions: 0, sessions: 0, suppressed: 0, refused: 0, lastTs: r.ts });
      s.decisions++;
      if (action.startsWith('spawned')) s.sessions++;
      if (action.startsWith('suppressed')) s.suppressed++;
      if (action.startsWith('refused')) s.refused++;
      s.lastTs = r.ts;
    }
  }
  const st = store.snapshot();
  return {
    machineId: deps.machineId,
    enabled: deps.enabled(),
    since: new Date(sinceMs).toISOString(),
    counts,
    perSlug,
    recent: rows.slice(-limit),
    sessions: st.sessions.filter((s) => Date.parse(s.startedAt) >= sinceMs).map((s) => ({ ...s })),
    cooldowns: st.cooldowns,
    daily: { day: st.daily.day, perSlug: st.daily.perSlug, machine: st.daily.machine },
    backup: { lastPassAt: st.backup.lastPassAt, consecutiveFailures: st.backup.consecutiveFailures, lastConsidered: st.backup.lastConsidered },
  };
}

/**
 * Pool cooldown check for admitTriageSpawn: true when any machine's view shows
 * a session for `<slug>:<reason set>` at or after `sinceMs`. null when the pool
 * cannot be read (the local check then decides).
 */
export async function poolHasRecentTriageSession(fetchPool: JobTriageRoutesDeps['fetchPool'], conditionKey: string, sinceMs: number): Promise<boolean | null> {
  if (!fetchPool) return null;
  try {
    const res = await fetchPool('/jobs/triage');
    for (const r of res.results) {
      const body = r.body as Partial<JobTriageView> | null;
      const at = body?.cooldowns?.[conditionKey];
      if (typeof at === 'string' && Date.parse(at) >= sinceMs) return true;
    }
    return res.failed.length ? null : false;
  } catch {
    return null; // @silent-fallback-ok — an unreadable pool means the local cooldown decides (§5.6.2)
  }
}

export function mountJobTriageRoutes(router: Router, deps: JobTriageRoutesDeps): void {
  router.get('/jobs/triage', async (req: Request, res: Response) => {
    const store = deps.state();
    if (!store) { res.status(503).json({ error: 'job-triage-unavailable' }); return; }
    const sinceHours = Math.min(Math.max(Number(req.query.sinceHours) || 24, 1), 14 * 24);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    let self: JobTriageView;
    try { self = buildJobTriageView(deps, store, sinceHours, limit); }
    catch { res.status(503).json({ error: 'job-triage-read-failed' }); return; }
    if (req.query.scope !== 'pool') {
      if (req.query.scope !== undefined && req.query.scope !== 'local') { res.status(400).json({ error: 'invalid-scope' }); return; }
      res.json(self);
      return;
    }
    const machines: Array<JobTriageView & { machineNickname?: string; remote?: boolean }> = [self];
    let failed: PoolFanOutResult['failed'] = [];
    if (deps.fetchPool) {
      try {
        const out = await deps.fetchPool(`/jobs/triage?sinceHours=${sinceHours}&limit=${limit}`);
        for (const r of out.results) {
          if (r.body && typeof r.body === 'object') machines.push({ ...(r.body as JobTriageView), machineId: r.machineId, machineNickname: r.machineNickname, remote: true });
        }
        failed = out.failed;
      } catch {
        failed = [{ machineId: '*', reason: 'pool-fanout-failed' }];
      }
    }
    res.json({ scope: 'pool', machines, pool: { selfMachineId: deps.machineId, peersOk: machines.length - 1, failed } });
  });
}
