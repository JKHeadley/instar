// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Chief of Staff app surface (docs/specs/chief-of-staff-topic.md §1.4) over the REAL mobile conversation
 * router + pairing service: an owner-role caller (the owner's paired phone, or the operator's Bearer)
 * gets `parentConversationKey` on tree rows and a separate `pinned` row on the FIRST page only; a
 * cursor page carries no `pinned`; the pinned row is also still present in-stream (old apps keep
 * seeing it); a server where the feature is off (no provider) emits neither field.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const COS = 900; const PROJECT = 901; const SUB = 902; const OTHER = 903;
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/chief-of-staff-app-surface.test.ts' });
});

async function setup(opts: { cos: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-app-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test machine' });
  const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } }, sessions: {}, scheduler: {}, threadline: { operatorChannel: { enabled: false } } };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const signer = loadMachineSigner(dir)!;
  const keyLookup = identityKeyLookup(dir);
  const keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
  pairing.keyLedger = keyLedger;
  const svc: AppConversationService = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    signer, keyLookup, keyLedger,
    dispatch: () => async (input) => { svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  const topics = [
    { topicId: OTHER, topicName: 'Unfiled chat', lastActivity: '2030-01-01T00:00:04.000Z' },
    { topicId: SUB, topicName: 'Sub-topic', lastActivity: '2030-01-01T00:00:03.000Z' },
    { topicId: PROJECT, topicName: 'Project A', lastActivity: '2030-01-01T00:00:02.000Z' },
    { topicId: COS, topicName: '🧭 Chief of Staff', lastActivity: '2030-01-01T00:00:01.000Z' },
  ];
  const telegram = { getOwnerUserId: () => 4242, getAllTopicMappings: () => topics.map((t) => ({ topicId: t.topicId, topicName: t.topicName })), getTopicHistory: () => [], sendToTopic: async () => ({ messageId: 1 }) };
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: 'm1', resolvePeerUrls: () => [],
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, conversationBindAuth: createConversationBindAuth(dir), appConversations: svc, telegram,
  } as unknown as RouteContext;
  const checkIns: string[] = [];
  const parents = new Map<string, string | null>([[`telegram:${COS}`, null], [`telegram:${PROJECT}`, `telegram:${COS}`], [`telegram:${SUB}`, `telegram:${PROJECT}`]]);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({
    config: config as never, pairing, service: svc, machineId: () => 'm1', pool: { config: config as never, resolvePeerUrls: () => [] } as never,
    telegramTopics: () => topics.map((t) => ({ topicId: t.topicId, topicName: t.topicName, lastActivity: t.lastActivity, lastPreview: null })),
    ...(opts.cos ? { chiefOfStaff: () => ({ pinnedKey: `telegram:${COS}`, parents }), chiefOfStaffCheckIn: (principal: string) => { checkIns.push(principal); return { ok: true as const, lease: { live: true } }; } } : {}),
  }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  const code = pairing.confirm.issue(c.device.id, Date.now() + 60_000);
  const e = { app, dev, deviceId: c.device.id, checkIns };
  expect((await signed(e, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
  return e;
}
type Env = Awaited<ReturnType<typeof setup>>;
let tick = 0;
function signed(e: Env, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = e.dev.sign(canonicalString(e.deviceId, HOST, method, p, time, raw));
  const base = method === 'GET' ? request(e.app).get(p) : request(e.app).post(p);
  const q = base.set('X-Instar-Device', e.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.set('Content-Type', 'application/json').send(raw.toString()) : q;
}
const bearer = (e: Env, p: string) => request(e.app).get(p).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
void crypto;

describe('Chief of Staff app surface', () => {
  it('owner Bearer: first page carries pinned + parentConversationKey on tree rows; the pinned row stays in-stream; Unfiled rows carry no parent', async () => {
    const e = await setup({ cos: true });
    const r = await bearer(e, '/mobile/conversations?limit=50');
    expect(r.status).toBe(200);
    expect(r.body.pinned).toEqual(expect.objectContaining({ id: COS, platform: 'telegram', parentConversationKey: null }));
    const byId = new Map<number, Record<string, unknown>>(r.body.conversations.map((c: { id: number }) => [c.id, c]));
    expect(byId.get(COS)).toBeDefined(); // old apps keep seeing it in the stream
    expect(byId.get(PROJECT)?.parentConversationKey).toBe(`telegram:${COS}`);
    expect(byId.get(SUB)?.parentConversationKey).toBe(`telegram:${PROJECT}`);
    expect('parentConversationKey' in (byId.get(OTHER) ?? {})).toBe(false);
  });
  it('the owner\'s paired phone gets the same fields through the signed device path', async () => {
    const e = await setup({ cos: true });
    const r = await signed(e, 'GET', '/mobile/conversations?limit=50');
    expect(r.status).toBe(200);
    expect(r.body.pinned?.id).toBe(COS);
    expect(r.body.conversations.find((c: { id: number }) => c.id === PROJECT)?.parentConversationKey).toBe(`telegram:${COS}`);
  });
  it('a cursor page (not the first) carries no pinned object, even when the CoS row is outside it', async () => {
    const e = await setup({ cos: true });
    const first = await bearer(e, '/mobile/conversations?limit=2');
    expect(first.body.pinned?.id).toBe(COS); // first page: pinned even though the CoS row is NOT in these 2 rows
    expect(first.body.conversations.some((c: { id: number }) => c.id === COS)).toBe(false);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await bearer(e, `/mobile/conversations?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.status).toBe(200);
    expect(second.body.pinned).toBeUndefined();
  });
  it('feature off (no provider): neither field appears', async () => {
    const e = await setup({ cos: false });
    const r = await bearer(e, '/mobile/conversations?limit=50');
    expect(r.body.pinned).toBeUndefined();
    expect(r.body.conversations.every((c: Record<string, unknown>) => !('parentConversationKey' in c))).toBe(true);
  });
});

describe('Chief of Staff app check-in (§4: an owner-admitted device renews the lease)', () => {
  it('the owner\'s paired phone checks in; a Bearer caller (no device) is refused; feature off ⇒ 503', async () => {
    const e = await setup({ cos: true });
    const r = await signed(e, 'POST', '/mobile/chief-of-staff/check-in', {});
    expect(r.status).toBe(200); expect(r.body.ok).toBe(true);
    expect(e.checkIns).toEqual([`device:${e.deviceId}`]);
    const b = await request(e.app).post('/mobile/chief-of-staff/check-in').set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo').send({});
    expect(b.status).toBe(403);
    expect(e.checkIns).toHaveLength(1);
    const off = await setup({ cos: false });
    const o = await signed(off, 'POST', '/mobile/chief-of-staff/check-in', {});
    expect(o.status).toBe(503);
  });
});
