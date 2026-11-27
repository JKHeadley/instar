/**
 * HTTP pipeline for the phone's native Passwords & keys read (docs/specs/mobile-native-secrets.md) through
 * the production authMiddleware + deviceAuthenticator: an owner phone and the bearer token are served; an
 * MSP phone, a revoked phone, an unsigned request and a POST are refused. The answer carries no token,
 * link, value or machine id, and the raw secret routes stay closed to a phone.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobileSecretsRoutes, type MobileSecretsDeps } from '../../src/server/mobileSecretsRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

const HOST = 'echo.example.dev';
const NOW = Date.parse('2026-11-04T02:00:00.000Z');
const TOKEN = 'f'.repeat(64);
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-secrets.test.ts' });
});

function deps(over: Partial<MobileSecretsDeps> = {}): MobileSecretsDeps {
  return {
    pending: () => [{ token: TOKEN, label: 'Stripe key', topicId: 7, createdAt: NOW - 1000, expiresAt: NOW + 600_000, expired: false, localUrl: `http://x/secrets/drop/${TOKEN}` }],
    keys: () => ({ state: 'ok', names: ['authToken', `secretDrops.${TOKEN}`] }),
    vaultBroken: () => false,
    sync: () => ({ state: 'on', pushEnabled: true, peers: [{ machineId: 'm_peer' }] }),
    peers: async () => [{ machineId: 'm_peer', state: 'unreached' }],
    offlineMachineIds: () => [],
    nicknameOf: (id) => (id === 'm_peer' ? 'Mac Mini' : null),
    topicName: () => 'Payments',
    bearerOk: (req) => req.headers.authorization === 'Bearer tok-1',
    now: () => NOW,
    ...over,
  };
}

function setup(over: Partial<MobileSecretsDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msec-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as unknown as MobilePairingDeps['config'];
  const svc = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' });
  services.push(svc);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountMobileSecretsRoutes(router, deps(over));
  app.use(router);
  const pair = (person?: { userId: string; role: 'msp' }) => {
    const dev = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) } as never);
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    return { dev, id: created.device.id };
  };
  const owner = pair();
  return { app, svc, dev: owner.dev, id: owner.id, pair };
}

let tick = 0;
function signed(c: { app: express.Express }, who: { dev: ReturnType<typeof makeDevice>; id: string }, p: string) {
  const time = String(Date.now() + (tick++ % 1000));
  const sig = who.dev.sign(canonicalString(who.id, HOST, 'GET', p, time, undefined));
  return request(c.app).get(p).set('Host', HOST).set('X-Instar-Device', who.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
}

describe('GET /mobile/secrets', () => {
  it('an owner phone reads names and state, and no token, link or machine id', async () => {
    const c = setup();
    const r = await signed(c, c, '/mobile/secrets');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ schemaVersion: 1, state: 'ok', tone: 'attn', sync: { state: 'on', peers: 1 } });
    expect(r.body.keys).toMatchObject({ names: ['authToken'], savedDrops: 1 });
    expect(r.body.requests.waiting[0]).toMatchObject({ label: 'Stripe key', conversation: 'Payments' });
    const text = JSON.stringify(r.body);
    for (const leak of [TOKEN, 'secrets/drop', 'localUrl', 'm_peer', 'm_self']) expect(text, leak).not.toContain(leak);
  });

  it('the bearer token reads the same answer', async () => {
    const r = await request(setup().app).get('/mobile/secrets').set('Authorization', 'Bearer tok-1');
    expect(r.status).toBe(200);
    expect(r.body.keys.names).toEqual(['authToken']);
  });

  it('an MSP phone is refused by the owner rule', async () => {
    const c = setup();
    const r = await signed(c, c.pair({ userId: 'justin', role: 'msp' }), '/mobile/secrets');
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain('authToken');
  });

  it('a revoked phone, an unsigned request and no credentials are refused', async () => {
    const c = setup();
    c.svc.devices.revoke?.(c.id);
    expect([401, 403]).toContain((await signed(c, c, '/mobile/secrets')).status);
    expect((await request(c.app).get('/mobile/secrets').set('X-Instar-Device', c.id)).status).toBe(401);
    expect((await request(c.app).get('/mobile/secrets')).status).toBe(401);
  });

  it('a POST is not allowed for a phone', async () => {
    const c = setup();
    const time = String(Date.now());
    const raw = '{}';
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'POST', '/mobile/secrets', time, Buffer.from(raw)));
    const r = await request(c.app).post('/mobile/secrets').set('Host', HOST).set('Content-Type', 'application/json').set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send(raw);
    expect(r.status).toBe(403);
  });

  it('the raw secret routes stay closed to the phone', async () => {
    const c = setup();
    for (const p of ['/secrets/pending', '/secrets/sync-status', '/self-knowledge/session-context']) {
      const r = await signed(c, c, p);
      expect(r.status, p).toBe(403);
      expect(r.body.error).toBe('device-not-allowed');
    }
  });

  it('a read that throws says it cannot tell, and the rest still answers', async () => {
    const c = setup({ pending: () => { throw new Error('boom'); }, keys: () => { throw new Error('boom'); } });
    const r = await signed(c, c, '/mobile/secrets');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'unavailable', tone: 'unknown', requests: { state: 'unavailable' }, keys: { state: 'unavailable' }, sync: { state: 'on' } });
  });

  it('Secret Sync saying the vault will not open wins over a key list that read fine', async () => {
    const c = setup({ vaultBroken: () => true });
    const r = await signed(c, c, '/mobile/secrets');
    expect(r.body).toMatchObject({ tone: 'bad', keys: { state: 'decrypt-failed', names: [] } });
  });

  it('?scope=local answers this machine only and never reads peers', async () => {
    let reads = 0;
    const c = setup({ peers: async () => { reads++; return []; } });
    const r = await request(c.app).get('/mobile/secrets?scope=local').set('Authorization', 'Bearer tok-1');
    expect(r.status).toBe(200);
    expect(reads).toBe(0);
    expect(r.body.peers).toBeUndefined();
    const merged = setup({ peers: async () => [{ machineId: 'm_peer', state: 'ok', data: r.body }] });
    const m = await signed(merged, merged, '/mobile/secrets');
    expect(m.body.peers[0]).toMatchObject({ machine: 'Mac Mini', waitingCount: 1 });
    expect(JSON.stringify(m.body)).not.toContain(TOKEN);
  });

  it('a failed machine list says so', async () => {
    const c = setup({ peers: async () => { throw new Error('boom'); } });
    const r = await signed(c, c, '/mobile/secrets');
    expect(r.status).toBe(200);
    expect(r.body.peersUnknown).toBe(true);
  });

  it('a dependency that answers nothing reads as unknown, not a crash', async () => {
    const c = setup({ keys: () => null as never, sync: () => undefined as never });
    const r = await signed(c, c, '/mobile/secrets');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ keys: { state: 'unavailable' }, sync: { state: 'unavailable' } });
  });

  it('a vault check that throws suppresses the all-clear, and a known-broken vault stays broken', async () => {
    const c = setup({ pending: () => [], vaultBroken: () => { throw new Error('boom'); } });
    const r = await signed(c, c, '/mobile/secrets');
    expect(r.body).toMatchObject({ tone: 'unknown', keys: { state: 'unavailable', count: null } });
    const b = setup({ keys: () => ({ state: 'decrypt-failed' }), vaultBroken: () => { throw new Error('boom'); } });
    expect((await signed(b, b, '/mobile/secrets')).body.keys.state).toBe('decrypt-failed');
  });

  it('a throw or a wrong shape is recorded as a degradation; a switched-off part is not', async () => {
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined as never);
    try {
      const shaped = setup({ pending: () => 'x', keys: () => ({ state: 'ok', names: 'x' }) });
      expect((await signed(shaped, shaped, '/mobile/secrets')).body.requests.state).toBe('unavailable');
      expect(report.mock.calls.map((c) => c[0].feature)).toEqual(['MobileSecrets.read', 'MobileSecrets.read']);
      report.mockClear();
      const off = setup({ keys: () => ({ state: 'off' }), sync: () => ({ state: 'off' }) });
      expect((await signed(off, off, '/mobile/secrets')).body.keys.state).toBe('off');
      expect(report).not.toHaveBeenCalled();
    } finally { report.mockRestore(); }
  });
});
