/**
 * GET /quota-pacing over the full HTTP pipeline (docs/specs/quota-pacing-forecast.md §3): seeded
 * history returns the verdicts; 503 quota-pacing-off when the switch resolves off; ?scope=local
 * returns summaries only (no raw rows); the pool fan-out names a peer that is down and drops a
 * peer's invalid summaries with a count; two machines disagreeing gives unknown; a bad or
 * unknown ?account= id is 404 with no file read.
 */
import { buildQuotaForecast } from '../../dashboard/console/quota-forecast-model.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuotaPacingRoutes } from '../../src/server/quotaPacingRoutes.js';
import { QuotaHistoryLedger } from '../../src/monitoring/QuotaHistoryLedger.js';
import { HOUR_MS, identityKey, type HistoryRow } from '../../src/monitoring/quotaPacing.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = Date.parse('2026-11-17T18:38:00Z');
const RESET = Date.parse('2026-11-18T06:38:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const servers: http.Server[] = [];
let dir: string;
let pool: SubscriptionPool;

/** The 11-17 replay rows (see the unit test): 43% flat since ~02Z, about 0.32 %/h over 24 h. */
function replayRows(identity: string): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const add = (t: number, pct: number) => rows.push({ v: 1, polledAt: iso(t), measuredAt: iso(t), identity, source: 'codex-app-server', drifted: false, windows: { sevenDay: { pct, resetsAt: iso(RESET) } } });
  const cycleStart = RESET - 168 * HOUR_MS;
  const h0 = NOW - 24 * HOUR_MS;
  for (let t = cycleStart + HOUR_MS; t < h0; t += HOUR_MS) add(t, Math.round(30 + 5 * ((t - cycleStart) / (h0 - cycleStart))));
  for (let t = h0; t <= NOW; t += 15 * 60_000) {
    const x = (t - h0) / HOUR_MS;
    add(t, Math.round(x < 3 ? 35 : x < 7.37 ? 35 + 8 * ((x - 3) / 4.37) : 43));
  }
  return rows;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'qpace-route-'));
  pool = new SubscriptionPool({ stateDir: dir });
  pool.addFixture({ id: 'codex-justin-gmail', nickname: 'headley', email: 'headley@example.test', provider: 'openai', framework: 'codex-cli', configHome: '/x/.codex' });
  const histDir = path.join(dir, 'state', 'quota-history');
  fs.mkdirSync(histDir, { recursive: true });
  const id = identityKey('openai', 'headley@example.test')!;
  fs.writeFileSync(path.join(histDir, 'codex-justin-gmail.jsonl'), replayRows(id).map((r) => JSON.stringify(r)).join('\n') + '\n');
});
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.restoreAllMocks();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/quota-pacing-routes.test.ts:cleanup' });
});

function ledger(config: Record<string, unknown>) {
  return new QuotaHistoryLedger({ stateDir: dir, logsDir: path.join(dir, 'logs'), machineId: 'm_self', pool, enabled: () => (config.developmentAgent as boolean) === true, now: () => NOW });
}
function app(config: Record<string, unknown>, l: QuotaHistoryLedger | null, peers: Array<{ machineId: string; url: string; kind: 'lan' }> = []) {
  const ctx = {
    config: { stateDir: dir, authToken: 'tok', ...config },
    meshSelfId: 'm_self',
    machinePoolRegistry: { getCapacity: (id: string) => ({ nickname: id === 'm_self' ? 'Studio' : id }) },
    resolvePeerUrls: () => peers,
    recordRopeResult: null,
    subscriptionPool: pool,
    quotaPacing: () => l,
    now: () => NOW,
  } as never;
  return express().use(createQuotaPacingRoutes(ctx, { peerTimeoutMs: 10_000, fanOutDeadlineMs: 20_000 }));
}
async function peer(handler: express.RequestHandler): Promise<string> {
  const a = express().get('/quota-pacing', handler);
  const s = http.createServer(a);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

describe('GET /quota-pacing', () => {
  it('503 quota-pacing-off when the switch resolves off (fleet agent, key absent)', async () => {
    const res = await request(app({ developmentAgent: false }, ledger({ developmentAgent: false }))).get('/quota-pacing');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('quota-pacing-off');
  });

  it('503 when an operator wrote an explicit false, even on a development agent', async () => {
    const cfg = { developmentAgent: true, subscriptionPool: { pacing: { enabled: false } } };
    const res = await request(app(cfg, ledger(cfg))).get('/quota-pacing');
    expect(res.status).toBe(503);
  });

  it('seeded history returns the verdicts: the 11-17 replay is will-leave-unused, led by the pool', async () => {
    const res = await request(app({ developmentAgent: true }, ledger({ developmentAgent: true }))).get('/quota-pacing');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: 'quota-pacing/1', scope: 'pool' });
    const codex = res.body.providers.find((p: { provider: string }) => p.provider === 'openai');
    expect(codex.basis).toBe('weekly window only');
    expect(codex.plain).toMatch(/^1 of 1 Codex accounts have room/);
    expect(['sustainable', 'tight']).toContain(codex.verdict);
    const acct = codex.accounts[0];
    expect(acct.accountId).toBe('codex-justin-gmail');
    expect(acct.weekly.verdict).toBe('will-leave-unused');
    expect(acct.weekly.display.central).toBe(47);
    const page = buildQuotaForecast({ ok: true, data: res.body }, [{ id: 'codex-justin-gmail', name: 'Justin Gmail' }], NOW);
    expect(page.state).toBe('ready');
    expect(page.providers[0].accounts[0].name).toBe('Justin Gmail');
    expect(page.providers[0].accounts[0].lines.join(' ')).toContain('47%');
    expect(page.calibration).toContain('No forecasts have been checked');
    expect(JSON.stringify(res.body)).not.toContain('headley@example.test');
    expect(res.body.sources).toEqual([{ machineId: 'm_self', machine: 'Studio', status: 'ok' }]);
    expect(res.body.coverage.accounts['codex-justin-gmail'].rows).toBeGreaterThan(100);
  });

  it('?scope=local returns this machine\'s summaries only, never raw rows', async () => {
    const res = await request(app({ developmentAgent: true }, ledger({ developmentAgent: true }))).get('/quota-pacing?scope=local');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('local');
    expect(res.body.logins).toHaveLength(1);
    expect(res.body.logins[0]).toMatchObject({ accountId: 'codex-justin-gmail', machineId: 'm_self', fresh: true });
    expect(res.body.rows).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('"polledAt"');
    expect(Buffer.byteLength(JSON.stringify(res.body.logins[0]))).toBeLessThan(4096);
  });

  it('?scope=local on an agent with peers says cannot-tell for the provider', async () => {
    const res = await request(app({ developmentAgent: true }, ledger({ developmentAgent: true }), [{ machineId: 'm_x', url: 'http://127.0.0.1:9', kind: 'lan' }])).get('/quota-pacing?scope=local');
    expect(res.body.providers[0]).toMatchObject({ verdict: 'cannot-tell', reason: "only this machine's readings" });
  });

  it('pool fan-out: a peer that is down is named; a peer with invalid summaries is dropped and counted', async () => {
    const down = await peer((_req, res) => { res.json({}); });
    servers[servers.length - 1].close();
    const junk = await peer((_req, res) => {
      res.json({ schema: 'quota-pacing/1', scope: 'local', logins: [
        { accountId: '../../etc/passwd', identity: null },
        { accountId: 'x', identity: null, provider: 'openai', framework: 'codex-cli', status: 'active', readIntervalMs: 900000, newestMeasuredAt: null, newestPolledAt: null, staleReason: null, sevenDay: { used: 250 } },
      ] });
    });
    const res = await request(app({ developmentAgent: true }, ledger({ developmentAgent: true }), [
      { machineId: 'm_down', url: down, kind: 'lan' },
      { machineId: 'm_junk', url: junk, kind: 'lan' },
    ])).get('/quota-pacing');
    expect(res.status).toBe(200);
    expect(res.body.couldNotRead).toHaveLength(1);
    expect(res.body.couldNotRead[0]).toMatchObject({ machineId: 'm_down', reason: 'unreachable' });
    expect(res.body.sources.find((s: { machineId: string }) => s.machineId === 'm_junk')).toMatchObject({ status: 'ok' });
    expect(res.body.coverage.malformedSummaries).toEqual([{ machineId: 'm_junk', count: 2 }]);
    // this machine's accounts are still forecast
    expect(res.body.providers[0].accounts[0].weekly.verdict).toBe('will-leave-unused');
  });

  it('a peer answering the wrong schema is invalid-body; a peer that is off says off', async () => {
    const wrong = await peer((_req, res) => { res.json({ schema: 'queue-pace/1', queues: [] }); });
    const off = await peer((_req, res) => { res.status(503).json({ error: 'quota-pacing-off' }); });
    const res = await request(app({ developmentAgent: true }, ledger({ developmentAgent: true }), [
      { machineId: 'm_wrong', url: wrong, kind: 'lan' }, { machineId: 'm_off', url: off, kind: 'lan' },
    ])).get('/quota-pacing');
    const reasons = Object.fromEntries(res.body.couldNotRead.map((c: { machineId: string; reason: string }) => [c.machineId, c.reason]));
    expect(reasons).toEqual({ m_wrong: 'invalid-body', m_off: 'off' });
  });

  it('two machines disagreeing about the same login gives unknown, never an average', async () => {
    const l = ledger({ developmentAgent: true });
    const local = await request(app({ developmentAgent: true }, l)).get('/quota-pacing?scope=local');
    const theirs = JSON.parse(JSON.stringify(local.body.logins[0]));
    theirs.accountId = 'codex-headley-alias';
    theirs.sevenDay.used = 60; // 17 points apart, measured at the same moment
    const other = await peer((_req, res) => { res.json({ schema: 'quota-pacing/1', scope: 'local', logins: [theirs] }); });
    const res = await request(app({ developmentAgent: true }, l, [{ machineId: 'm_peer', url: other, kind: 'lan' }])).get('/quota-pacing');
    const accounts = res.body.providers[0].accounts;
    expect(accounts).toHaveLength(1); // one login, counted once
    expect(accounts[0].disagree).toBe(true);
    expect(accounts[0].weekly).toMatchObject({ verdict: 'unknown', reason: 'machines-disagree' });
  });

  it('?account=ID&history=1 returns this machine\'s rows with their resolution', async () => {
    const res = await request(app({ developmentAgent: true }, ledger({ developmentAgent: true }))).get('/quota-pacing?account=codex-justin-gmail&history=1');
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(100);
    expect(res.body.rows.every((r: { resolution: string }) => r.resolution === 'full')).toBe(true);
  });

  it('a bad or unknown ?account= id is 404 with no file read', async () => {
    const l = ledger({ developmentAgent: true });
    const rowsSpy = vi.spyOn(l, 'rows');
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    // a retired history file for an id no longer in the pool must not be served either
    fs.mkdirSync(path.join(dir, 'state', 'quota-history', 'retired'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'quota-history', 'retired', 'gone.jsonl'), '{}\n');
    const a = app({ developmentAgent: true }, l);
    for (const id of ['../../etc/passwd', 'UPPER', 'gone', 'not-enrolled', '']) {
      const res = await request(a).get(`/quota-pacing?account=${encodeURIComponent(id)}&history=1`);
      expect(res.status).toBe(404);
    }
    expect(rowsSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });
});
