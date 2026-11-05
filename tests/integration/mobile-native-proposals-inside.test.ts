/**
 * HTTP pipeline for the phone's native Proposals and How I'm doing inside reads
 * (docs/specs/mobile-native-proposals-inside.md) through the production authMiddleware +
 * deviceAuthenticator: an owner phone and the bearer token are served; an MSP phone, a demoted phone, a
 * revoked phone, an unsigned or tampered request, the notification read token and a POST are refused.
 * The answers carry no ids, signatures, raw model output, paths or planted credential.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobileProposalsInsideRoutes, type MobileProposalsInsideDeps } from '../../src/server/mobileProposalsInsideRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

const HOST = 'echo.example.dev';
const NOW = Date.parse('2026-11-04T02:00:00.000Z');
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-proposals-inside.test.ts' });
});

const FAKE_KEY = 'ghp_' + 'Q'.repeat(36);
const proposals = [{ proposalId: 'prop-secret', status: 'outstanding', llmSummary: `Failure in /Users/x/a.ts ${FAKE_KEY}`, clusterSignature: 'cluster-secret', producingAgentSignature: 'sig-secret', forensic: { rawResponse: 'raw-secret' }, generatedAt: NOW, occurrencesObserved: 3, processLifetimes: 2 }];
const entries = [{ id: 'abcdef123456', t: new Date(NOW).toISOString(), kind: 'decision', subject: `Chose ${FAKE_KEY}`, counterparty: { type: 'agent', name: 'fp-secret' } }];

function deps(over: Partial<MobileProposalsInsideDeps> = {}): MobileProposalsInsideDeps {
  return {
    proposals: () => ({ state: 'ok', data: proposals }),
    peerProposals: async () => [{ machineId: 'm_peer', state: 'unreached' }],
    activity: () => ({ state: 'ok', data: { entries } }),
    insights: () => ({ state: 'ok', data: { insights: [{ id: 'ins-secret', status: 'discovered', summary: 'Timeouts', distinctSessions: 2, reopenCount: 0, discoveredAt: new Date(NOW).toISOString() }] } }),
    week: () => ({ state: 'ok', data: { total: 4 } }),
    claims: () => ({ state: 'ok', data: [{ verdict: 'supported', predicate: 'pull-request.merged', observedAt: new Date(NOW).toISOString(), claimId: 'claim-secret' }] }),
    reviews: () => ({ state: 'off' }),
    peerInside: async () => [{ machineId: 'm_peer', state: 'unreached' }],
    offlineMachineIds: () => ['m_far'],
    nicknameOf: (id) => (id === 'm_peer' ? 'Mac Mini' : id === 'm_far' ? 'Laptop' : null),
    bearerOk: (req) => req.headers.authorization === 'Bearer tok-1',
    now: () => NOW,
    ...over,
  };
}
function setup(over: Partial<MobileProposalsInsideDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never;
  const pdeps: MobilePairingDeps = { config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' };
  const svc = new MobilePairingService(pdeps);
  services.push(svc);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountMobileProposalsInsideRoutes(router, deps(over));
  app.use(router);
  const pair = (person?: { userId: string; role: 'msp' }) => {
    const dev = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    return { dev, id: created.device.id };
  };
  const owner = pair();
  return { app, svc, dev: owner.dev, id: owner.id, pair };
}

let tick = 0;
function signedGet(c: { app: express.Express; dev: ReturnType<typeof makeDevice>; id: string }, p: string) {
  const time = String(Date.now() + (tick++ % 1000));
  const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', p, time, undefined));
  return request(c.app).get(p).set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
}

const ROUTES = ['/mobile/proposals', '/mobile/inside'];
const LEAKS = ['prop-secret', 'cluster-secret', 'sig-secret', 'raw-secret', 'abcdef123456', 'fp-secret', 'ins-secret', 'claim-secret', 'm_peer', 'm_far', 'm_self', 'ghp_QQQQ', '/Users/'];

describe('owner phone: served, trimmed', () => {
  it('GET /mobile/proposals lists what is waiting and names who did not answer', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/proposals');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ schemaVersion: 1, state: 'ok', headline: '1 proposed fix is waiting on the machines that answered.', unread: { count: 1, names: ['Mac Mini'] }, offline: { count: 1, names: ['Laptop'] } });
    expect(r.body.rows[0]).toMatchObject({ occurrences: 3, restarts: 2, queued: false, machine: null });
    const text = JSON.stringify(r.body);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
  });

  it('GET /mobile/inside answers every section, off sections saying so', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/inside');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schemaVersion: 1, tone: 'attn', headline: 'One kind of problem keeps coming back: Timeouts (on the machines that answered).', peers: [], unread: { count: 1, names: ['Mac Mini'] } });
    expect(r.body.self.activity.rows[0]).toMatchObject({ kindWords: 'Decision', withWords: 'with another agent' });
    expect(r.body.self.problems).toMatchObject({ state: 'ok', weekTotal: 4, repeating: 1 });
    expect(r.body.self.claims).toMatchObject({ state: 'ok', checked: 1, contradicted: 0 });
    expect(r.body.self.reviews.state).toBe('off');
    const text = JSON.stringify(r.body);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
  });

  it('?scope=local answers this machine only and never reads peers', async () => {
    let peerReads = 0;
    const c = setup({ peerProposals: async () => { peerReads++; return []; }, peerInside: async () => { peerReads++; return []; } });
    const p = await request(c.app).get('/mobile/proposals?scope=local').set('Authorization', 'Bearer tok-1');
    const i = await request(c.app).get('/mobile/inside?scope=local').set('Authorization', 'Bearer tok-1');
    expect(p.status).toBe(200);
    expect(i.status).toBe(200);
    expect(peerReads).toBe(0);
    expect(p.body.selfState).toBe('ok');
    expect(p.body.unread).toBeUndefined();
    expect(i.body.self).toBeUndefined();
    expect(typeof i.body.headline).toBe('string');
  });

  it('a local answer read as a peer shows through the merged answer, cleaned and named', async () => {
    // Its own proposal: the same proposal on two machines is counted once.
    const peerApp = setup({ proposals: () => ({ state: 'ok', data: [{ ...proposals[0], proposalId: 'prop-peer' }] }) });
    const local = await request(peerApp.app).get('/mobile/inside?scope=local').set('Authorization', 'Bearer tok-1');
    const localP = await request(peerApp.app).get('/mobile/proposals?scope=local').set('Authorization', 'Bearer tok-1');
    const c = setup({ peerInside: async () => [{ machineId: 'm_peer', state: 'ok', data: local.body }], peerProposals: async () => [{ machineId: 'm_peer', state: 'ok', data: localP.body }] });
    const i = await signedGet(c, '/mobile/inside');
    expect(i.body.peers[0]).toMatchObject({ machine: 'Mac Mini', problems: { repeating: 1 } });
    const p = await signedGet(c, '/mobile/proposals');
    expect(p.body.rows.map((r: { machine: string | null }) => r.machine).sort()).toEqual(['Mac Mini', null].sort());
    for (const leak of LEAKS) expect(JSON.stringify(i.body) + JSON.stringify(p.body), leak).not.toContain(leak);
  });

  it('the bearer token is served too', async () => {
    const c = setup();
    for (const p of ROUTES) expect((await request(c.app).get(p).set('Authorization', 'Bearer tok-1')).status, p).toBe(200);
  });

  it('a part that throws reads as unavailable while the rest still shows, with no raw error', async () => {
    const c = setup({ proposals: () => { throw new Error('boom /Users/x'); }, claims: () => { throw new Error('boom'); } });
    const p = await signedGet(c, '/mobile/proposals');
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ state: 'unavailable', selfState: 'unavailable' });
    const i = await signedGet(c, '/mobile/inside');
    expect(i.body.self.claims.state).toBe('unavailable');
    expect(i.body.self.activity.state).toBe('ok');
    expect(JSON.stringify(p.body) + JSON.stringify(i.body)).not.toContain('boom');
  });

  it('a peer read that throws is said out loud, not read as no peers', async () => {
    const c = setup({ peerProposals: async () => { throw new Error('mesh down'); }, peerInside: async () => { throw new Error('mesh down'); }, offlineMachineIds: () => [] });
    expect((await signedGet(c, '/mobile/proposals')).body).toMatchObject({ peersUnknown: true, headline: '1 proposed fix is waiting on the machines that answered.' });
    expect((await signedGet(c, '/mobile/inside')).body.peersUnknown).toBe(true);
  });

  it('a wrong-shaped read is unavailable and recorded as a degradation, like a throw', async () => {
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report');
    const c = setup({ proposals: () => ({ state: 'ok', data: { not: 'a list' } }), claims: () => ({ state: 'ok', data: {} }) });
    expect((await signedGet(c, '/mobile/proposals')).body).toMatchObject({ state: 'unavailable', outstanding: null });
    expect((await signedGet(c, '/mobile/inside')).body.self.claims.state).toBe('unavailable');
    const calls = report.mock.calls.map((x) => x[0]).filter((e) => e.feature === 'MobileProposalsInside.read');
    expect(calls.map((e) => e.reason)).toEqual(['WrongShape', 'WrongShape']);
    report.mockRestore();
  });

  it('a failure building the answer answers a fixed error code', async () => {
    const c = setup({ nicknameOf: () => { throw new Error('registry exploded /Users/x'); } });
    for (const [p, code] of [['/mobile/proposals', 'proposals-unavailable'], ['/mobile/inside', 'inside-unavailable']]) {
      const r = await signedGet(c, p);
      expect(r.status, p).toBe(500);
      expect(r.body).toEqual({ error: code });
    }
  });
});

describe('refused', () => {
  it('an MSP phone gets 403 owner-phone-required and nothing is read', async () => {
    let reads = 0;
    const c = setup({ proposals: () => { reads++; return { state: 'ok', data: [] }; }, activity: () => { reads++; return { state: 'off' }; } });
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    for (const p of ROUTES) {
      const r = await signedGet({ app: c.app, dev: msp.dev, id: msp.id }, p);
      expect(r.status, p).toBe(403);
      expect(r.body.error).toBe('owner-phone-required');
    }
    expect(reads).toBe(0);
  });

  it('a phone demoted from owner to MSP is refused on its next read', async () => {
    const c = setup();
    expect((await signedGet(c, '/mobile/inside')).status).toBe(200);
    c.svc.devices.setPerson(c.id, { userId: 'justin', role: 'msp' });
    const r = await signedGet(c, '/mobile/inside');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner-phone-required');
  });

  it('a revoked phone is refused', async () => {
    const c = setup();
    c.svc.devices.revoke(c.id);
    for (const p of ROUTES) expect((await signedGet(c, p)).status, p).toBe(401);
  });

  it('an unsigned device request, a tampered query and no credentials are refused', async () => {
    const c = setup();
    for (const p of ROUTES) {
      expect((await request(c.app).get(p).set('X-Instar-Device', c.id)).status, p).toBe(401);
      expect((await request(c.app).get(p)).status, p).toBe(401);
    }
    const time = String(Date.now());
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', '/mobile/inside', time, undefined));
    const tampered = await request(c.app).get('/mobile/inside?scope=local').set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    expect(tampered.status).toBe(401);
  });

  it('the notification read token does not open these routes', async () => {
    const c = setup();
    for (const p of ROUTES) {
      const r = await request(c.app).get(p).set('X-Instar-Device', c.id).set('X-Instar-Notify-Token', 'a'.repeat(64));
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('notify-token-not-allowed');
    }
  });

  it('a POST to the read paths is refused by the device check', async () => {
    const c = setup();
    for (const p of ROUTES) {
      const time = String(Date.now() + (tick++ % 1000));
      const raw = Buffer.from('{}');
      const sig = c.dev.sign(canonicalString(c.id, HOST, 'POST', p, time, raw));
      const r = await request(c.app).post(p).set('Content-Type', 'application/json').set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send('{}');
      expect(r.status, p).toBe(403);
      expect(r.body.error).toBe('device-not-allowed');
    }
  });
});
