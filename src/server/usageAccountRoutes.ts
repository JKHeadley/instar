/**
 * Spend by served account (docs/specs/quota-pacing-spend-by-account.md §2-§4).
 *
 *   GET /usage/accounts?since=&until=             per login (by step 1's identity key) and the
 *                                                  unidentified buckets, pool-wide
 *   GET /usage/accounts/size?account=&window=      size of a point for the account's closed cycles
 *   GET /usage/account-mismatches?since=&limit=&cursor=   tagged vs served disagreements, paged
 *
 * Pool views are answered by the lease holder (a standby proxies, like the other /usage/*
 * routes), which fans out to every machine at request time over raw rows (`?scope=local`
 * on each peer). A machine that does not answer is named; a 404 from a peer is
 * `served-account-unsupported` (older build), a 503 `served-account-off`.
 * Bearer only, never on any phone allowlist. 503 `served-account-off` when the switch is off.
 */
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import type { Router, Request, Response } from 'express';
import type { UsageRouteDeps } from './usageRoutes.js';
import { poolFanOut, type FanOutCtx, type PoolPeer } from './poolFanOut.js';
import {
  localAccountsReport, mergeAccountsReports, localIntervalSpend, closedCycles, sizeOfPoint, switchOnSince,
  mergeMismatchPages, decodeCursor, MISMATCH_PAGE, SIZE_LIMITS,
  type LocalAccountsReport, type IntervalSpend, type MismatchRow, type ServedSwitchHistory, type Interval,
} from '../monitoring/servedAccountReport.js';
import { parseSince, UsageQueryError } from '../monitoring/usageReadModel.js';
import { identityKey, ACCOUNT_ID_RE, type ForecastWindowKey } from '../monitoring/quotaPacing.js';
import type { QuotaHistoryLedger } from '../monitoring/QuotaHistoryLedger.js';

export interface ServedAccountRouteDeps {
  enabled: () => boolean;
  switchHistory: ServedSwitchHistory;
  fanOut: FanOutCtx | null;
  history: () => QuotaHistoryLedger | null;
  poolAccounts: () => ReadonlyArray<{ id: string; framework: string; provider: string; email?: string | null }>;
}

const OFF = { error: 'served-account-off', detail: 'Spend by served account is turned off on this machine.' };
const PROXY_HEADER = 'x-usage-proxied';
const DAY_MS = 86_400_000;
const PEER_TIMEOUT_MS = 8_000;
const DEADLINE_MS = 20_000;
/** A 500-row mismatch page is about 150 KB; a 30-day accounts report a few KB. */
const MAX_PEER_BYTES = 1024 * 1024;

const peerReason = (reason: string | undefined): string =>
  reason === 'unsupported' ? 'served-account-unsupported' : reason === 'off' ? 'served-account-off' : reason ?? 'unreachable';

/** Rows a few minutes ahead of this clock (another machine's clock, a transcript stamped late) still count. */
const CLOCK_SKEW_MS = 5 * 60_000;

function parseUntil(raw: unknown, now: number): number {
  if (typeof raw !== 'string' || !raw.trim()) return now + CLOCK_SKEW_MS;
  const n = Number(raw);
  const ms = Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : Date.parse(raw);
  if (!Number.isFinite(ms)) throw new UsageQueryError('until must be an ISO date or a Unix time');
  return Math.min(ms, now + CLOCK_SKEW_MS);
}

function parseIntervals(raw: unknown): Interval[] {
  if (typeof raw !== 'string' || !raw) throw new UsageQueryError('intervals must be start-end pairs in milliseconds, comma separated');
  const out: Interval[] = [];
  for (const part of raw.split(',').slice(0, 64)) {
    const [a, b] = part.split('-').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new UsageQueryError('intervals must be start-end pairs in milliseconds, comma separated');
    out.push({ start: a, end: b });
  }
  return out;
}

export function mountUsageAccountRoutes(router: Router, get: () => UsageRouteDeps | null): void {
  const deps = (res: Response): { d: UsageRouteDeps; s: ServedAccountRouteDeps } | null => {
    res.set('Cache-Control', 'no-store');
    const d = get();
    const s = d?.servedAccount ?? null;
    if (!d || !s || !s.enabled()) { res.status(503).json(OFF); return null; }
    return { d, s };
  };
  const now = (d: UsageRouteDeps) => (d.now ? d.now() : Date.now());
  const fail = (res: Response, name: string, err: unknown) => {
    if (err instanceof UsageQueryError) { res.status(400).json({ error: 'bad-query', detail: err.userText }); return; }
    console.warn(`[usage] GET ${name} failed:`, err);
    res.status(500).json({ error: 'usage-read-failed' });
  };

  /** A standby forwards pool reads to the holder; returns true when it answered. */
  const viaHolder = async (d: UsageRouteDeps, req: Request, res: Response): Promise<boolean> => {
    if (req.query.scope === 'local' || d.isHolder() || req.headers[PROXY_HEADER] === '1') return false;
    const r = await d.fromHolder(req.originalUrl).catch(() => { /* @silent-fallback-ok: holder unreachable, so answer from this machine's own data */ return null; });
    if (r && r.status < 500) { res.status(r.status).json(r.body); return true; }
    return false;
  };

  const fanOut = async <T>(s: ServedAccountRouteDeps, path: string, accept: (body: Record<string, unknown>, peer: PoolPeer) => T | null): Promise<{ got: T[]; notAnswered: Array<{ machineId: string; reason: string }> }> => {
    const got: T[] = [];
    const notAnswered: Array<{ machineId: string; reason: string }> = [];
    if (!s.fanOut) return { got, notAnswered };
    await poolFanOut(s.fanOut, {
      path, peerTimeoutMs: PEER_TIMEOUT_MS, fanOutDeadlineMs: DEADLINE_MS, maxBytes: MAX_PEER_BYTES,
      accept: (body, peer) => { const v = accept(body, peer); if (v === null) return 'invalid-body'; got.push(v); return null; },
      onResult: (peer, ok, reason) => { if (!ok) notAnswered.push({ machineId: peer.machineId, reason: peerReason(reason) }); },
    });
    return { got, notAnswered };
  };

  router.get('/usage/accounts', async (req, res) => {
    const x = deps(res); if (!x) return;
    const { d, s } = x;
    try {
      if (await viaHolder(d, req, res)) return;
      const t = now(d);
      const history = s.switchHistory.list();
      const defaultSince = switchOnSince(history) ?? t - 7 * DAY_MS;
      const sinceMs = req.query.since ? parseSince(req.query.since, t, 90 * DAY_MS, 7 * DAY_MS).sinceMs : Math.max(defaultSince, t - 90 * DAY_MS);
      const untilMs = parseUntil(req.query.until, t);
      const local = localAccountsReport(d.ledger, d.prices, { sinceMs, untilMs, switchHistory: history });
      if (req.query.scope === 'local') { res.json(local); return; }
      const { got, notAnswered } = await fanOut<LocalAccountsReport>(s, `/usage/accounts?scope=local&since=${sinceMs}&until=${untilMs}`,
        (body) => (body.schema === 'usage-accounts/1' && Array.isArray(body.logins) && Array.isArray(body.unidentified) ? body as unknown as LocalAccountsReport : null));
      const merged = mergeAccountsReports([local, ...got]);
      res.json({
        schema: 'usage-accounts/1', scope: 'pool', since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(),
        pricing: 'list-equivalent, as of each UTC day',
        ...merged,
        machines: [local, ...got].map(r => ({ machineId: r.machineId, oldestRawTs: r.oldestRawTs, switchOnSince: switchOnSince(r.switchHistory) })),
        notAnswered,
        note: 'Grouped by the login that served each request. Unidentified spend is shown apart and never folded into a login.',
      });
    } catch (err) { fail(res, '/usage/accounts', err); }
  });

  // One machine's interval spend for one login (the size-of-a-point fan-out target).
  router.get('/usage/accounts/spend', (req, res) => {
    const x = deps(res); if (!x) return;
    const { d, s } = x;
    try {
      const account = typeof req.query.account === 'string' && ACCOUNT_ID_RE.test(req.query.account) ? req.query.account : null;
      if (!account) throw new UsageQueryError('account must be a pool account id');
      const identity = typeof req.query.identity === 'string' && /^[a-z]+:[0-9a-f]{16}$/.test(req.query.identity) ? req.query.identity : null;
      res.json({ schema: 'usage-interval-spend/1', ...localIntervalSpend(d.ledger, d.prices, {
        identity, accountId: account, intervals: parseIntervals(req.query.intervals), fableOnly: req.query.fable === '1', switchHistory: s.switchHistory.list(),
      }) });
    } catch (err) { fail(res, '/usage/accounts/spend', err); }
  });

  router.get('/usage/accounts/size', async (req, res) => {
    const x = deps(res); if (!x) return;
    const { d, s } = x;
    try {
      if (await viaHolder(d, req, res)) return;
      const account = typeof req.query.account === 'string' && ACCOUNT_ID_RE.test(req.query.account) ? req.query.account : null;
      if (!account) throw new UsageQueryError('account must be a pool account id');
      const acct = s.poolAccounts().find(a => a.id === account);
      if (!acct) { res.status(404).json({ error: 'unknown-account', detail: 'No pool account has that id.' }); return; }
      const ledger = s.history();
      if (!ledger) { res.json({ account, state: 'cannot-tell', reason: 'no reading history on this machine (quota pacing is off)' }); return; }
      const rows = await ledger.rows(account);
      if (!rows || rows.length === 0) { res.json({ account, state: 'cannot-tell', reason: 'no readings recorded for this account' }); return; }
      const identity = identityKey(acct.provider, acct.email ?? null);
      const t = now(d);
      const windows: ForecastWindowKey[] = acct.framework === CLAUDE_CODE_FRAMEWORK ? ['sevenDay', 'fable'] : ['sevenDay'];
      const requested = req.query.window === 'fable' || req.query.window === 'sevenDay' ? [req.query.window as ForecastWindowKey] : windows;
      const out = [];
      for (const w of requested) {
        const cycles = closedCycles(rows.filter(r => (r.identity ?? null) === identity), w, t)
          .filter(c => t - c.startedAt <= SIZE_LIMITS.FULL_DETAIL_MS + 7 * DAY_MS)
          .slice(-2);
        for (const c of cycles) {
          const intervals = c.segments.map(sg => `${sg.start}-${sg.end}`).join(',');
          const fable = w === 'fable';
          const local = localIntervalSpend(d.ledger, d.prices, { identity, accountId: account, intervals: c.segments, fableOnly: fable, switchHistory: s.switchHistory.list() });
          let parts: IntervalSpend[] = [local];
          let notAnswered: string[] = [];
          if (intervals) {
            const q = `/usage/accounts/spend?account=${encodeURIComponent(account)}${identity ? `&identity=${encodeURIComponent(identity)}` : ''}&intervals=${intervals}${fable ? '&fable=1' : ''}`;
            const r = await fanOut<IntervalSpend>(s, q, (body) => (body.schema === 'usage-interval-spend/1' ? body as unknown as IntervalSpend : null));
            parts = [local, ...r.got];
            notAnswered = r.notAnswered.map(n => `${n.machineId} (${n.reason})`);
          }
          out.push(sizeOfPoint(c, parts, { now: t, machinesNotAnswered: notAnswered, codex: acct.framework !== CLAUDE_CODE_FRAMEWORK }));
        }
      }
      res.json({ schema: 'usage-account-size/1', account, identity, cycles: out, note: out.length === 0 ? 'No closed cycle inside the reading history yet.' : undefined });
    } catch (err) { fail(res, '/usage/accounts/size', err); }
  });

  router.get('/usage/account-mismatches', async (req, res) => {
    const x = deps(res); if (!x) return;
    const { d, s } = x;
    try {
      if (await viaHolder(d, req, res)) return;
      const t = now(d);
      const sinceMs = parseSince(req.query.since, t, 90 * DAY_MS, 7 * DAY_MS).sinceMs;
      const rawLimit = Number(req.query.limit ?? MISMATCH_PAGE.DEFAULT);
      if (!Number.isInteger(rawLimit) || rawLimit < 1) throw new UsageQueryError(`limit must be a whole number from 1 to ${MISMATCH_PAGE.MAX}`);
      const limit = Math.min(rawLimit, MISMATCH_PAGE.MAX);
      if (req.query.scope === 'local') {
        const after = typeof req.query.after === 'string' && /^\d+:[\w.:-]{1,128}$/.test(req.query.after)
          ? { lastTs: Number(req.query.after.split(':')[0]), sessionId: req.query.after.slice(req.query.after.indexOf(':') + 1) } : null;
        const page = d.ledger.accountMismatches(sinceMs, limit, after);
        res.json({ schema: 'usage-mismatches/1', machineId: d.ledger.machineId, total: page.total, rows: page.rows, full: page.rows.length === limit });
        return;
      }
      const cursor = decodeCursor(req.query.cursor);
      const selfCur = cursor[d.ledger.machineId] ?? null;
      const selfPage = d.ledger.accountMismatches(sinceMs, limit, selfCur);
      const pages: Array<{ machineId: string; rows: MismatchRow[]; full: boolean; total: number }> = [
        { machineId: d.ledger.machineId, rows: selfPage.rows, full: selfPage.rows.length === limit, total: selfPage.total },
      ];
      const notAnswered: Array<{ machineId: string; reason: string }> = [];
      if (s.fanOut) {
        // Each peer gets its own cursor, so this fans out one machine at a time through the shared helper's limits.
        const peers = (s.fanOut.resolvePeerUrls?.() ?? []);
        for (const p of peers) {
          const c = cursor[p.machineId] ?? null;
          const one: FanOutCtx = { ...s.fanOut, resolvePeerUrls: () => [p] };
          const r = await fanOut<{ machineId: string; rows: MismatchRow[]; full: boolean; total: number }>({ ...s, fanOut: one },
            `/usage/account-mismatches?scope=local&since=${sinceMs}&limit=${limit}${c ? `&after=${c.lastTs}:${encodeURIComponent(c.sessionId)}` : ''}`,
            (body) => (body.schema === 'usage-mismatches/1' && Array.isArray(body.rows) ? { machineId: p.machineId, rows: body.rows as MismatchRow[], full: !!body.full, total: Number(body.total) || 0 } : null));
          pages.push(...r.got);
          notAnswered.push(...r.notAnswered);
        }
      }
      const merged = mergeMismatchPages(pages, cursor, limit);
      res.json({
        schema: 'usage-mismatches/1', scope: 'pool', since: new Date(sinceMs).toISOString(),
        total: pages.reduce((n, p) => n + p.total, 0),
        confirmedOnPage: merged.rows.filter(r => r.confirmed).length,
        rows: merged.rows, next: merged.next, notAnswered,
        note: 'An unconfirmed mismatch (no identity check, Codex today) is counted but never treated as a placement bug on its own.',
      });
    } catch (err) { fail(res, '/usage/account-mismatches', err); }
  });
}
