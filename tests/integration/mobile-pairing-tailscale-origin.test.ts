/**
 * docs/specs/mobile-pairing-tailscale-origin.md — pairing over this machine's Tailscale own name
 * when no Cloudflare named tunnel runs, codes bound to the origin they were minted for, the
 * relay wait, mint-time approval check, and 30-minute lifetimes. Full HTTP pipeline.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { PENDING_TTL_MS } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const CF = 'cirrus.example.dev';
const TS = 'cirrus-vm.tail0000.ts.net';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-pairing-tailscale-origin.test.ts' }); });

interface Opts { named?: boolean; tunnelState?: string; provider?: string | null; tsListed?: boolean; tsAccepted?: boolean; tsProbeOk?: boolean | null; dmFails?: boolean; lease?: { held: boolean }; noOwnNames?: boolean }

function setup(o: Opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ts-'));
  dirs.push(dir);
  const config = {
    projectName: 'cirrus', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    tunnel: o.named === false ? { enabled: true, type: 'quick' } : { enabled: true, type: 'named', token: 'x', hostname: CF },
    mobilePairing: { multiRoute: { enabled: false } },
  } as unknown as InstarConfig;
  const lifecycle = { lastState: o.tunnelState ?? 'idle', activeProvider: o.provider === undefined ? null : o.provider };
  const app = express();
  app.use(express.json());
  const dms: string[] = [];
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', u.host);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const lease = o.lease ?? { held: true };
  const deps: MobilePairingDeps = {
    config, stateDir: dir, tunnel: () => ({ lifecycleState: lifecycle }), selfMachineId: 'm_self', fetchFn,
    ownerDM: async (text) => { if (o.dmFails) return null; dms.push(text); return 4242; },
    holdsLease: () => lease.held,
  };
  const svc = new MobilePairingService(deps);
  // A stand-in for MobileOwnNames (its proof and probe loop are covered in mobile-own-names tests):
  // only the read surface the pairing routes use.
  const listed = o.tsListed === false ? [] : [{ kind: 'tailscale' as const, host: TS, firstVerifiedAt: '2026-11-02T00:00:00.000Z' }];
  const fakeOwn = {
    listed: () => listed,
    accepts: (h: string) => o.tsAccepted !== false && listed.some((n) => n.host === h),
    routes: () => listed.map((n) => ({ kind: n.kind, origin: `https://${n.host}`, firstVerifiedAt: n.firstVerifiedAt, lastProbeOk: o.tsProbeOk === undefined ? true : o.tsProbeOk, lastProbeAt: null })),
    proveNow: async () => undefined,
    stop: () => undefined,
  };
  if (!o.noOwnNames) Object.defineProperty(svc, 'ownNames', { value: fakeOwn });
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'cirrus', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps));
  return { app, svc, lifecycle, dms };
}

const mint = (app: express.Express) => request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer tok-1').send({ label: 'phone' });
const redeem = (app: express.Express, code: string, host: string) =>
  request(app).post('/mobile/pairing-codes/redeem').set('Host', host).send({ code, deviceName: 'iPhone', devicePublicKey: makeDevice().publicKey });

describe('pairing over a Tailscale own name', () => {
  it('no named tunnel: mints a Tailscale-origin link with originKind and a 30-minute lifetime, and redeems on that host', async () => {
    const ctx = setup({ named: false });
    const t0 = Date.now();
    const m = await mint(ctx.app);
    expect(m.status).toBe(200);
    expect(m.body.originKind).toBe('tailscale');
    expect(m.body.link).toContain(`o=${encodeURIComponent('https://' + TS)}`);
    const ttl = Date.parse(m.body.expiresAt) - t0;
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000 + 5_000);
    const r = await redeem(ctx.app, m.body.code, TS);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'pending', approval: 'telegram' });
    expect(ctx.svc.devices.list()[0]!.host).toBe(TS);
  });

  it('a running named tunnel is still preferred (originKind cloudflare); a named tunnel that is down falls back to Tailscale', async () => {
    const up = await mint(setup({ tunnelState: 'active', provider: 'cloudflare-named' }).app);
    expect(up.body.originKind).toBe('cloudflare');
    const down = await mint(setup({ tunnelState: 'exhausted', provider: null }).app);
    expect(down.status).toBe(200);
    expect(down.body.originKind).toBe('tailscale');
  });

  it('a stale or failed probe does not disqualify a name this machine still configures; an unconfigured one does', async () => {
    expect((await mint(setup({ named: false, tsProbeOk: false }).app)).status).toBe(200);
    expect((await mint(setup({ named: false, tsProbeOk: null }).app)).status).toBe(200);
    const gone = await mint(setup({ named: false, tsAccepted: false }).app);
    expect(gone.status).toBe(409);
    expect(gone.body.error).toBe('stable-address-required');
    expect((await mint(setup({ named: false, noOwnNames: true }).app)).body.error).toBe('stable-address-required');
  });

  it('a backup relay that may be carrying traffic makes Tailscale pairing wait, at mint and at redeem', async () => {
    const relay = setup({ named: false, tunnelState: 'relay-active', provider: 'localtunnel' });
    const m = await mint(relay.app);
    expect(m.status).toBe(409);
    expect(m.body.error).toBe('address-unverified');
    const ok = setup({ named: false });
    const m2 = await mint(ok.app);
    ok.lifecycle.lastState = 'self-healing';
    expect((await redeem(ok.app, m2.body.code, TS)).status).toBe(403);
    ok.lifecycle.lastState = 'idle';
    expect((await redeem(ok.app, m2.body.code, TS)).status).toBe(200); // the refused attempt did not burn the link
  });

  it('a code redeems only on the host it was minted for: a Tailscale link keeps working when Cloudflare returns', async () => {
    const ctx = setup({ tunnelState: 'exhausted', provider: null });
    const m = await mint(ctx.app);
    expect(m.body.originKind).toBe('tailscale');
    ctx.lifecycle.lastState = 'active';
    ctx.lifecycle.activeProvider = 'cloudflare-named';
    expect((await redeem(ctx.app, m.body.code, TS)).status).toBe(200);
  });

  it('an altered link (Tailscale code sent to the Cloudflare host) is refused and the code is spent', async () => {
    const ctx = setup({ tunnelState: 'exhausted', provider: null });
    const m = await mint(ctx.app);
    ctx.lifecycle.lastState = 'active';
    ctx.lifecycle.activeProvider = 'cloudflare-named';
    expect((await redeem(ctx.app, m.body.code, CF)).status).toBe(403);
    expect((await redeem(ctx.app, m.body.code, TS)).status).toBe(403);
    expect(ctx.svc.devices.list()).toHaveLength(0);
  });

  it('a host that is neither the running tunnel nor a Tailscale own name is refused before the code is taken', async () => {
    const ctx = setup({ named: false });
    const m = await mint(ctx.app);
    expect((await redeem(ctx.app, m.body.code, 'evil.example')).status).toBe(403);
    expect((await redeem(ctx.app, m.body.code, CF)).status).toBe(403); // configured but not running
    expect((await redeem(ctx.app, m.body.code, TS)).status).toBe(200);
  });

  it('mint refuses 409 approval-unavailable on a machine that cannot deliver the code', async () => {
    const standby = await mint(setup({ named: false, lease: { held: false } }).app);
    expect(standby.status).toBe(409);
    expect(standby.body.error).toBe('approval-unavailable');
  });

  it('a waiting device lives 30 minutes', () => {
    expect(PENDING_TTL_MS).toBe(30 * 60_000);
  });
});
