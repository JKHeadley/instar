/**
 * HTTP pipeline for the phone's native Plans, What I've learned about you and Other agents reads
 * (docs/specs/mobile-native-plans-people.md) through the production authMiddleware +
 * deviceAuthenticator: an owner phone and the bearer token are served; an MSP phone, a demoted phone,
 * a removed person's phone, a revoked phone, an unsigned or tampered request, the notification read
 * token and a POST are refused. The answers carry no record id, path, fingerprint, invite material,
 * topic id, channel evidence text, peer error text or planted credential.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, DEVICE_ALLOWLIST, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobilePlansPeopleRoutes, type MobilePlansPeopleDeps } from '../../src/server/mobilePlansPeopleRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const NOW = Date.parse('2026-11-04T02:00:00.000Z');
const H = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-plans-people.test.ts' });
});

const FAKE_KEY = 'ghp_' + 'Q'.repeat(36);
const FP = 'abcdef0123456789abcdef0123456789';
const initiatives = [
  { id: 'proj-native-app', kind: 'project', title: 'Native app coverage', status: 'active', targetRepoPath: '/Users/x/instar', telegramTopicId: 134088, unacknowledgedAdvanceCount: 1, firstLaunchAckAt: H(48),
    rounds: [{ status: 'complete', itemIds: [] }, { status: 'in-progress', itemIds: ['child-a', 'child-b'] }], lastTouchedAt: H(2) },
  { id: 'child-a', kind: 'task', title: 'Plans screen', status: 'active', parentProjectId: 'proj-native-app', pipelineStage: 'merged', specPath: 'docs/specs/secret-spec.md', prNumber: 4242, lastTouchedAt: H(1) },
  { id: 'child-b', kind: 'task', title: 'Learned screen', status: 'active', parentProjectId: 'proj-native-app', pipelineStage: 'building', lastTouchedAt: H(1) },
  { id: 'init-docs', kind: 'task', title: `Docs cleanup ${FAKE_KEY}`, status: 'active', needsUser: true, needsUserReason: 'pick a name', phases: [{ status: 'done' }, { status: 'in-progress' }], currentPhaseIndex: 1, feedbackWorkKey: 'fb-123', lastTouchedAt: H(30) },
  { id: 'init-done', kind: 'task', title: 'Old migration', status: 'completed', lastTouchedAt: H(200) },
];
const corrections = { records: [
  { id: 'corr-1', kind: 'user-preference', status: 'open', occurrenceCount: 2, scrubbedSummary: 'Lead with the short answer', detectedAt: H(5), updatedAt: H(3), topicId: 777001, dedupeKey: 'dk-secret', routedVia: 'route-x' },
  { id: 'corr-2', kind: 'noise', status: 'open', scrubbedSummary: '', detectedAt: H(10) },
], totalRecords: 2 };
const pairings = [{ peerFp: FP, peerName: 'Dawn', state: 'mutual-verified', trustSource: 'paired', machineId: 'm_self' }];
const delivery = [{ peerFp: FP, peerName: 'Dawn', lastAckedAt: H(2), pendingCount: 0, failedCount: 0, unconfirmedCount: 0, stale: false, dark: false, lastRelayStatus: 'delivered', machineId: 'm_self' }];
const channels = { advisory: true, channels: [
  { id: 'threadline-relay', audience: 'peer', state: 'working', direction: 'bidirectional', detail: 'relay socket to wss://relay.example/abc token=zzz', purpose: 'p', whenPreferred: 'w', cost: 'c', probeFailed: false },
  { id: 'user-telegram', audience: 'user', state: 'broken', direction: 'none', detail: 'lastError: 409 Conflict at /Users/x/bot', purpose: 'p', whenPreferred: 'w', cost: 'c', probeFailed: false },
], summary: { total: 2, working: 1, unusable: 1, unknown: 0 } };

function deps(over: Partial<MobilePlansPeopleDeps> = {}): MobilePlansPeopleDeps {
  return {
    initiatives: () => initiatives,
    offlineMachineIds: () => ['m_far'],
    peerInitiatives: async () => [{ machineId: 'm_peer', state: 'unreached' }],
    preferences: async () => ({ ok: true, data: { present: true, block: '<prefs>\n- Lead with the short answer (confidence 0.85, seen 3×)\n- Plain words (confidence 0.40, seen 1×)', count: 2 } }),
    corrections: () => ({ ok: true, data: corrections }),
    peerCorrections: async () => [],
    pairings: async () => ({ state: 'ok', rows: pairings, failedMachineIds: [] }),
    delivery: async () => ({ state: 'ok', rows: delivery, failedMachineIds: [] }),
    channels: async () => channels,
    nicknameOf: (id) => (id === 'm_peer' ? 'Mac Mini' : id === 'm_far' ? 'Laptop' : null),
    bearerOk: (req) => req.headers.authorization === 'Bearer tok-1',
    now: () => NOW,
    ...over,
  };
}
function setup(over: Partial<MobilePlansPeopleDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpp-int-'));
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
  mountMobilePlansPeopleRoutes(router, deps(over));
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

const ROUTES = ['/mobile/plans', '/mobile/learned', '/mobile/agents'];
const LEAKS = ['proj-native-app', 'child-a', 'init-docs', '/Users/x', 'secret-spec', '4242', '134088', 'fb-123', 'ghp_QQQQ', 'corr-1', '777001', 'dk-secret', 'route-x', FP, 'abcdef012345', 'wss://', 'token=zzz', '409 Conflict', 'm_self', 'm_peer', 'm_far'];

describe('owner phone: served, trimmed', () => {
  it('GET /mobile/plans groups plans like the console, scoped to the machines that answered', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/plans');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ schemaVersion: 1, enabled: true, selfState: 'ok', unread: { count: 1, names: ['Mac Mini'] }, offline: { count: 1, names: ['Laptop'] } });
    expect(r.body.headline).toBe('2 plans in flight (on the machines that answered). 2 need you.');
    expect(r.body.sections.needsYou[0].title).toBe('Native app coverage');
    expect(r.body.sections.needsYou[1].title).toMatch(/^Docs cleanup /);
    const project = r.body.sections.needsYou[0];
    expect(project).toMatchObject({ kind: 'project', needs: 'Waiting for your OK on round 2', line: 'round 2 of 2 · 1 of 2 pieces merged · running · waiting for your OK', machine: null });
    expect(r.body.sections.needsYou[1]).toMatchObject({ kind: 'initiative', needs: 'Waiting on you: pick a name', fromFeedback: true, line: 'step 2 of 2 · waiting on you: pick a name · from user feedback' });
    expect(r.body.counts.finished).toBe(1);
    const text = JSON.stringify(r.body);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
  });

  it('GET /mobile/learned shows preferences with sure-words and watched corrections, scrubbed', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/learned');
    expect(r.status).toBe(200);
    expect(r.body.headline).toBe('I’ve picked up 2 things about how you like to work.');
    expect(r.body.preferences.items.map((i: { text: string; sureWords: string; seenWords: string }) => [i.text, i.sureWords, i.seenWords])).toEqual([['Lead with the short answer', 'sure', 'seen 3 times'], ['Plain words', 'not yet sure', 'seen once']]);
    expect(r.body.corrections.watching).toHaveLength(1);
    expect(r.body.corrections.watching[0]).toMatchObject({ summary: 'Lead with the short answer', statusWords: 'Seen 2 times — waiting to see it on other days before I keep it', machine: null });
    expect(r.body.corrections.earlier[0]).toMatchObject({ summary: 'No clear lesson', kindWords: 'No clear lesson' });
    expect(r.body.changeLine).toBe('To change one, tell me in chat.');
    const text = JSON.stringify(r.body);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
  });

  it('GET /mobile/agents gives names, pairing and delivery health, and channel verdicts without their evidence', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/agents');
    expect(r.status).toBe(200);
    expect(r.body.headline).toBe('Dawn is reachable.');
    expect(r.body.agents[0]).toMatchObject({ name: 'Dawn', trust: 'paired', trustWords: 'Paired', health: 'answered', healthWords: 'Answered 2 h ago', tone: 'ok' });
    expect(r.body.channels).toEqual([
      { key: 'threadline-relay', name: 'Agent network relay', audience: 'agents', state: 'working', stateWords: 'Working', directionWords: 'sends and receives', tone: 'ok' },
      { key: 'user-telegram', name: 'Telegram', audience: 'you', state: 'broken', stateWords: 'Broken', directionWords: 'carries nothing', tone: 'bad' },
    ]);
    const text = JSON.stringify(r.body);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
  });

  it('the bearer token is served too', async () => {
    const c = setup();
    for (const p of ROUTES) expect((await request(c.app).get(p).set('Authorization', 'Bearer tok-1')).status, p).toBe(200);
  });

  it('a part that throws reads as unavailable while the rest still shows', async () => {
    const c = setup({ preferences: async () => { throw new Error('boom /Users/x'); }, channels: async () => { throw new Error('boom'); } });
    const l = await signedGet(c, '/mobile/learned');
    expect(l.status).toBe(200);
    expect(l.body.preferences.state).toBe('unavailable');
    expect(l.body.corrections.state).toBe('ok');
    const a = await signedGet(c, '/mobile/agents');
    expect(a.body.channelsState).toBe('unavailable');
    expect(a.body.agents).toHaveLength(1);
    expect(JSON.stringify(l.body) + JSON.stringify(a.body)).not.toContain('boom');
  });

  it('a read that throws answers a fixed error code', async () => {
    const c = setup({ peerInitiatives: () => { throw new Error('x'); }, nicknameOf: () => { throw new Error('registry exploded /Users/x'); } });
    const r = await signedGet(c, '/mobile/plans');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'plans-unavailable' });
  });
});
describe('refused', () => {
  it('an MSP phone gets 403 owner-phone-required from the device layer on every route', async () => {
    let reads = 0;
    const c = setup({ initiatives: () => { reads++; return initiatives; } });
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
    expect((await signedGet(c, '/mobile/plans')).status).toBe(200);
    c.svc.devices.setPerson(c.id, { userId: 'justin', role: 'msp' });
    const r = await signedGet(c, '/mobile/plans');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner-phone-required');
  });

  it('a phone whose person was removed gets person-unknown before the route runs', async () => {
    const c = setup();
    const ghost = c.pair({ userId: 'nobody', role: 'msp' } as never);
    const r = await signedGet({ app: c.app, dev: ghost.dev, id: ghost.id }, '/mobile/learned');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('person-unknown');
  });

  it('a revoked phone is refused', async () => {
    const c = setup();
    c.svc.devices.revoke(c.id);
    for (const p of ROUTES) expect((await signedGet(c, p)).status, p).toBe(401);
  });

  it('an unsigned device request, a tampered path or query and no credentials are refused', async () => {
    const c = setup();
    for (const p of ROUTES) {
      expect((await request(c.app).get(p).set('X-Instar-Device', c.id)).status, p).toBe(401);
      expect((await request(c.app).get(p)).status, p).toBe(401);
    }
    const time = String(Date.now());
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', '/mobile/plans?x=1', time, undefined));
    const tampered = await request(c.app).get('/mobile/plans?x=2').set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
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

  it('allowlist: GET only, owner only, own bucket; raw routes stay off; a POST is refused', async () => {
    for (const p of ROUTES) {
      const rule = DEVICE_ALLOWLIST.find((x) => x.method === 'GET' && x.re.test(p));
      expect(rule, p).toBeDefined();
      expect([...rule!.statuses]).toEqual(['active']);
      expect(rule).toMatchObject({ body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'plans-people-reads' });
      expect(rule!.unassignedOk).toBeUndefined();
      expect(DEVICE_ALLOWLIST.some((x) => x.method !== 'GET' && x.re.test(p))).toBe(false);
    }
    for (const p of ['/initiatives', '/initiatives/digest', '/projects', '/projects/p1', '/preferences/session-context', '/corrections', '/corrections/c1', '/channels', '/threadline/pairing', '/threadline/peers/health', '/threadline/conversations', '/threadline/threads/t1', '/state/conflicts', '/blockers']) {
      expect(DEVICE_ALLOWLIST.some((x) => x.re.test(p)), p).toBe(false);
    }
    const c = setup();
    const time = String(Date.now());
    const raw = Buffer.from('{}');
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'POST', '/mobile/plans', time, raw));
    const post = await request(c.app).post('/mobile/plans').set('Content-Type', 'application/json')
      .set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send('{}');
    expect(post.status).toBe(403);
    expect(post.body.error).toBe('device-not-allowed');
  });

  it('the shared bucket stops a phone after 20 reads a minute', async () => {
    const c = setup();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await signedGet(c, ROUTES[i % 3])).status;
    expect(last).toBe(429);
  });
});
