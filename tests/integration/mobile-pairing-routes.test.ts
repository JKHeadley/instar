/** HTTP pipeline for mobile pairing links (docs/specs/mobile-pairing-link.md). */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-pairing-routes.test.ts' }); });

function setup(opts: { enabled?: boolean; tunnelState?: string; provider?: string; hostname?: string | null; siblings?: MobilePairingDeps['siblings']; foreignPing?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-int-'));
  dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1',
    developmentAgent: true,
    tunnel: { enabled: true, type: 'named', token: 'x', ...(opts.hostname === null ? {} : { hostname: opts.hostname ?? HOST }) },
    mobilePairing: opts.enabled === undefined ? undefined : { enabled: opts.enabled },
  } as unknown as InstarConfig;
  const lifecycle = { lastState: opts.tunnelState ?? 'active', activeProvider: opts.provider ?? 'cloudflare-named' };
  const app = express();
  app.use(express.json());
  // Self-probes go through this same app (as the named tunnel would deliver them).
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    const body = opts.foreignPing ? { h: '0'.repeat(64) } : r.body;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  const deps: MobilePairingDeps = { config, stateDir: dir, tunnel: () => ({ lifecycleState: lifecycle }), selfMachineId: 'm_self', siblings: opts.siblings, fetchFn };
  const svc = new MobilePairingService(deps);
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'echo'));
  app.use(createMobilePairingRouter(svc, deps));
  return { app, config, svc, lifecycle };
}

const mint = (app: express.Express) => request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer tok-1').send({ label: 'test' });
const redeem = (app: express.Express, code: string, host = HOST) => request(app).post('/mobile/pairing-codes/redeem').set('Host', host).send({ code, deviceName: 'iPhone' });

describe('mobile pairing routes', () => {
  it('mint needs Bearer; devices needs Bearer; redeem and ping do not', async () => {
    const { app } = setup();
    expect((await request(app).post('/mobile/pairing-codes').send({})).status).toBe(401);
    expect((await request(app).get('/mobile/devices')).status).toBe(401);
    expect((await request(app).get('/mobile/pairing-codes/ping?n=' + 'a'.repeat(20))).status).toBe(200);
    expect((await redeem(app, 'z'.repeat(22))).status).toBe(403);
  });

  it('mints a v1 instar.sh link and redeems it once for the token, never an operator session', async () => {
    const { app } = setup();
    const m = await mint(app);
    expect(m.status).toBe(200);
    expect(m.body.link).toBe(`https://instar.sh/pair#v=1&o=${encodeURIComponent('https://' + HOST)}&c=${m.body.code}`);
    const r = await redeem(app, m.body.code);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ token: 'tok-1', agentName: 'echo' });
    expect(r.body.operatorSessionToken).toBeUndefined();
    expect((await redeem(app, m.body.code)).status).toBe(403);
    const devices = await request(app).get('/mobile/devices').set('Authorization', 'Bearer tok-1');
    expect(devices.body.devices).toHaveLength(1);
    expect(devices.body.devices[0]).toMatchObject({ deviceName: 'iPhone', label: 'test', machine: 'm_self' });
  });

  it('refuses a redeem whose Host is not the stable host', async () => {
    const { app } = setup();
    const m = await mint(app);
    expect((await redeem(app, m.body.code, 'relay.example.com')).status).toBe(403);
  });

  it('refuses a valid code while the named tunnel is not the active provider (relay or quick fallback)', async () => {
    const { app, lifecycle } = setup();
    const m = await mint(app);
    lifecycle.lastState = 'relay-active'; lifecycle.activeProvider = 'localtunnel';
    expect((await redeem(app, m.body.code)).status).toBe(403);
    lifecycle.lastState = 'active'; lifecycle.activeProvider = 'cloudflare-quick';
    expect((await redeem(app, m.body.code)).status).toBe(403);
  });

  it('refuses a code minted before the token rotated', async () => {
    const { app, config } = setup();
    const m = await mint(app);
    (config as { authToken: string }).authToken = 'tok-2';
    expect((await redeem(app, m.body.code)).status).toBe(403);
  });

  it('mint answers 409 without a stable named address', async () => {
    expect((await mint(setup({ hostname: null }).app)).body).toMatchObject({ error: 'stable-address-required' });
    expect((await mint(setup({ tunnelState: 'relay-active', provider: 'localtunnel' }).app)).status).toBe(409);
  });

  it('mint answers 409 not-the-tunnel-machine when a sibling lists the same hostname or another process answers', async () => {
    const sib = setup({ siblings: () => [{ machineId: 'm_other', name: 'Mini', status: 'active', lastKnownUrl: `https://${HOST}` }] });
    expect((await mint(sib.app)).body).toMatchObject({ error: 'not-the-tunnel-machine' });
    expect((await mint(setup({ foreignPing: true }).app)).body).toMatchObject({ error: 'not-the-tunnel-machine' });
  });

  it('a valid code redeems after 30 bad ones; the 31st bad one gets a distinct 429', async () => {
    const { app } = setup();
    const m = await mint(app);
    for (let i = 0; i < 30; i++) expect((await redeem(app, 'b'.repeat(22))).status).toBe(403);
    const limited = await redeem(app, 'b'.repeat(22));
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('too-many-attempts');
    expect((await redeem(app, m.body.code)).status).toBe(200);
  });

  it('ping rejects a bad nonce and its public budget never blocks minting', async () => {
    const { app } = setup();
    expect((await request(app).get('/mobile/pairing-codes/ping?n=short')).status).toBe(400);
    for (let i = 0; i < 60; i++) await request(app).get('/mobile/pairing-codes/ping?n=' + `p${i}`.padEnd(20, 'x'));
    expect((await request(app).get('/mobile/pairing-codes/ping?n=' + 'q'.repeat(20))).status).toBe(429);
    expect((await mint(app)).status).toBe(200);
  });

  it('every route answers 503 when the feature is off', async () => {
    const { app } = setup({ enabled: false });
    expect((await mint(app)).status).toBe(503);
    expect((await redeem(app, 'a'.repeat(22))).status).toBe(503);
    expect((await request(app).get('/mobile/pairing-codes/ping?n=' + 'a'.repeat(20))).status).toBe(503);
    expect((await request(app).get('/mobile/devices').set('Authorization', 'Bearer tok-1')).status).toBe(503);
  });
});
