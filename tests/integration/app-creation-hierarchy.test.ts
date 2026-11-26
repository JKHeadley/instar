import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import type { AppCreationContext } from '../../src/core/AppCreationContext.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { AppCreationHierarchyProjection, type CreationHierarchySource, type CreationHierarchyScope } from '../../src/server/appCreationHierarchy.js';
import { makeDevice } from '../helpers/mobileDevice.js';

const HOST = 'hierarchy.example.dev';
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.3.1976', null); });
afterAll(() => { for (const fn of cleanups.splice(0)) fn(); ProcessIntegrity.reset(); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creation-http-'));
  const config = { projectName: 'hierarchy', projectDir: dir, stateDir: dir, port: 0, authToken: 'token', developmentAgent: true, sessions: {}, scheduler: {}, mobilePairing: { multiRoute: { enabled: false } }, threadline: { ownerName: 'Owner' } };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const pairing = new MobilePairingService({ config: config as never, stateDir: dir, selfMachineId: 'm1', holdsLease: () => true, telegramOwnerId: () => 42, people: () => ({ getUser: (id: string) => id === 'member' ? { id, name: 'Member', telegramUserId: 99, permissions: ['user'] } : null }) } as MobilePairingDeps);
  pairing.nativeOn = true;
  const svc = new AppConversationService({ stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Owner', killSession: () => true, dispatch: () => async () => 'delivered' });
  pairing.useAppConversationStore(svc.store);
  const known = new Set(['telegram:7']);
  const unreadable = new Set<string>();
  let source: CreationHierarchySource = {
    version: 'initial', complete: true, parents: new Map(), confirmedProjects: new Set(), cardEvidence: [],
    resolveRef: (raw) => {
      const app = raw.startsWith('app:') ? raw.slice(4) : raw;
      if (svc.liveConversation(app)) return `app:${app}`;
      return known.has(raw) && !unreadable.has(raw) ? raw : null;
    },
  };
  const sourceReads = vi.fn(() => source);
  const projection = new AppCreationHierarchyProjection(svc.store, sourceReads);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'token', 'hierarchy', undefined, deviceAuthenticator(pairing)));
  app.use(createMobileConversationRouter({ config: config as never, pairing, service: svc, machineId: () => 'm1', creationHierarchySource: sourceReads, creationHierarchyProjection: projection, creationAuthorizationVersion: () => 'auth1', telegramTopics: () => [{ topicId: 7, topicName: 'Project', lastActivity: null, lastPreview: null }] }));
  const owner = makeDevice();
  const pending = pairing.devices.createPending({ deviceName: 'Owner device', publicKey: owner.publicKey, host: HOST, label: null });
  if (!pending.ok) throw new Error('setup failed');
  pairing.devices.applyConfirm(pending.device.id, { ok: true });
  const add = (context?: AppCreationContext, ownerPerson?: { machineId: string; userId: string }) => {
    const key = crypto.randomUUID();
    svc.store.append({ eventId: `create-${key}`, kind: 'created', conversationKey: key, title: 'Generated chat', at: new Date().toISOString(), machineId: 'm1', ...(context ? { creationContext: context } : {}), ...(ownerPerson ? { ownerPerson } : {}) });
    return key;
  };
  let stamp = Date.now();
  const sign = (method: 'GET' | 'POST', route: string, body?: unknown, device = owner, deviceId = pending.device.id) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body)); const time = String(++stamp);
    const q = method === 'GET' ? request(app).get(route) : request(app).post(route).set('Content-Type', 'application/json');
    q.set('Host', HOST).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', device.sign(canonicalString(deviceId, HOST, method, route, time, raw)));
    return raw ? q.send(raw.toString()) : q;
  };
  const bearer = (route: string) => request(app).get(route).set('Authorization', 'Bearer token').set('X-Instar-AgentId', 'hierarchy');
  const scope = (key = 'bearer'): CreationHierarchyScope => ({ key, authorizationVersion: 'auth1', mayRead: (ref) => !!source.resolveRef(ref) && !unreadable.has(ref) });
  cleanups.push(() => { pairing.stop(); svc.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/app-creation-hierarchy.test.ts' }); });
  return { app, svc, pairing, projection, sourceReads, add, owner, ownerId: pending.device.id, sign, bearer, scope, unreadable, source: () => source, setSource: (next: CreationHierarchySource) => { source = next; } };
}
const sessionContext = (parent: string | null): AppCreationContext => ({ v: 1, source: { kind: 'session', requestId: 'fixture-session', originMachineId: 'm1' }, parentConversationKey: parent, parentBasis: 'explicit' });

describe('App creation parent metadata HTTP contract', () => {
  it('records authorized person parent intent durably and preserves completed/legacy request identity', async () => {
    const e = setup(); const parent = e.add(); const requestId = `${Date.now()}-${crypto.randomUUID()}`;
    const first = await e.sign('POST', '/mobile/conversations', { title: 'Child', requestId, parentConversationKey: parent });
    expect(first.status).toBe(200);
    const child = first.body.conversationKey;
    expect(e.svc.store.getCreationRecord(child)?.creationContext).toEqual({ v: 1, source: { kind: 'person' }, parentConversationKey: `app:${parent}`, parentBasis: 'explicit' });
    // Removal of current parent visibility cannot change a completed request's durable result.
    e.svc.applyDelete('test', 'remove-parent', parent);
    const replay = await e.sign('POST', '/mobile/conversations', { title: 'Child', requestId, parentConversationKey: `app:${parent}` });
    expect(replay.status).toBe(200); expect(replay.body).toEqual(first.body);
    expect((await e.sign('POST', '/mobile/conversations', { title: 'Child', requestId, parentConversationKey: null })).status).toBe(409);
    const root = await e.sign('POST', '/mobile/conversations', { title: 'Root', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(root.status).toBe(200);
    expect(e.svc.store.getCreationRecord(root.body.conversationKey)?.creationContext?.parentConversationKey).toBeNull();
  });
  it('refuses malformed or unavailable parent intent before creating any child', async () => {
    const e = setup(); const before = e.svc.store.listConversations().conversations.length;
    const bad = await e.sign('POST', '/mobile/conversations', { title: 'Child', requestId: `${Date.now()}-${crypto.randomUUID()}`, parentConversationKey: 'not-a-ref' });
    expect(bad.status).toBe(400);
    const absent = await e.sign('POST', '/mobile/conversations', { title: 'Child', requestId: `${Date.now()}-${crypto.randomUUID()}`, parentConversationKey: `app:${crypto.randomUUID()}` });
    expect(absent.status).toBe(404);
    expect(e.svc.store.listConversations().conversations).toHaveLength(before);
  });
  it('adds owner metadata from local evidence and never emits raw context in event sync', async () => {
    const e = setup(); const key = e.add(sessionContext('telegram:7'));
    await e.projection.settled(e.scope()); await e.projection.settled(e.scope(`device:${e.ownerId}`));
    const listed = await e.sign('GET', '/mobile/conversations');
    expect(listed.status).toBe(200);
    expect(listed.body.conversations.find((r: { id: string }) => r.id === key)).toMatchObject({ hierarchyState: 'child', parentConversationKey: 'telegram:7', creationSource: { kind: 'session', evidence: 'created-event' } });
    const events = await e.sign('GET', `/mobile/chat/app/${key}/events`);
    expect(events.status).toBe(200);
    expect(events.body.events[0].creationContext).toBeUndefined();
    expect(events.body.events[0].sourceConversationKey).toBeUndefined();
  });
  it('member readers receive neither hierarchy refs nor raw created-event metadata and cannot preview', async () => {
    const e = setup(); const key = e.add(sessionContext('telegram:7'), { machineId: 'm1', userId: 'member' });
    const device = makeDevice(); const p = e.pairing.devices.createPending({ deviceName: 'Member', publicKey: device.publicKey, host: HOST, label: null, role: 'msp', userId: 'member' });
    if (!p.ok) throw new Error('setup failed'); e.pairing.devices.applyConfirm(p.device.id, { ok: true });
    const list = await e.sign('GET', '/mobile/conversations', undefined, device, p.device.id);
    expect(list.status).toBe(200);
    const row = list.body.conversations.find((r: { id: string }) => r.id === key);
    expect(row).toBeTruthy(); expect(row.creationSource).toBeUndefined(); expect(row.parentConversationKey).toBeUndefined(); expect(row.hierarchyState).toBeUndefined();
    const events = await e.sign('GET', `/mobile/chat/app/${key}/events`, undefined, device, p.device.id);
    expect(events.status).toBe(200); expect(events.body.events[0].creationContext).toBeUndefined();
    expect((await e.sign('GET', '/mobile/conversations/parent-preview', undefined, device, p.device.id)).status).toBe(403);
  });
  it('serves a read-only owner preview independently of graph readiness and preserves explicit placement', async () => {
    const e = setup(); const key = e.add();
    e.setSource({ ...e.source(), cardEvidence: [{ conversationKey: key, cardId: 'wc_0123456789abcdef', creationContext: { v: 1, source: { kind: 'work-board-card', cardId: 'wc_0123456789abcdef', sourceConversationKey: 'telegram:7' } }, conflict: false }] });
    await e.projection.settled(e.scope()); await e.projection.settled(e.scope(`device:${e.ownerId}`));
    const append = vi.spyOn(e.svc.store, 'append'); const generation = e.svc.store.getCreationGeneration();
    const preview = await e.sign('GET', '/mobile/conversations/parent-preview');
    expect(preview.status).toBe(200); expect(preview.body).toMatchObject({ dryRun: true, canApply: false });
    expect(preview.body.rows.find((r: { conversationRef: string }) => r.conversationRef === `app:${key}`)).toMatchObject({ action: 'would-place', proposedParentConversationKey: 'telegram:7' });
    expect(append).not.toHaveBeenCalled(); expect(e.svc.store.getCreationGeneration()).toBe(generation);
    e.setSource({ ...e.source(), version: 'new-placement', parents: new Map([[`app:${key}`, null]]) });
    await e.projection.settled(e.scope());
    const updated = await e.bearer('/mobile/conversations/parent-preview');
    expect(updated.body.rows.find((r: { conversationRef: string }) => r.conversationRef === `app:${key}`)).toMatchObject({ action: 'keep-current', currentParentConversationKey: null });
  });
  it('a multirow warm list captures the placement source once per response', async () => {
    const e = setup(); for (let i = 0; i < 12; i++) e.add(sessionContext('telegram:7'));
    await e.projection.settled(e.scope()); e.sourceReads.mockClear();
    const response = await e.bearer('/mobile/conversations?limit=200');
    expect(response.status).toBe(200);
    expect(response.body.conversations.filter((row: { platform: string }) => row.platform === 'app')).toHaveLength(12);
    expect(e.sourceReads).toHaveBeenCalledTimes(1);
  });
  it('completed create retries recheck the current child audience and never resurrect deleted children', async () => {
    const e = setup(); const requestId = `${Date.now()}-${crypto.randomUUID()}`; const body = { title: 'Owner private chat', requestId };
    const created = await e.sign('POST', '/mobile/conversations', body); expect(created.status).toBe(200);
    e.pairing.devices.setPerson(e.ownerId, { role: 'msp', userId: 'member' });
    const denied = await e.sign('POST', '/mobile/conversations', body);
    expect(denied.status).toBe(404); expect(denied.body.conversationKey).toBeUndefined(); expect(denied.body.title).toBeUndefined();
    e.pairing.devices.setPerson(e.ownerId, { role: 'owner', userId: null });
    e.svc.applyDelete('test', 'delete-child', created.body.conversationKey);
    const deleted = await e.sign('POST', '/mobile/conversations', body);
    expect(deleted.status).toBe(404); expect(e.svc.liveConversation(created.body.conversationKey)).toBeFalsy();
  });
  it('invalid pages are refused and unauthenticated preview cannot reach the handler', async () => {
    const e = setup();
    expect((await request(e.app).get('/mobile/conversations/parent-preview')).status).toBe(401);
    expect((await e.bearer('/mobile/conversations/parent-preview?limit[]=3')).status).toBe(400);
    expect((await e.bearer('/mobile/conversations/parent-preview?cursor[]=x')).status).toBe(400);
  });
});

it('projects confirmed membership through readable ancestry independently of graph groups', async () => {
  const e = setup();
  const parent = e.add(sessionContext('telegram:7'));
  const child = e.add(sessionContext(`app:${parent}`));
  e.setSource({ ...e.source(), version: 'confirmed-project', confirmedProjects: new Set(['telegram:7']),
    parents: new Map([[`app:${parent}`, 'telegram:7'], [`app:${child}`, `app:${parent}`]]) });
  const reply = await e.sign('GET', '/mobile/conversations');
  expect(reply.status).toBe(200);
  expect(reply.body.conversations).toEqual(expect.arrayContaining([
    expect.objectContaining({ platform: 'telegram', projectConversationKey: 'telegram:7' }),
    expect.objectContaining({ id: parent, projectConversationKey: 'telegram:7' }),
    expect.objectContaining({ id: child, projectConversationKey: 'telegram:7' }),
  ]));
  e.setSource({ ...e.source(), version: 'incomplete-projects', complete: false });
  const partial = await e.sign('GET', '/mobile/conversations');
  expect(partial.status).toBe(200);
  expect(partial.body.conversations.every((row: { projectConversationKey?: string }) => row.projectConversationKey === undefined)).toBe(true);
});
