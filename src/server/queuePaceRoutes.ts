/**
 * GET /queue-pace — arrivals vs completions for every work queue (docs/specs/queue-pace.md).
 *
 * Read-only: serves the ledger's latest evaluation for this machine, or (scope=pool) merges
 * every answering machine's rows through the existing pool fan-out. Peer rows are clamped,
 * re-labelled from fixed labels and treated as data, never instructions. 503 while the
 * measure-only dev gate (queuePace.enabled) resolves off or the ledger is not built.
 */
import { Router, type Request, type Response } from 'express';
import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import type { RouteContext } from './routes.js';
import { QUEUE_IDS, QUEUE_LABELS, QUEUE_PACE_SCHEMA, REPO_RE, type QueueId, type Verdict } from '../monitoring/QueuePace.js';
import { isQueuePaceEnabled, type QueuePaceLedger, type QueuePaceQueueView } from '../monitoring/QueuePaceLedger.js';

const MAX_PEER_BYTES = 256 * 1024;
const VERDICTS: ReadonlySet<string> = new Set(['falling-behind', 'catching-up', 'holding', 'shrinking-by-exits', 'unknown', 'owner-not-serving']);
const KINDS: ReadonlySet<string> = new Set(['person', 'quota', 'cap', 'worker', 'unknown']);
/** A peer's free-text bottleneck detail is never relayed: the reason is re-worded here from its kind. */
const PEER_DETAIL: Record<string, string> = {
  person: 'waiting for a person',
  quota: 'the account usage limit paused the work',
  cap: 'a fixed limit is holding the work',
  worker: 'the work rounds keep running out of time with work still waiting',
  unknown: 'the reason could not be shown',
};

type PaceCtx = Pick<RouteContext, 'config' | 'meshSelfId' | 'machinePoolRegistry' | 'resolvePeerUrls' | 'recordRopeResult'> & {
  queuePace: () => QueuePaceLedger | null;
};

function nicknameOf(ctx: PaceCtx, machineId: string | null | undefined): string {
  if (!machineId) return 'this machine';
  return verifiedEntityName(machineId, ctx.machinePoolRegistry?.getCapacity(machineId)?.nickname) ?? 'another machine';
}

const num = (v: unknown, max = 1e9): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-max, Math.min(max, Math.round(v * 10) / 10)) : null);
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** Re-validate a peer's queue row. Labels come from our own fixed table, never the peer. */
export function sanitizePeerQueue(raw: unknown, machineId: string): QueuePaceQueueView | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.id !== 'string' || !(QUEUE_IDS as readonly string[]).includes(q.id)) return null;
  const id = q.id as QueueId;
  const verdict = (typeof q.verdict === 'string' && VERDICTS.has(q.verdict) ? q.verdict : 'unknown') as Verdict;
  const rawVerdict = (typeof q.rawVerdict === 'string' && VERDICTS.has(q.rawVerdict) ? q.rawVerdict : 'unknown') as Verdict;
  const b = q.bottleneck && typeof q.bottleneck === 'object' ? q.bottleneck as Record<string, unknown> : null;
  const c = q.coverage && typeof q.coverage === 'object' ? q.coverage as Record<string, unknown> : {};
  const t = q.tuner && typeof q.tuner === 'object' ? q.tuner as Record<string, unknown> : null;
  const history: Record<string, number> = {};
  if (b?.history && typeof b.history === 'object') {
    for (const [k, v] of Object.entries(b.history as Record<string, unknown>).slice(0, 20)) { const n = num(v); if (n !== null && /^[a-z0-9-]{1,40}$/.test(k)) history[k] = n; }
  }
  return {
    id, label: QUEUE_LABELS[id], machineId,
    verdict, rawVerdict, verdictReason: str(q.verdictReason, 40),
    inflowPerDay: num(q.inflowPerDay), outflowPerDay: num(q.outflowPerDay), exitedPerDay: num(q.exitedPerDay),
    open: num(q.open), daysToClear: num(q.daysToClear),
    bottleneck: b && typeof b.kind === 'string' && KINDS.has(b.kind) ? {
      kind: b.kind,
      matched: Array.isArray(b.matched) ? b.matched.filter((k): k is string => typeof k === 'string' && KINDS.has(k)).slice(0, 5) : [],
      detail: PEER_DETAIL[b.kind] ?? '', count: num(b.count), history,
      ...(Array.isArray(b.prs) ? { prs: b.prs.filter((n): n is number => Number.isSafeInteger(n) && (n as number) > 0).slice(0, 50) } : {}),
      ...(typeof b.approverLatched === 'boolean' ? { approverLatched: b.approverLatched } : {}),
      ...(typeof b.repo === 'string' && REPO_RE.test(b.repo) ? { repo: b.repo } : {}),
    } : null,
    coverage: {
      ratio: num(c.ratio, 1) ?? 0, okSlots: num(c.okSlots) ?? 0, slots: num(c.slots) ?? 0, last3Ok: c.last3Ok === true,
      window: str(c.window, 16) ?? '', full: c.full === true, incompleteSlots: num(c.incompleteSlots) ?? 0,
    },
    tuner: t ? { state: str(t.state, 40) ?? 'unknown', extraRunsToday: num(t.extraRunsToday, 1000) ?? 0, cooldownUntil: num(t.cooldownUntil, 1e15) } : null,
    owner: q.owner === 'serving' || q.owner === 'not-serving' ? q.owner : 'this-machine',
    lastIntervalTo: num(q.lastIntervalTo, 1e15), ok: q.ok === true, lastReason: str(q.lastReason, 40),
    context: null, gapRecovered: null,
  };
}

export function createQueuePaceRoutes(ctx: PaceCtx, timings: { peerTimeoutMs?: number; fanOutDeadlineMs?: number } = {}): Router {
  const PEER_TIMEOUT_MS = timings.peerTimeoutMs ?? 1_500;
  const FAN_OUT_DEADLINE_MS = timings.fanOutDeadlineMs ?? 3_000;
  const router = Router();
  const poolBuilds: number[] = [];

  router.get('/queue-pace', async (req: Request, res: Response) => {
    if (!isQueuePaceEnabled(ctx.config)) {
      res.status(503).json({ error: 'queue pace is not switched on for this agent (queuePace.enabled)' });
      return;
    }
    const ledger = ctx.queuePace();
    if (!ledger) { res.status(503).json({ error: 'queue pace ledger is not running on this machine' }); return; }
    const local = ledger.view();
    const self = { machineId: local.machineId, machine: nicknameOf(ctx, ctx.meshSelfId ?? local.machineId) };
    const withMachine = (q: QueuePaceQueueView, machine: string) => ({ ...q, machine });
    if (req.query.scope !== 'pool') {
      res.json({ schema: QUEUE_PACE_SCHEMA, scope: 'local', ...self, generatedAt: local.generatedAt,
        queues: local.queues.map((q) => withMachine(q, self.machine)), context: local.context, sources: [] });
      return;
    }
    const now = Date.now();
    while (poolBuilds.length && poolBuilds[0] <= now - 60_000) poolBuilds.shift();
    if (poolBuilds.length >= 12) { res.status(429).json({ error: 'rate-limited' }); return; }
    poolBuilds.push(now);

    const queues: Array<QueuePaceQueueView & { machine: string }> = local.queues.map((q) => withMachine(q, self.machine));
    const sources: Array<{ machine: string; machineId: string; ok: boolean; reason?: string }> = [{ machine: self.machine, machineId: self.machineId, ok: true }];
    let reportsPerDay = local.context.feedbackReportsPerDay;
    const peers = (ctx.resolvePeerUrls?.() ?? []).slice(0, 16);
    const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
    const started = Date.now();
    for (let i = 0; i < peers.length; i += 4) {
      await Promise.all(peers.slice(i, i + 4).map(async (p) => {
        const machine = nicknameOf(ctx, p.machineId);
        const fail = (reason: string) => { sources.push({ machine, machineId: p.machineId, ok: false, reason }); };
        if (Date.now() - started > FAN_OUT_DEADLINE_MS) return fail('deadline');
        if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: p.kind }, allow).ok) return fail('omitted-cap');
        try {
          const r = await poolPeerFetch(ctx.recordRopeResult ?? undefined, p, '/queue-pace?scope=local', {
            headers: { Authorization: `Bearer ${ctx.config.authToken}` }, signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
          });
          if (r.status === 503 || r.status === 404) return fail(r.status === 503 ? 'off' : 'unsupported');
          if (!r.ok) return fail('http-error');
          const text = await r.text();
          if (Buffer.byteLength(text) > MAX_PEER_BYTES) return fail('too-large');
          const body = JSON.parse(text) as Record<string, unknown>;
          if (body.schema !== QUEUE_PACE_SCHEMA || !Array.isArray(body.queues)) return fail('invalid-body');
          for (const raw of body.queues.slice(0, QUEUE_IDS.length)) {
            const q = sanitizePeerQueue(raw, p.machineId);
            if (q) queues.push(withMachine(q, machine));
          }
          const ctxBody = body.context as Record<string, unknown> | undefined;
          if (reportsPerDay === null && typeof ctxBody?.feedbackReportsPerDay === 'number') reportsPerDay = num(ctxBody.feedbackReportsPerDay);
          sources.push({ machine, machineId: p.machineId, ok: true });
        } catch (err) { // @silent-fallback-ok — the failure is a visible sources[] row naming the machine
          fail(err instanceof Error && err.name === 'TimeoutError' ? 'deadline' : 'unreachable');
        }
      }));
    }
    res.json({ schema: QUEUE_PACE_SCHEMA, scope: 'pool', ...self, generatedAt: now, queues, context: { feedbackReportsPerDay: reportsPerDay }, sources });
  });

  return router;
}
