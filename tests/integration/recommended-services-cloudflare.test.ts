/**
 * Cloudflare through the routes: a yes starts setup; the session stores the token and host name as one value (a
 * value the sync could not use is refused); the sync does the Cloudflare work, writes this agent's tunnel and asks
 * for a planned restart; the check passes on a public read of the agent at its name; a no with switch-off undoes
 * exactly setup's work when another way in works.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG, type CatalogRow } from '../../src/recommended/catalog.js';
import { readSetupStates } from '../../src/recommended/setupState.js';
import { registerRecommendedServiceRoutes } from '../../src/server/recommendedServiceRoutes.js';
import type { CloudflareApi, CloudflareSurface, TunnelSettings } from '../../src/recommended/cloudflareDomain.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const PROVEN: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'cloudflare-domain')!, setupRecipe: 'cloudflare-v1' };
const BASE = '/recommended-services/cloudflare-domain';
const VALUE = JSON.stringify({ token: 'cf-secret-token', hostname: 'agent.example.com' });

describe('Cloudflare through the routes', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let tunnel: TunnelSettings | null;
  let reach: 'ok' | 'unreachable' | 'unknown';
  let restarts: string[];
  let apiCalls: string[];
  let secrets: Record<string, string>;
  let start: ReturnType<typeof vi.fn>;
  let told: ReturnType<typeof vi.fn>;
  let otherRoute: boolean;

  const api = (): CloudflareApi => ({
    verifyToken: async () => { apiCalls.push('verify'); return 'ok'; },
    zoneFor: async () => { apiCalls.push('zone'); return { id: 'z1', name: 'example.com', accountId: 'acc1' }; },
    tunnelNamed: async () => { apiCalls.push('find'); return null; },
    createTunnel: async () => { apiCalls.push('create'); return { id: 't1', name: 'instar-echo' }; },
    tunnelToken: async () => { apiCalls.push('token'); return 'run-token'; },
    putIngress: async () => { apiCalls.push('ingress'); return true; },
    putDns: async () => { apiCalls.push('dns'); return { id: 'r1', created: true }; },
    deleteDns: async () => { apiCalls.push('deleteDns'); return true; },
    deleteTunnel: async () => { apiCalls.push('deleteTunnel'); return true; },
  });
  const surface = (): CloudflareSurface => ({
    api: api(),
    port: 4040,
    tunnelConfigured: () => tunnel,
    writeNamedTunnel: ({ token, hostname }) => { const prev = tunnel ? { enabled: tunnel.enabled, type: tunnel.type, ...(tunnel.hostname ? { hostname: tunnel.hostname } : {}) } : null; tunnel = { enabled: true, type: 'named', token, hostname }; return prev; },
    restoreTunnel: (previous) => { tunnel = previous ?? { enabled: true, type: 'quick' }; },
    reachable: async () => reach,
    requestRestart: (reason) => { restarts.push(reason); return true; },
  });
  const app = () => {
    const a = express();
    a.use(express.text({ type: 'text/plain' }));
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => '42', catalog: [PROVEN], port: 4040, agentName: 'Echo',
      checkPin: () => true, checkConfirmPin: () => true, recordApproval: () => undefined,
      openCommitment: () => 'CMT-1', finishCommitment: () => undefined, withdrawCommitment: () => undefined,
      startSetup: start, stopSetup: () => true, sessionForTopic: () => null, isSetupRunning: () => false,
      notifyStuck: async () => true, clearStuck: () => undefined, tellOwner: told,
      readSecret: (n) => secrets[n] ?? null, writeSecret: (n, v) => { secrets[n] = v; }, deleteSecret: (n) => { delete secrets[n]; },
      cloudflare: surface(),
      otherRouteWorks: async () => otherRoute,
    });
    a.use(router);
    return a;
  };
  const say = async (a: express.Express, what: 'yes' | 'no', shutdown = false) => {
    const { body } = await request(a).get(`${BASE}/confirm`);
    return request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: what, shutdown });
  };
  const storeKey = (a: express.Express, value: string) => request(a).post(`${BASE}/key`).set('X-Instar-Request', '1').type('text/plain').send(value);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-cf-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    tunnel = { enabled: true, type: 'quick' }; reach = 'unreachable'; restarts = []; apiCalls = []; secrets = {}; otherRoute = true;
    start = vi.fn(async () => ({ sessionName: 's-cf', topicId: 7 }));
    told = vi.fn();
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-cloudflare.test.ts' }));

  it('yes → setup → key stored → sync does the Cloudflare work and restarts → check passes at the name → switch-off undoes it', async () => {
    const a = app();
    expect((await say(a, 'yes')).status).toBe(200);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(readSetupStates(dir)['cloudflare-domain']?.absentBeforeSetup).toBe(true);
    // A bare token, or a host name the recipe can't use, is refused and never stored.
    expect((await storeKey(a, 'cf-secret-token')).status).toBe(400);
    expect((await storeKey(a, JSON.stringify({ token: 'cf-secret-token', hostname: 'Agent.Example.com' }))).status).toBe(400);
    expect(secrets).toEqual({});
    expect((await storeKey(a, VALUE)).body).toEqual({ stored: true });
    expect(readSetupStates(dir)['cloudflare-domain']?.keyStoredBySetup).toBe(true);

    const sync = await request(a).post(`${BASE}/sync`).set('X-Instar-Request', '1').send({});
    expect(sync.body).toMatchObject({ ok: true, copied: ['agent.example.com'] });
    expect(JSON.stringify(sync.body)).not.toContain('cf-secret-token');
    expect(apiCalls).toEqual(['verify', 'zone', 'find', 'create', 'ingress', 'dns', 'token']);
    expect(tunnel).toEqual({ enabled: true, type: 'named', token: 'run-token', hostname: 'agent.example.com' });
    expect(restarts).toHaveLength(1);
    expect(readSetupStates(dir)['cloudflare-domain']?.cloudflareWork).toMatchObject({ tunnelId: 't1', dnsRecordId: 'r1', createdDns: true, createdTunnel: true });
    expect(JSON.stringify(readSetupStates(dir))).not.toContain('run-token');

    // Before the name resolves the check fails without taking the yes away; once the agent answers there, it passes.
    expect((await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({})).body.result).toBe('fail');
    reach = 'ok';
    expect((await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({})).body.result).toBe('pass');

    expect((await say(a, 'no', true)).status).toBe(200);
    await vi.waitFor(() => expect(tunnel).toEqual({ enabled: true, type: 'quick' }));
    expect(apiCalls.slice(-2)).toEqual(['deleteDns', 'deleteTunnel']);
    expect(secrets).toEqual({});
    expect(restarts).toHaveLength(2);
    expect(readSetupStates(dir)['cloudflare-domain']?.cloudflareWork).toBeUndefined();
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith(expect.stringContaining('fixed address is switched off')));
  });

  it('a fixed address the person already had is never replaced, and a switch-off leaves it alone', async () => {
    tunnel = { enabled: true, type: 'named', token: 'their-run', hostname: 'me.example.org' };
    reach = 'ok';
    const a = app();
    await say(a, 'yes');
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith(expect.stringContaining('already working')));
    expect(start).not.toHaveBeenCalled();
    // Even a session that reached the key route could not replace it.
    ledger.recordYes({ service: 'cloudflare-domain', origin: 'owner-surface', offerTextHash: 'h', grantMachine: 'm_a', principal: '42' });
    expect((await storeKey(a, VALUE)).body.error).toBe('already-held');
    await say(a, 'no', true);
    await vi.waitFor(() => expect(readSetupStates(dir)['cloudflare-domain']?.stopped).toBeTruthy());
    expect(tunnel).toEqual({ enabled: true, type: 'named', token: 'their-run', hostname: 'me.example.org' });
    expect(apiCalls).toEqual([]);
    expect(restarts).toHaveLength(0);
  });

  it('a switch-off of the only way in waits, and says so, until another route works', async () => {
    otherRoute = false;
    const a = app();
    await say(a, 'yes');
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    await storeKey(a, VALUE);
    await request(a).post(`${BASE}/sync`).set('X-Instar-Request', '1').send({});
    reach = 'ok';
    await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({});
    await say(a, 'no', true);
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith(expect.stringContaining('only way I can reach you')));
    expect(tunnel?.type).toBe('named');
  });
});
