/**
 * GET /quota-pacing — per-account quota forecast and per-provider weekly runway
 * (docs/specs/quota-pacing-forecast.md §3). Read-only and owner-only (bearer); it is not in
 * TEAM_ROUTE_TIERS or any phone route.
 *
 *   - default (pool scope): this machine's summaries plus each peer's `?scope=local` summaries
 *     over the shared bearer pool fan-out, validated, merged per login by identity.
 *   - `?scope=local`: this machine's computed summaries only (what peers serve; never fans out).
 *   - `?account=ID&history=1`: this machine's rows for that account (current and previous cycle),
 *     local only. An id that fails the pool rule or is not in the local pool is 404 with no file read.
 *   - 503 `quota-pacing-off` while `subscriptionPool.pacing.enabled` resolves off.
 *
 * Signal only: the answer is a measurement; nothing in this step reads it to decide.
 */
import { Router, type Request, type Response } from 'express';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import type { RouteContext } from './routes.js';
import { createPoolBuildLimiter, poolFanOut } from './poolFanOut.js';
import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import { isWindowAwareChoiceEnabled } from '../core/windowAwarePlacement.js';
import {
  ACCOUNT_CHOICE_SHADOW_SCHEMA, pageShadowRows, readShadowRows, shadowLogPath, summarizeShadowRows,
  type ShadowDaySummary,
} from '../monitoring/AccountChoiceShadowLog.js';
import { buildLocalSummaries, isQuotaPacingEnabled, type QuotaHistoryLedger } from '../monitoring/QuotaHistoryLedger.js';
import {
  HOUR_MS, QUOTA_PACING_SCHEMA, assembleProviders, mergeLogins, parseMs, poolCalibration, validatePeerSummary,
  type LoginSummary,
} from '../monitoring/quotaPacing.js';

const MAX_PEER_BYTES = 256 * 1024;
const MAX_PEER_LOGINS = 512;
const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;

export type QuotaPacingCtx = Pick<RouteContext, 'config' | 'meshSelfId' | 'machinePoolRegistry' | 'resolvePeerUrls' | 'recordRopeResult' | 'subscriptionPool'> & {
  quotaPacing: () => QuotaHistoryLedger | null;
  pollIntervalMs?: number;
  now?: () => number;
};

function nicknameOf(ctx: QuotaPacingCtx, machineId: string | null | undefined): string {
  if (!machineId) return 'this machine';
  return verifiedEntityName(machineId, ctx.machinePoolRegistry?.getCapacity(machineId)?.nickname) ?? 'another machine';
}

export function createQuotaPacingRoutes(ctx: QuotaPacingCtx, timings: { peerTimeoutMs?: number; fanOutDeadlineMs?: number } = {}): Router {
  const PEER_TIMEOUT_MS = timings.peerTimeoutMs ?? 1_500;
  const FAN_OUT_DEADLINE_MS = timings.fanOutDeadlineMs ?? 3_000;
  const router = Router();
  const allowPoolBuild = createPoolBuildLimiter();
  const clock = ctx.now ?? (() => Date.now());

  router.get('/quota-pacing', async (req: Request, res: Response) => {
    if (!isQuotaPacingEnabled(ctx.config)) {
      res.status(503).json({ error: 'quota-pacing-off', detail: 'quota pacing is not switched on for this agent (subscriptionPool.pacing.enabled)' });
      return;
    }
    const ledger = ctx.quotaPacing();
    const pool = ctx.subscriptionPool;
    if (!ledger || !pool) {
      res.status(503).json({ error: 'quota-pacing-not-running', detail: 'the quota history is not running on this machine' });
      return;
    }
    const now = clock();
    const selfId = ctx.meshSelfId ?? 'local';
    const pollIntervalMs = ctx.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const hasPeers = (ctx.resolvePeerUrls?.() ?? []).length > 0;

    // ── History for one account (local only, never forwarded) ──
    if (req.query.account !== undefined || req.query.history !== undefined) {
      const id = typeof req.query.account === 'string' ? req.query.account : '';
      // Validate, then require the id in the local pool, BEFORE any file is read.
      if (!ledger.fileFor(id) || !pool.get(id)) { res.status(404).json({ error: 'unknown-account' }); return; }
      const rows = (await ledger.rows(id)) ?? [];
      const last = [...rows].reverse().find((r) => r.windows?.sevenDay?.resetsAt);
      const reset = parseMs(last?.windows?.sevenDay?.resetsAt ?? null);
      // Current and previous cycle: from two weeks before the current reset (or now).
      const since = (Number.isFinite(reset) ? reset : now) - 14 * 24 * HOUR_MS;
      res.json({
        schema: QUOTA_PACING_SCHEMA, scope: 'local', generatedAt: new Date(now).toISOString(), machineId: selfId, accountId: id,
        rows: rows.filter((r) => parseMs(r.polledAt) >= since).map((r) => ({ ...r, resolution: r.resolution ?? 'full' })),
        coverage: await ledger.coverage(id),
      });
      return;
    }

    const local = await buildLocalSummaries(ledger, pool, { machineId: selfId, pollIntervalMs, now });
    const counters = ledger.stats();

    if (req.query.scope === 'local') {
      const merged = mergeLogins(local.summaries, now);
      res.json({
        schema: QUOTA_PACING_SCHEMA, scope: 'local', generatedAt: new Date(now).toISOString(), machineId: selfId,
        logins: local.summaries,
        providers: assembleProviders(merged.logins, now, { localOnly: hasPeers }),
        coverage: { accounts: local.coverage, ...counters },
      });
      return;
    }

    if (!allowPoolBuild(now)) { res.status(429).json({ error: 'rate-limited' }); return; }
    const all: LoginSummary[] = [...local.summaries];
    const sources: Array<{ machineId: string; machine: string; status: 'ok' | 'failed'; reason?: string }> = [
      { machineId: selfId, machine: nicknameOf(ctx, ctx.meshSelfId ?? null), status: 'ok' },
    ];
    const malformed = new Map<string, number>();
    await poolFanOut(ctx, {
      path: '/quota-pacing?scope=local', peerTimeoutMs: PEER_TIMEOUT_MS, fanOutDeadlineMs: FAN_OUT_DEADLINE_MS, maxBytes: MAX_PEER_BYTES,
      accept: (body, p) => {
        if (body.schema !== QUOTA_PACING_SCHEMA || body.scope !== 'local' || !Array.isArray(body.logins)) return 'invalid-body';
        for (const raw of body.logins.slice(0, MAX_PEER_LOGINS)) {
          const s = validatePeerSummary(raw, p.machineId);
          if (s) all.push(s);
          else malformed.set(p.machineId, (malformed.get(p.machineId) ?? 0) + 1);
        }
        return null;
      },
      onResult: (p, ok, reason) => {
        const machine = nicknameOf(ctx, p.machineId);
        sources.push(ok ? { machineId: p.machineId, machine, status: 'ok' } : { machineId: p.machineId, machine, status: 'failed', reason });
      },
    });
    const merged = mergeLogins(all, now);
    res.json({
      schema: QUOTA_PACING_SCHEMA, scope: 'pool', generatedAt: new Date(now).toISOString(),
      providers: assembleProviders(merged.logins, now, { localOnly: false }),
      coverage: {
        accounts: local.coverage, ...counters,
        malformedSummaries: [...malformed].map(([machineId, count]) => ({ machineId, count })),
        clockAhead: merged.clockAhead,
      },
      sources,
      couldNotRead: sources.filter((s) => s.status === 'failed').map((s) => ({ machineId: s.machineId, machine: s.machine, reason: s.reason })),
      calibration: poolCalibration(merged.logins),
    });
  });

  /**
   * GET /quota-pacing/account-choice — quota pacing step 2's shadow evidence
   * (docs/specs/quota-pacing-account-choice.md §5). Bearer-only, read-only.
   *   - default (`scope=pool`): one per-machine, per-day summary for this machine plus each peer
   *     (each peer asked `?scope=local-summary`), naming any machine that did not answer.
   *   - `?scope=local&since=&until=&limit=&cursor=`: this machine's raw rows, paged (limit ≤ 500).
   *   - `?machine=<id>&…`: one other machine's raw page, through the same bearer peer fetch.
   *   - 503 `window-aware-choice-off` while `subscriptionPool.pacing.windowAwareChoice` resolves off.
   */
  const allowChoicePoolBuild = createPoolBuildLimiter();
  router.get('/quota-pacing/account-choice', async (req: Request, res: Response) => {
    if (!isWindowAwareChoiceEnabled(ctx.config)) {
      res.status(503).json({ error: 'window-aware-choice-off', detail: 'window-aware account choice is not switched on for this machine (subscriptionPool.pacing.windowAwareChoice)' });
      return;
    }
    const stateDir = (ctx.config as { stateDir?: string }).stateDir;
    if (!stateDir) { res.status(503).json({ error: 'window-aware-choice-not-running' }); return; }
    const now = clock();
    const selfId = ctx.meshSelfId ?? 'local';
    const file = shadowLogPath(stateDir);
    const q = (k: string): string | undefined => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
    const num = (k: string): number | undefined => {
      const v = q(k);
      if (v === undefined) return undefined;
      const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      return Number.isFinite(t) ? t : undefined;
    };
    const pageQuery = () => ({ sinceMs: num('since'), untilMs: num('until'), limit: num('limit'), cursor: q('cursor') ?? null });
    const pageParams = () => {
      const u = new URLSearchParams();
      for (const k of ['since', 'until', 'limit', 'cursor']) { const v = q(k); if (v !== undefined) u.set(k, v); }
      return u.toString();
    };

    const machine = q('machine');
    if (q('scope') === 'local' || (machine !== undefined && machine === selfId)) {
      const { rows, malformed } = await readShadowRows(file);
      const page = pageShadowRows(rows, pageQuery());
      res.json({ schema: ACCOUNT_CHOICE_SHADOW_SCHEMA, scope: 'local', generatedAt: new Date(now).toISOString(), machineId: selfId, rows: page.rows, next: page.next, malformed });
      return;
    }
    if (q('scope') === 'local-summary') {
      const { rows, malformed } = await readShadowRows(file);
      res.json({ schema: ACCOUNT_CHOICE_SHADOW_SCHEMA, scope: 'local-summary', generatedAt: new Date(now).toISOString(), machineId: selfId, days: summarizeShadowRows(rows), malformed });
      return;
    }
    if (machine !== undefined) {
      const peer = (ctx.resolvePeerUrls?.() ?? []).find((p) => p.machineId === machine);
      if (!peer) { res.status(404).json({ error: 'unknown-machine' }); return; }
      const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
      if (!isPeerUrlAllowedForCredentials({ url: peer.url, kind: peer.kind }, allow).ok) {
        res.status(502).json({ error: 'peer-not-allowed', machineId: machine }); return;
      }
      try {
        const r = await poolPeerFetch(ctx.recordRopeResult ?? undefined, peer, `/quota-pacing/account-choice?scope=local&${pageParams()}`, {
          headers: { Authorization: `Bearer ${ctx.config.authToken}` }, signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
        });
        const text = await r.text();
        if (!r.ok) { res.status(502).json({ error: 'peer-failed', machineId: machine, status: r.status }); return; }
        if (Buffer.byteLength(text) > MAX_PEER_BYTES) { res.status(502).json({ error: 'peer-too-large', machineId: machine }); return; }
        const body = JSON.parse(text) as Record<string, unknown>;
        if (body.schema !== ACCOUNT_CHOICE_SHADOW_SCHEMA || body.scope !== 'local' || !Array.isArray(body.rows)) {
          res.status(502).json({ error: 'peer-invalid-body', machineId: machine }); return;
        }
        res.json({ ...body, machineId: machine });
      } catch (err) { // @silent-fallback-ok — answered as a named 502, never dropped
        res.status(502).json({ error: err instanceof Error && err.name === 'TimeoutError' ? 'peer-deadline' : 'peer-unreachable', machineId: machine });
      }
      return;
    }

    if (!allowChoicePoolBuild(now)) { res.status(429).json({ error: 'rate-limited' }); return; }
    const { rows, malformed } = await readShadowRows(file);
    const machines: Array<{ machineId: string; machine: string; days: ShadowDaySummary[] }> = [
      { machineId: selfId, machine: nicknameOf(ctx, ctx.meshSelfId ?? null), days: summarizeShadowRows(rows) },
    ];
    const couldNotRead: Array<{ machineId: string; machine: string; reason?: string }> = [];
    await poolFanOut(ctx, {
      path: '/quota-pacing/account-choice?scope=local-summary', peerTimeoutMs: PEER_TIMEOUT_MS, fanOutDeadlineMs: FAN_OUT_DEADLINE_MS, maxBytes: MAX_PEER_BYTES,
      accept: (body, p) => {
        if (body.schema !== ACCOUNT_CHOICE_SHADOW_SCHEMA || body.scope !== 'local-summary' || !Array.isArray(body.days)) return 'invalid-body';
        machines.push({ machineId: p.machineId, machine: nicknameOf(ctx, p.machineId), days: (body.days as ShadowDaySummary[]).slice(0, 62) });
        return null;
      },
      onResult: (p, ok, reason) => {
        if (!ok) couldNotRead.push({ machineId: p.machineId, machine: nicknameOf(ctx, p.machineId), reason });
      },
    });
    res.json({ schema: ACCOUNT_CHOICE_SHADOW_SCHEMA, scope: 'pool', generatedAt: new Date(now).toISOString(), machines, couldNotRead, malformed });
  });

  return router;
}
