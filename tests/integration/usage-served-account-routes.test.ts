/**
 * quota-pacing step 3 (docs/specs/quota-pacing-spend-by-account.md §3): the served-account
 * routes over the real HTTP pipeline — holder and proxied standby, pool fan-out with one peer
 * that answers, one that is down and one on an older build, the existing reads unchanged, and
 * 503 when the switch is off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { UsageLedger, encodeClaudeProjectDir } from '../../src/monitoring/UsageLedger.js';
import { IdentityCheckLog } from '../../src/monitoring/IdentityCheckLog.js';
import { ServedAccountResolver } from '../../src/monitoring/servedAccount.js';
import { ServedSwitchHistory } from '../../src/monitoring/servedAccountReport.js';
import { identityKey } from '../../src/monitoring/quotaPacing.js';
import { mountUsageRoutes, type UsageRouteDeps } from '../../src/server/usageRoutes.js';

const dirs: string[] = [];
const ledgers: UsageLedger[] = [];
const servers: Server[] = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-served-routes-')); dirs.push(d); return d; };
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  for (const l of ledgers.splice(0)) l.close();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/usage-served-account-routes.test.ts' });
});

const ID_A = identityKey('anthropic', 'a@example.com')!;

function machine(machineId: string, opts: { enabled?: boolean; holder?: boolean; peers?: () => Array<{ machineId: string; url: string }>; fromHolder?: UsageRouteDeps['fromHolder'] } = {}) {
  const home = temp(), slotA = temp(), state = temp();
  const accounts = [{ id: 'claude-a', framework: 'claude-code', configHome: slotA, provider: 'anthropic', email: 'a@example.com' }];
  const checks = new IdentityCheckLog({ stateDir: state, now: () => Date.now() - 60_000 });
  checks.record(slotA, { result: 'confirmed', identity: ID_A });
  const resolver = new ServedAccountResolver({ pool: () => accounts, checks });
  const enabled = () => opts.enabled ?? true;
  const ledger = new UsageLedger({ dbPath: ':memory:', machineId, agentId: 'agent', agentHomes: [home],
    poolHomes: () => accounts.map(a => ({ framework: a.framework, configHome: a.configHome })),
    servedAccount: { enabled, resolver } });
  ledgers.push(ledger);
  const switchHistory = new ServedSwitchHistory(state, () => Date.now() - 86_400_000);
  switchHistory.note(enabled());
  const app = express();
  const deps: UsageRouteDeps = {
    ledger, prices: null, puller: null, isHolder: () => opts.holder ?? true,
    fromHolder: opts.fromHolder ?? (async () => null), fromPeer: async () => null, bearerOk: () => true,
    servedAccount: {
      enabled, switchHistory,
      fanOut: { config: { authToken: 't', multiMachine: {} } as never, resolvePeerUrls: (opts.peers ?? (() => [])) as never, recordRopeResult: undefined },
      history: () => null, poolAccounts: () => accounts,
    },
  };
  mountUsageRoutes(app, () => deps);
  return { app, ledger, home, slotA };
}

function transcript(slot: string, cwd: string, sessionId: string, requestId: string): void {
  const dir = path.join(slot, 'projects', encodeClaudeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({
    type: 'assistant', requestId, sessionId, cwd, timestamp: new Date(Date.now() + 1000).toISOString(),
    message: { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 20 } },
  }) + '\n');
}

async function listen(app: express.Express): Promise<string> {
  const s = app.listen(0, '127.0.0.1');
  servers.push(s);
  await new Promise<void>(r => s.once('listening', () => r()));
  const addr = s.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

describe('served-account routes', () => {
  it('merges a login across the holder and a peer, and names a down peer and an older-build peer', async () => {
    const peer = machine('m_peer');
    peer.ledger.recordBinding({ sessionId: 'p1', framework: 'claude-code', sessionKind: 'interactive', cwd: peer.home, topicId: null, jobSlug: null, runId: null, accountId: 'claude-tagged', validFrom: Date.now() - 60_000 });
    transcript(peer.slotA, peer.home, 'p1', 'rq-p');
    await peer.ledger.scanTickAsync();
    const peerUrl = await listen(peer.app);
    const oldBuild = express(); // no served-account routes: answers 404
    const oldUrl = await listen(oldBuild);
    const holder = machine('m_holder', { peers: () => [
      { machineId: 'm_peer', url: peerUrl }, { machineId: 'm_old', url: oldUrl }, { machineId: 'm_down', url: 'http://127.0.0.1:9' },
    ] });
    transcript(holder.slotA, holder.home, 'h1', 'rq-h');
    await holder.ledger.scanTickAsync();

    const res = await request(holder.app).get('/usage/accounts');
    expect(res.status).toBe(200);
    expect(res.body.logins).toHaveLength(1);
    expect(res.body.logins[0]).toMatchObject({ identity: ID_A, accounts: ['claude-a'] });
    expect(res.body.logins[0].total.calls).toBe(2);
    const reasons = Object.fromEntries((res.body.notAnswered as Array<{ machineId: string; reason: string }>).map(n => [n.machineId, n.reason]));
    expect(reasons.m_old).toBe('served-account-unsupported');
    expect(reasons.m_down).toBeDefined();

    const mm = await request(holder.app).get('/usage/account-mismatches?limit=50');
    expect(mm.status).toBe(200);
    expect(mm.body.rows).toHaveLength(1);
    expect(mm.body.rows[0]).toMatchObject({ machineId: 'm_peer', sessionId: 'p1', tagged: 'claude-tagged', served: 'claude-a', confirmed: true });

    // The existing reads are unchanged by the new routes.
    expect((await request(holder.app).get('/usage/tree?by=account')).status).toBe(400);
    expect((await request(holder.app).get('/usage/summary')).status).toBe(200);
  });

  it('a standby proxies pool reads to the holder; scope=local always answers locally', async () => {
    const standby = machine('m_standby', { holder: false, fromHolder: async () => ({ status: 200, body: { proxied: true } }) });
    expect((await request(standby.app).get('/usage/accounts')).body).toEqual({ proxied: true });
    const local = await request(standby.app).get('/usage/accounts?scope=local');
    expect(local.body).toMatchObject({ schema: 'usage-accounts/1', machineId: 'm_standby' });
  });

  it('answers 503 served-account-off on every served-account route when the switch is off', async () => {
    const off = machine('m_off', { enabled: false });
    for (const p of ['/usage/accounts', '/usage/accounts/size?account=claude-a', '/usage/account-mismatches', '/usage/accounts/spend?account=claude-a&intervals=1-2']) {
      const r = await request(off.app).get(p);
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('served-account-off');
    }
  });

  it('refuses bad queries plainly and reports size as cannot-tell without reading history', async () => {
    const m = machine('m_q');
    expect((await request(m.app).get('/usage/account-mismatches?limit=0')).status).toBe(400);
    expect((await request(m.app).get('/usage/accounts/size?account=BAD!')).status).toBe(400);
    expect((await request(m.app).get('/usage/accounts/size?account=nobody')).status).toBe(404);
    const size = await request(m.app).get('/usage/accounts/size?account=claude-a');
    expect(size.body).toMatchObject({ account: 'claude-a', state: 'cannot-tell' });
  });
});
