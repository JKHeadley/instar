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
import type { JobSupervisionStore, SupervisionAttempt } from '../scheduler/JobSupervisionStore.js';
import { isSideRun, type JobRunHistory } from '../scheduler/JobRunHistory.js';
import { jobSupervisionRolloutState, type JobSupervisionRolloutState } from '../scheduler/JobSupervisionRollout.js';
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
  supervision?: () => JobSupervisionStore | null;
  runHistory?: () => JobRunHistory | null;
  supervisionRollout?: () => JobSupervisionRolloutState;
  isScriptRunLive?: (runId: string) => boolean;
  /** Durable expected-machine roster; absent means pool completeness is unknown. */
  expectedMachineIds?: () => string[] | null;
}

export interface SupervisionCoverage {
  denominator: number;
  decisionCoverage: number;
  initialVerdictCoverage: number;
  byStatus: Record<string, number>;
  byProvider: Record<string, number>;
  byGrade: Record<string, number>;
  accuracy: number | null;
  gradableFraction: number | null;
  investigationCompletion: number | null;
  unchecked: Array<Pick<SupervisionAttempt, 'attemptId' | 'runId' | 'slug' | 'registeredAt' | 'reason' | 'status'>>;
  unresolved: Array<Pick<SupervisionAttempt, 'attemptId' | 'runId' | 'slug' | 'registeredAt' | 'reason' | 'status'>>;
  coverageIncomplete: boolean;
  reconciliation: { inserted: number; outcomeUnknown: number };
  attempts: SupervisionAttempt[];
  rollout: JobSupervisionRolloutState;
  holds: Array<{ slug: string; reason: string; heldAt: string }>;
  callAudit: ReturnType<JobSupervisionStore['callSummarySince']>;
}

/** The run history supplies the denominator, including rows missing from the new ledger. */
export function buildSupervisionCoverage(deps: JobTriageRoutesDeps, sinceHours: number): SupervisionCoverage | null {
  const store = deps.supervision?.();
  const history = deps.runHistory?.();
  if (!store || !history) return null;
  const scan = history.query({ sinceHours, limit: 5000, excludeSideRuns: true });
  const runs = scan.runs.filter(r => r.runner === 'script' && !isSideRun(r));
  const reconciliation = store.reconcileHistory(runs, (deps.now ?? Date.now)(), deps.isScriptRunLive);
  const byStatus: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  const byGrade: Record<string, number> = {};
  const unchecked: SupervisionCoverage['unchecked'] = [];
  const unresolved: SupervisionCoverage['unresolved'] = [];
  const attempts: SupervisionAttempt[] = [];
  let decisionCoverage = 0;
  let initialVerdictCoverage = 0;
  let requestedInvestigations = 0;
  let investigated = 0;
  let coverageIncomplete = scan.total > 5000 || !history.isReadHealthy() || store.journalWasRecreated();
  const censusRunIds = new Set(runs.map(r => r.runId));
  for (const run of runs) {
    const row = store.findByRunId(run.runId);
    if (!row) { coverageIncomplete = true; byStatus['unchecked:missing-record'] = (byStatus['unchecked:missing-record'] ?? 0) + 1; continue; }
    if (attempts.length < 5000) attempts.push(row);
    else coverageIncomplete = true;
    if (run.result === 'pending' && row.completedAt) coverageIncomplete = true;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byProvider[row.provider ?? 'none'] = (byProvider[row.provider ?? 'none'] ?? 0) + 1;
    byGrade[row.grade] = (byGrade[row.grade] ?? 0) + 1;
    if (row.investigation !== 'not-needed') requestedInvestigations++;
    if (row.investigation === 'investigated') investigated++;
    if (row.status === 'resolved' && (row.verdict === 'routine' || row.investigation === 'investigated')) decisionCoverage++;
    if (row.verdict) initialVerdictCoverage++;
    const item = { attemptId: row.attemptId, runId: row.runId, slug: row.slug,
      registeredAt: row.registeredAt, reason: row.reason, status: row.status };
    if (row.status === 'unchecked' || row.status === 'expired-unchecked') unchecked.push(item);
    if (row.status === 'unresolved') unresolved.push(item);
  }
  // A surviving supervision row with no independent history row is itself
  // evidence of a lost census. Include it in the denominator and make quality
  // rates unavailable until the independent ledger is repaired.
  let orphanAttempts = 0;
  const since = new Date((deps.now ?? Date.now)() - sinceHours * 3_600_000).toISOString();
  const ledgerRows = store.listSince(since, 5000);
  if (ledgerRows.length === 5000) coverageIncomplete = true;
  for (const row of ledgerRows) {
    if (censusRunIds.has(row.runId)) continue;
    orphanAttempts++;
    coverageIncomplete = true;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byProvider[row.provider ?? 'none'] = (byProvider[row.provider ?? 'none'] ?? 0) + 1;
    byGrade[row.grade] = (byGrade[row.grade] ?? 0) + 1;
    if (attempts.length < 5000) attempts.push(row);
    const item = { attemptId: row.attemptId, runId: row.runId, slug: row.slug,
      registeredAt: row.registeredAt, reason: row.reason, status: row.status };
    if (row.status === 'unchecked' || row.status === 'expired-unchecked') unchecked.push(item);
    if (row.status === 'unresolved') unresolved.push(item);
  }
  const denominator = runs.length + orphanAttempts;
  return { denominator, decisionCoverage, initialVerdictCoverage,
    byStatus, byProvider, byGrade,
    accuracy: !coverageIncomplete && (byGrade.correct ?? 0) + (byGrade.incorrect ?? 0) > 0
      ? (byGrade.correct ?? 0) / ((byGrade.correct ?? 0) + (byGrade.incorrect ?? 0)) : null,
    gradableFraction: coverageIncomplete ? null : denominator > 0
      ? ((byGrade.correct ?? 0) + (byGrade.incorrect ?? 0)) / denominator : null,
    investigationCompletion: requestedInvestigations > 0 ? investigated / requestedInvestigations : null,
    unchecked: unchecked.slice(0, 500), unresolved: unresolved.slice(0, 500),
    coverageIncomplete, reconciliation, attempts,
    rollout: deps.supervisionRollout?.() ?? jobSupervisionRolloutState(),
    holds: store.heldSlugs(),
    callAudit: store.callSummarySince(since) };
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
  supervision?: SupervisionCoverage | null;
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
    supervision: buildSupervisionCoverage(deps, sinceHours),
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
    const mergedAttempts = new Map<string, SupervisionAttempt>();
    const expected = deps.expectedMachineIds?.() ?? null;
    const observed = new Set(machines.map(m => m.machineId).filter((id): id is string => typeof id === 'string'));
    let coverageIncomplete = failed.length > 0 || !expected || expected.some(id => !observed.has(id));
    for (const machine of machines) {
      if (!machine.supervision || machine.supervision.coverageIncomplete) coverageIncomplete = true;
      for (const attempt of machine.supervision?.attempts ?? []) {
        if (!attempt?.attemptId) { coverageIncomplete = true; continue; }
        if (mergedAttempts.has(attempt.attemptId)
          && JSON.stringify(mergedAttempts.get(attempt.attemptId)) !== JSON.stringify(attempt)) coverageIncomplete = true;
        else mergedAttempts.set(attempt.attemptId, attempt);
      }
    }
    const byStatus: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    const byGrade: Record<string, number> = {};
    for (const row of mergedAttempts.values()) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      byProvider[row.provider ?? 'none'] = (byProvider[row.provider ?? 'none'] ?? 0) + 1;
      byGrade[row.grade] = (byGrade[row.grade] ?? 0) + 1;
    }
    res.json({ scope: 'pool', machines,
      supervision: { denominator: mergedAttempts.size, byStatus, byProvider, byGrade, coverageIncomplete,
        accuracy: coverageIncomplete || (byGrade.correct ?? 0) + (byGrade.incorrect ?? 0) === 0 ? null
          : (byGrade.correct ?? 0) / ((byGrade.correct ?? 0) + (byGrade.incorrect ?? 0)) },
      pool: { selfMachineId: deps.machineId, peersOk: machines.length - 1, failed } });
  });
}
