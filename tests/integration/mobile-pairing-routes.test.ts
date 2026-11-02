/** HTTP pipeline for mobile pairing links (docs/specs/mobile-pairing-link.md). */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-pairing-routes.test.ts' }); });

function setup(opts: { enabled?: boolean; tunnelState?: string; provider?: string; hostname?: string | null; siblings?: MobilePairingDeps['siblings']; foreignPing?: boolean; dmFails?: boolean; lease?: { held: boolean } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-int-'));
  dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1',
    developmentAgent: true,
    tunnel: { enabled: true, type: 'named', token: 'x', ...(opts.hostname === null ? {} : { hostname: opts.hostname ?? HOST }) },
    // Multi-route off here: these tests cover the single paired host (mobile-multi-route.md, flag off).
    mobilePairing: { ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }), multiRoute: { enabled: false } },
  } as unknown as InstarConfig;
  const lifecycle = { lastState: opts.tunnelState ?? 'active', activeProvider: opts.provider ?? 'cloudflare-named' };
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const dms: Array<{ text: string; decline: string }> = [];
  // Self-probes go through this same app (as the named tunnel would deliver them).
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    const body = opts.foreignPing ? { h: '0'.repeat(64) } : r.body;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  const lease = opts.lease ?? { held: true };
  const deps: MobilePairingDeps = {
    config, stateDir: dir, tunnel: () => ({ lifecycleState: lifecycle }), selfMachineId: 'm_self', siblings: opts.siblings, fetchFn,
    ownerDM: async (text, decline) => { if (opts.dmFails) return null; dms.push({ text, decline }); return 4242; },
    holdsLease: () => lease.held,
  };
  const svc = new MobilePairingService(deps);
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps));
  app.get('/sessions', (_req, res) => { res.json([]); });
  app.get('/topic/list', (_req, res) => { res.json({ topics: [] }); });
  return { app, config, svc, lifecycle, dms, lease };
}

const mint = (app: express.Express) => request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer tok-1').send({ label: 'test' });
const redeem = (app: express.Express, code: string, host = HOST, devicePublicKey = makeDevice().publicKey) =>
  request(app).post('/mobile/pairing-codes/redeem').set('Host', host).send({ code, deviceName: 'iPhone', devicePublicKey });

/** A device-signed request through supertest, exactly as the app signs it. */
// Strictly increasing signing times: two identical requests signed in the same millisecond would
// otherwise be byte-identical and refused by the replay guard (a timing flake, not the behaviour
// under test — the app retries with a fresh signature and time).
let lastSignTime = 0;
function signed(app: express.Express, dev: ReturnType<typeof makeDevice>, deviceId: string, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  lastSignTime = Math.max(Date.now(), lastSignTime + 1);
  const time = String(lastSignTime);
  const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
  const r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  r.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? r.send(raw.toString()) : r;
}

const codeFrom = (dm: { text: string }) => /is (\d{3}) (\d{3})\./.exec(dm.text)!.slice(1).join('');

async function pairDevice(ctx: ReturnType<typeof setup>) {
  const dev = makeDevice();
  const m = await mint(ctx.app);
  const r = await redeem(ctx.app, m.body.code, HOST, dev.publicKey);
  return { dev, deviceId: r.body.deviceId as string, redeem: r };
}

describe('mobile pairing routes', () => {
  it('mint needs Bearer; devices needs Bearer; redeem and ping do not', async () => {
    const { app } = setup();
    expect((await request(app).post('/mobile/pairing-codes').send({})).status).toBe(401);
    expect((await request(app).get('/mobile/devices')).status).toBe(401);
    expect((await request(app).get('/mobile/pairing-codes/ping?n=' + 'a'.repeat(20))).status).toBe(200);
    expect((await redeem(app, 'z'.repeat(22))).status).toBe(403);
  });

  it('mints a v1 link; redeem registers a pending device, returns no token, and DMs the owner a code', async () => {
    const ctx = setup();
    const m = await mint(ctx.app);
    expect(m.status).toBe(200);
    expect(m.body.link).toBe(`https://instar.sh/pair#v=1&o=${encodeURIComponent('https://' + HOST)}&c=${m.body.code}&n=echo`);
    const dev = makeDevice();
    const r = await redeem(ctx.app, m.body.code, HOST, dev.publicKey);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ agentName: 'echo', status: 'pending' });
    expect(r.body.token).toBeUndefined();
    expect(ctx.dms).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain(codeFrom(ctx.dms[0])); // the code never comes back to the phone
    expect(ctx.dms[0].decline).toMatch(/^md:d:[0-9a-f]{24}$/);
    expect((await redeem(ctx.app, m.body.code)).status).toBe(403);
  });

  it('redeem without a valid device key → 400; a failed owner DM cancels the device → 409', async () => {
    const ctx = setup();
    const m = await mint(ctx.app);
    expect((await request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code })).status).toBe(400);
    const failing = setup({ dmFails: true });
    const m2 = await mint(failing.app);
    const r = await redeem(failing.app, m2.body.code);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('approval-unavailable');
    expect(failing.svc.devices.list()).toHaveLength(0);
  });

  it('the pending phone confirms with the DM code, then reads with its key; bearer cannot confirm', async () => {
    const ctx = setup();
    const { dev, deviceId } = await pairDevice(ctx);
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/sessions')).status).toBe(401); // pending: not allowed yet
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/mobile/device')).body.status).toBe('pending');
    expect((await request(ctx.app).post('/mobile/device/confirm').set('Authorization', 'Bearer tok-1').send({ code: codeFrom(ctx.dms[0]) })).status).toBe(403);
    const ok = await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code: codeFrom(ctx.dms[0]) });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('active');
    expect((await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code: '000000' })).body.status).toBe('active'); // retry is a no-op
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/sessions')).status).toBe(200);
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/topic/list')).status).toBe(200); // conversation recency for the app
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/mobile/pairing-codes')).status).toBe(403); // not on the allowlist
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/SESSIONS/')).status).toBe(200); // normalized path
  });

  it('three distinct wrong codes decline; a replayed wrong code is not counted twice', async () => {
    const ctx = setup();
    const { dev, deviceId } = await pairDevice(ctx);
    const right = codeFrom(ctx.dms[0]);
    const wrongs = ['111111', '222222', '333333'].filter((c) => c !== right).slice(0, 3);
    expect((await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code: wrongs[0] })).status).toBe(403);
    expect((await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code: wrongs[0] })).status).toBe(403);
    expect(ctx.svc.devices.get(deviceId)!.wrongCodes).toHaveLength(1);
    await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code: wrongs[1] });
    const third = await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code: wrongs[2] ?? '444444' });
    expect(third.body.error).toBe('declined');
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('declined');
  });

  it('the owner Decline handler and a code leaked in a conversation both cancel the pairing', async () => {
    const ctx = setup();
    const a = await pairDevice(ctx);
    expect(ctx.svc.declineByNonce(ctx.dms[0].decline.slice(5))).toBe('declined');
    expect(ctx.svc.devices.get(a.deviceId)!.status).toBe('declined');
    const b = await pairDevice(ctx);
    const code = codeFrom(ctx.dms[ctx.dms.length - 1]);
    expect(ctx.svc.scanInbound(`my code is ${code.slice(0, 3)} ${code.slice(3)}`)).toEqual([b.deviceId]);
    expect(ctx.svc.devices.get(b.deviceId)!.status).toBe('declined');
  });

  it('a lease loss expires pending pairings and the confirm answers approval-moved without counting', async () => {
    const ctx = setup();
    const { dev, deviceId } = await pairDevice(ctx);
    ctx.lease.held = false;
    const r = await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code: '999999' });
    expect(r.body.error).toBe('approval-moved');
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('expired');
    expect(ctx.svc.devices.get(deviceId)!.wrongCodes ?? []).toHaveLength(0);
  });

  it('revoke: a device only itself, bearer any; a revoked device is refused', async () => {
    const ctx = setup();
    const a = await pairDevice(ctx);
    await signed(ctx.app, a.dev, a.deviceId, 'POST', '/mobile/device/confirm', { code: codeFrom(ctx.dms[0]) });
    const b = await pairDevice(ctx);
    expect((await signed(ctx.app, a.dev, a.deviceId, 'POST', `/mobile/devices/${b.deviceId}/revoke`, {})).status).toBe(403);
    expect((await request(ctx.app).post(`/mobile/devices/${a.deviceId}/revoke`).set('Authorization', 'Bearer tok-1').send({})).body.revoked).toBe(true);
    expect((await signed(ctx.app, a.dev, a.deviceId, 'GET', '/sessions')).status).toBe(401);
    const list = await request(ctx.app).get('/mobile/devices').set('Authorization', 'Bearer tok-1');
    const row = list.body.devices.find((d: { id: string }) => d.id === a.deviceId);
    expect(row).toMatchObject({ status: 'revoked' });
    expect(JSON.stringify(list.body)).not.toContain(a.dev.publicKey);
    expect(list.body.devices.find((d: { id: string }) => d.id === b.deviceId).fingerprint).toBeUndefined(); // pending: no fingerprint
  });

  it('a lease loss seen by the lease watch voids codes even if the lease comes back', async () => {
    const ctx = setup();
    const { dev, deviceId } = await pairDevice(ctx);
    const code = codeFrom(ctx.dms[ctx.dms.length - 1]);
    ctx.lease.held = false;
    ctx.svc.leaseTick();
    ctx.lease.held = true;
    expect((await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code })).status).toBe(401);
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/mobile/device')).body.status).toBe('expired');
    ctx.svc.stop();
  });

  it('three wrong codes tell the owner privately', async () => {
    const ctx = setup();
    const { dev, deviceId } = await pairDevice(ctx);
    const right = codeFrom(ctx.dms[0]);
    for (const c of ['111111', '222222', '333333', '444444'].filter((x) => x !== right).slice(0, 3)) {
      await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code: c });
    }
    expect(ctx.dms[ctx.dms.length - 1].text).toContain('Three wrong codes');
  });

  it('device headers authenticate nothing when the gate is off', async () => {
    const on = setup();
    const { dev, deviceId } = await pairDevice(on);
    const off = setup({ enabled: false });
    expect((await signed(off.app, dev, deviceId, 'GET', '/sessions')).status).toBe(401);
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

  it('message history served to a device has view signatures removed', async () => {
    const { stripViewSignatures } = await import('../../src/server/mobilePairingRoutes.js');
    const out = stripViewSignatures([{ text: 'see https://x.dev/view/abc?sig=' + 'a'.repeat(64) }]);
    expect(out[0].text).toBe('see https://x.dev/view/abc?sig=removed');
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
