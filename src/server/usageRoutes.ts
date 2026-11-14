/**
 * Unified usage ledger routes (docs/specs/unified-usage-ledger.md, Slice 4).
 *
 *   GET /usage/summary   agent totals plus per machine, not-reached and warming machines named
 *   GET /usage/tree      nested nodes (≤3 levels, ≤20 children + "other"); sessions only under a parent
 *   GET /usage/series    usage over time split by model / framework / machine
 *   GET /usage/top       top topics / jobs / sessions / features by equivalent cost
 *   GET /usage/coverage  what is and is not measured
 *   GET /usage/events    one session's raw rows, read on the machine that holds them (≤500)
 *   GET /usage/rollup    this machine's replication page (machine-to-machine; never on the phone allowlist)
 *   GET /mobile/usage    owner phone only: trimmed totals, series and top lists by name
 *
 * Bearer auth for every /usage/* route (the router's auth middleware runs first).
 * A standby answers /usage/* by proxying to the lease holder; when the holder cannot be
 * reached it answers from its own rollups, labelled as this machine only.
 * 503 when the dev-gated ledger is off.
 */
import type { Router, Request, Response } from 'express';
import type { UsageLedger } from '../monitoring/UsageLedger.js';
import type { UsagePoolPuller } from '../monitoring/UsagePoolPuller.js';
import type { ListPriceSource } from '../monitoring/usagePricing.js';
import {
  usageSummary, usageSeries, usageTop, usageTree, usageCoverage, trimForPhone, validSessionId,
  UsageQueryError, type ReadContext,
} from '../monitoring/usageReadModel.js';
import { ownerOrBearer } from './mobileCapacityRoutes.js';

export interface UsageRouteDeps {
  ledger: UsageLedger;
  prices: ListPriceSource | null;
  puller: UsagePoolPuller | null;
  /** True on the lease holder, and on a single machine with no pool. */
  isHolder: () => boolean;
  /** Fetch a path from the lease holder (standby proxy). Null when the holder is unknown or unreachable. */
  fromHolder: (pathWithQuery: string) => Promise<{ status: number; body: unknown } | null>;
  /** Fetch a path from a named peer (the owning machine of a session's raw rows). */
  fromPeer: (machineId: string, pathWithQuery: string) => Promise<{ status: number; body: unknown } | null>;
  bearerOk: (req: Request) => boolean;
  now?: () => number;
}

const PROXY_HEADER = 'x-usage-proxied';
const OFF = { error: 'usage-ledger-off', detail: 'The usage ledger is turned off on this machine.' };

export function mountUsageRoutes(router: Router, get: () => UsageRouteDeps | null): void {
  const ctxFor = (d: UsageRouteDeps, scope: ReadContext['scope']): ReadContext => {
    d.puller?.touch();
    const peers = (d.puller?.peerStatus() ?? []).map(p => ({ machineId: p.machineId, state: p.state, lastPullAt: p.lastPullAt, lastError: p.lastError }));
    return { ledger: d.ledger, prices: d.prices, peers: scope === 'pool' ? peers : [], now: d.now ? d.now() : Date.now(), scope };
  };

  /** Serve a read: on the holder locally; on a standby via the holder, else locally labelled this-machine-only. */
  const read = (name: string, build: (ctx: ReadContext, q: Record<string, unknown>) => unknown) => async (req: Request, res: Response) => {
    const d = get();
    res.set('Cache-Control', 'no-store');
    if (!d) { res.status(503).json(OFF); return; }
    try {
      if (!d.isHolder() && req.headers[PROXY_HEADER] !== '1') {
        const proxied = await d.fromHolder(req.originalUrl).catch(() => null);
        if (proxied && proxied.status < 500) { res.status(proxied.status).json(proxied.body); return; }
        res.json({ ...(build(ctxFor(d, 'this-machine-only'), req.query as Record<string, unknown>) as object), holderUnreachable: true });
        return;
      }
      res.json(build(ctxFor(d, d.isHolder() ? 'pool' : 'this-machine-only'), req.query as Record<string, unknown>));
    } catch (err) {
      if (err instanceof UsageQueryError) { res.status(400).json({ error: 'bad-query', detail: err.userText }); return; }
      console.warn(`[usage] GET /usage/${name} failed:`, err);
      res.status(500).json({ error: 'usage-read-failed' });
    }
  };

  router.get('/usage/summary', read('summary', usageSummary));
  router.get('/usage/series', read('series', usageSeries));
  router.get('/usage/top', read('top', usageTop));
  router.get('/usage/tree', read('tree', usageTree));
  router.get('/usage/coverage', read('coverage', (ctx) => usageCoverage(ctx)));

  router.get('/usage/events', async (req, res) => {
    const d = get();
    res.set('Cache-Control', 'no-store');
    if (!d) { res.status(503).json(OFF); return; }
    const session = validSessionId(req.query.session);
    if (!session) { res.status(400).json({ error: 'bad-query', detail: 'session must be 1-128 letters, digits, dots, colons, dashes or underscores' }); return; }
    const owner = d.ledger.sessionOwner(session);
    if (owner === d.ledger.machineId || req.headers[PROXY_HEADER] === '1') {
      res.json({ session, machine: d.ledger.machineId, rows: d.ledger.sessionEvents(session) });
      return;
    }
    if (!owner) {
      // Unknown here: a standby may not hold the pooled bindings — ask the holder.
      if (!d.isHolder()) {
        const viaHolder = await d.fromHolder(req.originalUrl).catch(() => null);
        if (viaHolder) { res.status(viaHolder.status).json(viaHolder.body); return; }
      }
      res.status(404).json({ error: 'unknown-session', detail: 'No machine I can see holds that session.' });
      return;
    }
    const r = await d.fromPeer(owner, `/usage/events?session=${encodeURIComponent(session)}`).catch(() => null);
    if (!r) { res.status(502).json({ error: 'owner-not-reached', detail: 'The machine that holds this session did not answer.', machine: owner }); return; }
    res.status(r.status).json(r.body);
  });

  // Machine-to-machine replication page. Bearer only (never on the phone allowlist).
  router.get('/usage/rollup', (req, res) => {
    const d = get();
    res.set('Cache-Control', 'no-store');
    if (!d) { res.status(503).json(OFF); return; }
    const after = Number(req.query.after ?? 0);
    if (!Number.isInteger(after) || after < 0) { res.status(400).json({ error: 'bad-query', detail: 'after must be a whole number' }); return; }
    res.json(d.ledger.exportPage(after));
  });

  router.get('/mobile/usage', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const d = get();
    if (!d) { res.status(503).json(OFF); return; }
    if (!ownerOrBearer(req, d.bearerOk)) {
      res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can see what thinking costs.' });
      return;
    }
    const window = req.query.window === 'today' ? 1 : req.query.window === 'month' ? 30 : 7;
    const since = String((d.now ? d.now() : Date.now()) - window * 86_400_000);
    try {
      // The receiving machine fetches the bearer answers (from the holder when it is a standby)
      // and trims them here; the holder's untrimmed body is never passed through.
      const fetchOne = async (path: string, local: () => unknown): Promise<any> => {
        if (!d.isHolder()) {
          const r = await d.fromHolder(path).catch(() => null);
          if (r && r.status === 200) return r.body;
        }
        return local();
      };
      const scope = d.isHolder() ? 'pool' : 'this-machine-only';
      const q = { since, grain: 'day' };
      const [summary, series, topic, job, feature] = await Promise.all([
        fetchOne(`/usage/summary?since=${since}&grain=day`, () => usageSummary(ctxFor(d, scope), q)),
        fetchOne(`/usage/series?since=${since}&grain=day&split=model`, () => usageSeries(ctxFor(d, scope), { ...q, split: 'model' })),
        fetchOne(`/usage/top?dim=topic&limit=10&since=${since}`, () => usageTop(ctxFor(d, scope), { dim: 'topic', limit: '10', since })),
        fetchOne(`/usage/top?dim=job&limit=10&since=${since}`, () => usageTop(ctxFor(d, scope), { dim: 'job', limit: '10', since })),
        fetchOne(`/usage/top?dim=feature&limit=10&since=${since}`, () => usageTop(ctxFor(d, scope), { dim: 'feature', limit: '10', since })),
      ]);
      res.json({ schemaVersion: 1, window: window === 1 ? 'today' : window === 30 ? 'month' : 'week', ...trimForPhone(summary, series, { topic, job, feature }) });
    } catch (err) {
      console.warn('[usage] GET /mobile/usage failed:', err);
      res.status(500).json({ error: 'usage-unavailable' });
    }
  });
}

export { PROXY_HEADER as USAGE_PROXY_HEADER };
