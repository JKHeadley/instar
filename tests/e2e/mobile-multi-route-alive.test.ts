/** Production-path proof (docs/specs/mobile-multi-route.md): AgentServer builds the own-names
 * manager when multi-route is on (development agent), wires it into the device authenticator,
 * GET /mobile/routes and Bearer /health, and a server with two own names accepts one paired
 * device on both. The Tailscale CLI and the self-probe fetch are injected: no real tailscale
 * command and no network call runs. */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type express from 'express';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import type { TailscaleExec } from '../../src/core/MobileOwnNames.js';
import { makeDevice } from '../helpers/mobileDevice.js';

const CF = 'echo-e2e.example.dev';
const TS = 'e2e-studio.tail1234.ts.net';
const servers: AgentServer[] = [];
const dirs: string[] = [];

function boot(opts: { developmentAgent: boolean }) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mmr-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: 'mmr-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: opts.developmentAgent,
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: CF },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${CF}`, on: () => undefined } as any;
  const execCalls: string[][] = [];
  const tailscaleExec: TailscaleExec = async (args) => {
    execCalls.push(args);
    return args[0] === 'status'
      ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${TS}.` }, CertDomains: [TS] })
      : JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { [`${TS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:0' } } } } });
  };
  let app: express.Express | null = null;
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app!).get(u.pathname + u.search).set('Host', u.hostname);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const server = new AgentServer({
    config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel,
    mobileRoutes: { tailscaleExec, fetchFn, start: false },
  });
  app = server.getApp() as express.Express;
  servers.push(server);
  return { server, app, execCalls };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-multi-route-alive.test.ts' });
});

describe('mobile multi-route — production wiring', () => {
  it('a server booted with two own names accepts one device on both', async () => {
    const { server, app } = boot({ developmentAgent: true });
    const mp = server.mobilePairing!;
    expect(mp.ownNames).not.toBeNull();
    const auth = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'mmr-e2e');
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    mp.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    const dev = makeDevice();
    const red = await request(app).post('/mobile/pairing-codes/redeem').set('Host', CF).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(red.status).toBe(200);
    const id = red.body.deviceId as string;
    const send = (method: 'GET' | 'POST', p: string, host: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(Date.now());
      const sig = dev.sign(canonicalString(id, host, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('Host', host).set('X-Instar-Device', id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0])!.slice(1).join('');
    expect((await send('POST', '/mobile/device/confirm', CF, { code })).body.status).toBe('active');
    await mp.ownNames!.tick();
    expect(mp.ownNames!.listed().map((n) => n.host).sort()).toEqual([CF, TS].sort());
    expect((await send('GET', '/sessions', TS)).status).toBe(200);
    expect((await send('GET', '/sessions', CF)).status).toBe(200);
    const routes = await send('GET', '/mobile/routes', TS);
    expect(routes.status).toBe(200);
    expect(routes.body.routes.map((r: { kind: string }) => r.kind)).toEqual(['tailscale', 'cloudflare']);
    // Bearer /health carries the own names; the device's basic /health does not.
    const health = await auth(request(app).get('/health'));
    expect(health.body.mobileRoutes).toMatchObject({ enabled: true });
    expect((health.body.mobileRoutes.ownNames as Array<{ host: string }>).map((n) => n.host).sort()).toEqual([CF, TS].sort());
    const devHealth = await send('GET', '/health', TS);
    expect(devHealth.status).toBe(200);
    expect(devHealth.body.mobileRoutes).toBeUndefined();
  });

  it('is off on a fleet agent: no own names, /health says so', async () => {
    const { server, app, execCalls } = boot({ developmentAgent: false });
    expect(server.mobilePairing!.ownNames).toBeNull();
    const health = await request(app).get('/health').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'mmr-e2e');
    expect(health.body.mobileRoutes).toEqual({ enabled: false });
    expect(execCalls).toHaveLength(0);
  });
});
