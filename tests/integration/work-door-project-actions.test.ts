/**
 * The owner's project actions through HTTP (docs/specs/work-door-project-rows.md §3.2–3.5): the production auth
 * middleware + device authenticator + the real MobilePairingService, the real phone write gate, the real
 * ChiefOfStaffLoop (over an in-memory journal that validates every record with the store's own schema) and the real
 * Projects read. An owner phone with an enrolled presence key pauses and resumes a project, checks a judged item and
 * finishes it; a changed item is refused before any challenge is issued; a wrong signature and a non-owner phone write
 * nothing; the bearer's Ask for an update returns the fresh row and then queues.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobilePermissionsRoutes, permissionPresenceMessage, type MobilePermissionsDeps } from '../../src/server/mobilePermissionsRoutes.js';
import { mountProjectsRoutes } from '../../src/server/workProjectsRoutes.js';
import { projectTapPort } from '../../src/server/workProjectActions.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS, clampLoopConfig, type ChiefOfStaffLoopDeps } from '../../src/core/ChiefOfStaffLoop.js';
import { chiefOfStaffRecordStoreSchema, buildBindingPut, foldBindingState, doneItemCheckRef, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const CK = 'telegram:144900';
const GOAL = 'Project rows that say something.';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/work-door-project-actions.test.ts' });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdpr-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, dashboardPin: '424242', mobilePairing: { multiRoute: { enabled: false } } } as never;
  const svc = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' } as MobilePairingDeps);
  services.push(svc);

  // The journal: every record passes the store's own validator, as CoherenceJournal's emit does.
  const entries: UnionEntry[] = []; let clock = 1; let seq = 0;
  const emit = (recordKey: string, build: (hlc: HlcTimestamp, origin: string) => Record<string, unknown> | null) => {
    const hlc: HlcTimestamp = { physical: ++clock, logical: 0, node: 'm_self' };
    const data = build(hlc, 'm_self'); if (!data) return { outcome: 'dropped' };
    const v = chiefOfStaffRecordStoreSchema.validate(data, { countDroppedField: () => {}, countJailReject: () => {} } as never);
    if (!v) return { outcome: 'dropped:schema' };
    entries.push({ data: { ...v, recordKey, hlc, op: 'put', origin: 'm_self' }, origin: 'm_self' }); return { outcome: 'emitted', seq: ++seq };
  };
  const state = { prDone: 'pass' as 'pass' | 'fail', gathered: 0 };
  const cfg = clampLoopConfig({ ...CHIEF_OF_STAFF_LOOP_DEFAULTS });
  const loopDeps: ChiefOfStaffLoopDeps = {
    now: () => Date.now(), machineId: 'm_self', enabled: () => true, holdsLease: () => true, config: () => cfg,
    journal: { emit, loadUnion: () => entries.slice(), awaitDurable: async () => {} },
    verifyRenewal: () => true,
    gather: async () => { state.gathered++; return { conversationKey: CK, items: [{ id: 'run', source: 'run', ageMs: 1000, value: `v${state.gathered}`, unknown: false }], netDiffLines: 0, mergedPrsSinceLastCheck: 0, doneItems: { pr: state.prDone }, liveSession: false, conversationTail: [], lastOwnerMessageAt: null, lastAgentMessageAt: null, overdueCommitments: 0 }; },
    judge: async () => ({ verdict: 'waiting-on-user', citedIds: ['run'], reason: 'Waiting on the owner to try it on a phone.' }),
    protocol: { claim: async () => ({ outcome: 'started', runId: 'r' }), standDown: () => null, settleOpenIntent: async () => 'lost', operatorLeaseLive: () => true } as unknown as ChiefOfStaffLoopDeps['protocol'],
    mirrorInitiativeStatus: () => {}, sendNote: async () => {}, sendImmediate: async () => {}, statusUrl: () => null, localHour: () => 3,
    sign: (c) => `sig:${c.length}`,
  };
  const loop = new ChiefOfStaffLoop(loopDeps);
  emit(`binding:${CK}`, buildBindingPut({ conversationKey: CK, goal: GOAL, checkCadenceHours: 24, doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'PR merged' }, { id: 'feel', kind: 'judgment', text: 'Feels right on a phone' }], linked: { repos: ['o/r'], branches: ['b'] }, confirmedBy: 'owner', confirmedAt: new Date().toISOString() } as never));

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  const projectsRoute = mountProjectsRoutes(router, {
    projects: () => loop.projectsOverview() ?? 'failed', boardFor: () => null, bearerOk: (req) => req.headers.authorization === 'Bearer tok-1',
    checkContext: () => ({ here: loop.checksHere(), gapMs: loop.requestGapMs() }), checkNow: (k, by) => loop.checkNow(k, by),
  });
  const deps: MobilePermissionsDeps = {
    pairing: () => svc, config: () => config, stateDir: dir, bearerOk: (req) => req.headers.authorization === 'Bearer tok-1',
    localSlips: () => ({ approvals: { state: 'off', rows: [] }, slips: { state: 'ok', mandates: [], invalidIds: [] } }),
    personName: () => null, peerSlips: async () => [], peerFeatures: async () => [], nicknameOf: () => null,
    features: () => ({ state: 'ok', list: [] }), featureDefinition: () => null,
    approve: () => ({ status: 500, body: {} }), deny: () => ({ status: 500, body: {} }), requestSecret: () => ({ status: 500, body: {} }), cancelSecret: () => ({ status: 500, body: {} }),
    setFeature: async () => ({ status: 500, body: {} }),
    projects: projectTapPort(loop, (req, key) => projectsRoute.rowFor(req, key)),
  };
  mountMobilePermissionsRoutes(router, deps);
  app.use(router);
  const pair = (person?: { userId: string; role: 'msp' }) => {
    const dev = makeDevice(); const presence = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    svc.devices.setPresenceKey(created.device.id, presence.publicKey);
    return { dev, presence, id: created.device.id };
  };
  return { app, loop, entries, pair, state };
}

type Phone = { dev: ReturnType<typeof makeDevice>; presence: ReturnType<typeof makeDevice>; id: string };
let tick = 0;
function send(app: express.Express, phone: Phone, method: 'GET' | 'POST', p: string, body?: unknown) {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const sig = phone.dev.sign(canonicalString(phone.id, HOST, method, p, time, raw));
  let r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  r = r.set('X-Instar-Device', phone.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? r.send(raw.toString()) : r;
}
async function tap(app: express.Express, phone: Phone, issue: Record<string, unknown>, route: string, body: Record<string, unknown>, line: string, badSig = false) {
  const ch = await send(app, phone, 'POST', '/mobile/permissions/challenge', issue);
  expect(ch.status, JSON.stringify(ch.body)).toBe(200);
  const presenceSig = (badSig ? makeDevice() : phone.presence).sign(permissionPresenceMessage(phone.id, HOST, ch.body.challenge, line));
  return send(app, phone, 'POST', route, { ...body, challenge: ch.body.challenge, presenceSig });
}
const bearer = (app: express.Express) => (p: string) => request(app).post(p).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');

describe('the owner phone pauses, checks an item and finishes a project', () => {
  it('pause and resume from the phone show on the row', async () => {
    const c = setup(); const owner = c.pair();
    const paused = await tap(c.app, owner, { action: 'project-pause', target: CK, value: 'pause' }, '/mobile/work/projects/pause', { key: CK, value: 'pause' }, `project-pause ${CK} pause none`);
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body.project).toMatchObject({ state: 'paused', paused: { via: 'app' }, actions: { pause: 'resume' } });
    const read = await send(c.app, owner, 'GET', '/mobile/work/projects');
    expect(read.body.projects[0].paused.via).toBe('app');
    const resumed = await tap(c.app, owner, { action: 'project-pause', target: CK, value: 'resume' }, '/mobile/work/projects/pause', { key: CK, value: 'resume' }, `project-pause ${CK} resume none`);
    expect(resumed.status).toBe(200);
    expect(foldBindingState(c.entries).get(CK)!.pausedBy).toBeNull();
  });
  it('a changed item is refused before any challenge; Mark checked then Finish closes', async () => {
    const c = setup(); const owner = c.pair();
    const stale = await send(c.app, owner, 'POST', '/mobile/permissions/challenge', { action: 'project-item-check', target: CK, itemId: 'feel', checkRef: doneItemCheckRef(GOAL, 'feel', 'old wording'), value: 'checked' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('item-changed');
    const row = (await send(c.app, owner, 'GET', '/mobile/work/projects')).body.projects[0];
    const item = row.done.items.find((i: { id: string }) => i.id === 'feel');
    expect(item).toMatchObject({ kind: 'owner-judged', canMark: true });
    const checked = await tap(c.app, owner, { action: 'project-item-check', target: CK, itemId: 'feel', checkRef: item.checkRef, value: 'checked' }, '/mobile/work/projects/done-item', { key: CK, itemId: 'feel', checkRef: item.checkRef, value: 'checked' }, `project-item-check ${CK} ${item.checkRef} checked`);
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body.project.done.items.find((i: { id: string }) => i.id === 'feel').stateWords).toBe('Checked by you');
    const fin = await tap(c.app, owner, { action: 'project-finish', target: CK, bindingRef: row.bindingRef }, '/mobile/work/projects/finish', { key: CK, bindingRef: row.bindingRef }, `project-finish ${CK} ${row.bindingRef}`);
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body).toMatchObject({ ok: true, done: true, project: null });
    expect(foldBindingState(c.entries).get(CK)!.closed).toBe(true);
  });
  it('a wrong presence signature and a non-owner phone write nothing', async () => {
    const c = setup(); const owner = c.pair();
    const before = c.entries.length;
    const bad = await tap(c.app, owner, { action: 'project-pause', target: CK, value: 'pause' }, '/mobile/work/projects/pause', { key: CK, value: 'pause' }, `project-pause ${CK} pause none`, true);
    expect(bad.status).toBe(401);
    const msp = c.pair({ userId: 'mo', role: 'msp' });
    const r = await send(c.app, msp, 'POST', '/mobile/permissions/challenge', { action: 'project-pause', target: CK, value: 'pause' });
    expect([401, 403]).toContain(r.status);
    expect(c.entries.length).toBe(before);
  });
});

describe('Ask for an update', () => {
  it('the bearer runs one check and gets the fresh row; a second ask inside the gap is queued', async () => {
    const c = setup();
    const first = await bearer(c.app)('/work/projects/check').send({ key: CK });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ ok: true, queued: false, project: { key: CK, latestReport: { confirmed: true } } });
    const second = await bearer(c.app)('/work/projects/check').send({ key: CK });
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ ok: true, queued: true });
    expect(c.state.gathered).toBe(1);
    expect((await bearer(c.app)('/work/projects/check').send({ key: 'not a key' })).status).toBe(400);
  });
  it('the owner phone asks without Face ID', async () => {
    const c = setup(); const owner = c.pair();
    const r = await send(c.app, owner, 'POST', '/mobile/work/projects/check', { key: CK });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.queued).toBe(false);
  });
});
