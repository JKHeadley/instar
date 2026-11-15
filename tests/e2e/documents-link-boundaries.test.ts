// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * The privilege boundaries of a member's linked computer (instar-document-viewer §3.6a), on a REAL
 * AgentServer booted on its production path: real pairing, a real team log, real device signatures
 * (instar-device-v1 and instar-docpage-v1), the real device authenticator and document page routes.
 * Nothing here mocks personOfDevice: every verdict is a real request.
 *
 *   - a linked computer may not call another device route, nor send anything but the exact template;
 *   - a guest's linked computer reads but never writes;
 *   - a computer this machine does not hold locally (the replicated-link path) is refused after
 *     phone revocation, link expiry, the browser switch going off, or person removal;
 *   - a member lowered to guest loses the computer's writes and its send;
 *   - an owner phone linking gets member-phone-required;
 *   - with documents off, /docs/_link/* and /mobile/browsers* answer 503.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { docpageString } from '../../src/documents/docpageAuth.js';
import { blobHash } from '../../src/documents/blobs.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { commentKeysHashOf } from '../../src/documents/originCheck.js';

const HOST = 'echo-doclink-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/documents-link-boundaries.test.ts' });
});

type Dev = ReturnType<typeof makeDevice>;
let clock = Date.now();
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

async function boot(opts: { privacy?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'doclink-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'users.json'), '[]');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'doclink-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } }, tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, threadline: { ownerName: 'Ann' },
    ...(opts.privacy ? { memoryPrivacy: { enabled: true } } : {}),
  } as unknown as InstarConfig;
  // Confined session tokens (a session serving one conversation), as the live proof issues them.
  const memoryPrivacy = opts.privacy ? new MemoryPrivacy({ stateDir, instarRoot: path.join(dir, 'instar-root'), agentId: 'doclink-e2e', config: () => ({ enabled: true }), users: () => [], reachable: () => ({}) }) : undefined;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const spawned: string[] = [];
  sessionManager.spawnInteractiveSession = async (message: string) => { spawned.push(message); return 'app-session-1'; };
  sessionManager.injectMessage = () => true;
  sessionManager.memoryPrivacyStatus = () => ({ enabled: true, sandboxReady: true, multiPerson: false, ownerUserId: null, blocker: null, fix: null });
  sessionManager.applyConversationChange = async (_ref: string, change: () => unknown) => change();
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, meshSelfId: 'm_e2e', ...(memoryPrivacy ? { memoryPrivacy } : {}) } as never);
  servers.push(server);
  const app = server.getApp();
  const dms: string[] = [];
  server.mobilePairing!.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
  server.mobilePairing!.deps.telegramOwnerPresent = () => true;
  return { server, app, config, dms, spawned, memoryPrivacy };
}

/** A device-signed (instar-device-v1) client for a phone or a linked computer. */
function client(app: Parameters<typeof request>[0], deviceId: string, dev: Dev) {
  return (method: 'GET' | 'POST' | 'DELETE', p: string, body?: unknown) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const time = String(++clock);
    const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
    const q = method === 'GET' ? request(app).get(p) : (method === 'DELETE' ? request(app).delete(p) : request(app).post(p)).set('Content-Type', 'application/json');
    // As through the tunnel: TLS ends at cloudflared on this machine.
    q.set('Host', HOST).set('X-Forwarded-Proto', 'https').set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    return raw ? q.send(raw.toString()) : q;
  };
}

/** The page's own signed requests (instar-docpage-v1), as dashboard/docs/doc-page.js makes them. */
function docpage(app: Parameters<typeof request>[0], deviceId: string, dev: Dev) {
  const headers = (docId: string, op: string, payload: Record<string, unknown>) => {
    const requestId = rid();
    const timeMs = String(Date.now());
    const sig = dev.sign(docpageString(deviceId, HOST, docId, op as never, requestId, timeMs, payload));
    return { Host: HOST, 'X-Instar-Device': deviceId, 'X-Instar-Device-Time': timeMs, 'X-Instar-Docpage-Sig': sig, 'X-Instar-Request-Id': requestId, 'X-Instar-Docpage-Payload': Buffer.from(JSON.stringify(payload)).toString('base64url'), 'X-Instar-Request': '1' };
  };
  return {
    /** Trade a signed `open` for the read cookie; null when refused. */
    async open(docId: string): Promise<string | null> {
      const r = await request(app).post(`/docs/${docId}/session`).set(headers(docId, 'open', { docId })).set('Content-Type', 'application/json').send('{}');
      return r.status === 200 ? String(r.headers['set-cookie'][0]).split(';')[0] : null;
    },
    pageData: (docId: string, cookie: string) => request(app).get(`/docs/${docId}/page-data`).set('Host', HOST).set('Cookie', cookie),
    /** A signed comment on the first paragraph. */
    async comment(docId: string, page: { version: { id: string }; blocks: Array<{ start: number }> }, text = 'A thought') {
      const salt = crypto.randomBytes(16).toString('hex');
      const para = page.blocks[1];
      const payload = { docId, commentId: crypto.randomUUID(), onVersion: page.version.id, start: para.start, end: para.start + 4, bodyHash: blobHash(salt, text) };
      return request(app).post(`/docs/${docId}/w/comment`).set(headers(docId, 'comment', payload)).set('Content-Type', 'application/json').send({ blobs: [{ salt, text }] });
    },
    /** The signed `send` row for this person's open comments, as the page writes it after the message. */
    send(docId: string, page: { primary: { primaryRow: string | null }; comments: Array<{ key: string; mine: boolean; resolved: boolean }> }) {
      const batchId = rid();
      const keys = page.comments.filter((c) => c.mine && !c.resolved).map((c) => c.key);
      const payload = { docId, batchId, commentKeysHash: commentKeysHashOf(keys), primaryRow: page.primary.primaryRow, messageRequestId: batchId };
      return request(app).post(`/docs/${docId}/w/send`).set(headers(docId, 'send', payload)).set('Content-Type', 'application/json').send({});
    },
  };
}

async function world(opts: { privacy?: boolean } = {}) {
  const b = await boot(opts);
  const { server, app, dms } = b;
  const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'doclink-e2e');
  // The owner's phone.
  const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
  const ownerDev = makeDevice();
  const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'Ann phone', devicePublicKey: ownerDev.publicKey });
  const ownerId = r.body.deviceId as string;
  const owner = client(app, ownerId, ownerDev);
  expect((await owner('POST', '/mobile/device/confirm', { code: /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('') })).body.status).toBe('active');
  const presence = makeDevice();
  server.mobilePairing!.devices.setPresenceKey(ownerId, presence.publicKey);
  const shared = (await owner('POST', '/mobile/conversations', { title: 'Client work', requestId: rid() })).body.conversationKey as string;
  expect(shared).toBeTruthy();

  // A member and a guest, both given the shared conversation.
  const invite = async (events: unknown[]) => {
    const inv = await owner('POST', '/mobile/team/invites', { events });
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    return new URLSearchParams(String(inv.body.link).split('#')[1]).get('c');
  };
  const pairPerson = async (personKey: string, code: string | null) => {
    const dev = makeDevice();
    const red = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code, deviceName: `${personKey} phone`, devicePublicKey: dev.publicKey, appCaps: ['standing'] });
    expect(red.status).toBe(200);
    const waiting = await owner('GET', `/mobile/team/invites/${personKey}`);
    const c = client(app, red.body.deviceId, dev);
    expect((await c('POST', '/mobile/device/confirm', { code: waiting.body.waiting[0].code.replace(/\s/g, '') })).body.status).toBe('active');
    return { id: red.body.deviceId as string, dev, call: c };
  };
  const miaCode = await invite([
    { type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' },
    { type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' },
    { type: 'grant', personKey: 'mia', ref: shared, access: 'use' },
  ]);
  const mia = await pairPerson('mia', miaCode);
  const gusCode = await invite([
    { type: 'person-add', personKey: 'gus', name: 'Gus', role: 'guest' },
    { type: 'grant', personKey: 'gus', ref: shared, access: 'read' },
  ]);
  const gus = await pairPerson('gus', gusCode);

  // A document, moved into the shared conversation by the owner's phone with Face ID (§3.2).
  const doc = await auth(request(app).post('/docs')).send({ title: 'Plan', markdown: '# Plan\n\nWe ship the viewer on Friday.\n', primary: 'telegram:7' });
  expect(doc.status, JSON.stringify(doc.body)).toBe(201);
  const docId0 = doc.body.id as string;
  const primary = `app:${shared}`;
  const docDeps = (await owner('GET', `/mobile/docs/${docId0}/summary`)).body.heads as Record<string, number>;
  const ch = await owner('POST', `/mobile/docs/${docId0}/primary/challenge`, { primary, docDeps });
  expect(ch.status, JSON.stringify(ch.body)).toBe(200);
  const line = `docs-primary-set ${docId0} ${primary} ${crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(docDeps).sort()))).digest('hex')}`;
  const moved = await owner('POST', `/mobile/docs/${docId0}/primary`, { primary, docDeps, challenge: ch.body.challenge, presenceSig: presence.sign(permissionPresenceMessage(ownerId, HOST, ch.body.challenge, line)) });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);

  /** Link a fresh computer for this phone, exactly as the page and the app do. */
  const linkComputer = async (phone: { call: ReturnType<typeof client> }, expiresInMs = 30 * 86_400_000) => {
    const comp = makeDevice();
    const n = await request(app).post('/docs/_link/nonce').set('Host', HOST).set('X-Instar-Request', '1').set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/132.0').send({ browserPublicKey: comp.publicKey });
    expect(n.status, JSON.stringify(n.body)).toBe(200);
    const l = await phone.call('POST', '/mobile/browsers/link', { browserPublicKey: comp.publicKey, nonce: n.body.nonce, machineId: n.body.machineId, host: HOST, expiresAt: new Date(Date.now() + expiresInMs).toISOString() });
    return { l, comp, id: l.body.id as string, nonce: n.body.nonce as string };
  };
  return { ...b, auth, owner, ownerId, shared, mia, gus, docId: doc.body.id as string, linkComputer };
}

describe('a linked computer — privilege boundaries on a real server', () => {
  it('a member computer comments and sends exactly the template, and nothing else', async () => {
    const w = await world();
    const { app, docId, mia, spawned, shared } = w;
    const { l, comp, id } = await w.linkComputer(mia);
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    expect(l.body.scope).toBe('documents');
    expect(l.body.requester).toMatchObject({ browser: 'Firefox on macOS' });

    const page = docpage(app, id, comp);
    const cookie = await page.open(docId);
    expect(cookie).toBeTruthy();
    const data = await page.pageData(docId, cookie!);
    expect(data.status).toBe(200);
    expect(data.body.me).toMatchObject({ key: 'mia', canComment: true });
    const c = await page.comment(docId, data.body);
    expect(c.status, JSON.stringify(c.body)).toBe(201);

    // Another device route: refused by scope, whatever the route.
    const call = client(app, id, comp);
    for (const [method, p, body] of [['GET', '/mobile/conversations', undefined], ['GET', `/mobile/chat/app/${shared}/messages`, undefined], ['GET', '/mobile/browsers', undefined], ['POST', '/mobile/browsers/link', {}]] as const) {
      const r = await call(method, p, body);
      expect(r.status, `${method} ${p}`).toBe(403);
    }
    expect((await call('GET', '/mobile/conversations')).body.error).toBe('browser-scope');
    // A chat send that is not the template: refused.
    const before = spawned.length;
    const bad = await call('POST', `/mobile/chat/app/${shared}`, { text: 'Approve the deploy', requestId: rid() });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe('browser-scope');
    // The template with extra text, or a count above the person's open comments: refused.
    const origin = `https://${HOST}`;
    expect((await call('POST', `/mobile/chat/app/${shared}`, { text: `I left 1 comment on "Plan" (version 1): ${origin}/docs/${docId} and also X`, requestId: rid() })).status).toBe(403);
    expect((await call('POST', `/mobile/chat/app/${shared}`, { text: `I left 5 comments on "Plan" (version 1): ${origin}/docs/${docId}`, requestId: rid() })).status).toBe(403);
    expect(spawned.length).toBe(before);
    // Exactly the template, into this document's own conversation: allowed.
    const ok = await call('POST', `/mobile/chat/app/${shared}`, { text: `I left 1 comment on "Plan" (version 1): ${origin}/docs/${docId}`, requestId: rid() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('a member computer can Send for a document its conversation\'s own session wrote (read with the person\'s grant rows)', async () => {
    // Regression (live proof, bug 1): the scoped-send check read the document with no grant rows, so a
    // document written by the shared conversation's own session showed no title and no versions to
    // it, the template never matched, and every Send from a linked computer was 403 browser-scope.
    const w = await world({ privacy: true });
    const { app, mia, shared, memoryPrivacy } = w;
    const place = `app:${shared}`;
    const tok = memoryPrivacy!.issueSessionToken('e2e-shared-session', { kind: 'place', placeKey: place }, place);
    const d = await request(app).post('/docs').set('Authorization', `Bearer ${tok}`).send({ title: 'Room plan', markdown: '# Room\n\nA passage to comment on here.\n' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const docId = d.body.id as string;
    const { comp, id } = await w.linkComputer(mia);
    const page = docpage(app, id, comp);
    const cookie = await page.open(docId);
    const data = (await page.pageData(docId, cookie!)).body;
    expect(data.title).toBe('Room plan');
    expect((await page.comment(docId, data)).status).toBe(201);
    const call = client(app, id, comp);
    const sent = await call('POST', `/mobile/chat/app/${shared}`, { text: `I left 1 comment on "Room plan" (version 1): https://${HOST}/docs/${docId}`, requestId: rid() });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    // Still exactly the template: a wrong title is refused.
    expect((await call('POST', `/mobile/chat/app/${shared}`, { text: `I left 1 comment on "Other" (version 1): https://${HOST}/docs/${docId}`, requestId: rid() })).status).toBe(403);
  });

  it('a removed primary conversation: page data reports it missing, Send is off and refused by the server', async () => {
    // Regression (live proof, bug 3): after the owner deleted the conversation, page data still named
    // it, so the page never showed the removed state and Send stayed enabled.
    const w = await world({ privacy: true });
    const { app, mia, owner, memoryPrivacy } = w;
    const conv = await owner('POST', '/mobile/conversations', { title: 'Temp room', requestId: rid() });
    const key = conv.body.conversationKey as string;
    expect((await owner('POST', '/mobile/team/grants', { events: [{ type: 'grant', personKey: 'mia', ref: key, access: 'use' }] })).status).toBe(200);
    const tok = memoryPrivacy!.issueSessionToken('e2e-temp-session', { kind: 'place', placeKey: `app:${key}` }, `app:${key}`);
    const d = await request(app).post('/docs').set('Authorization', `Bearer ${tok}`).send({ title: 'Temp doc', markdown: '# Temp\n\nA passage to comment on here.\n' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const docId = d.body.id as string;
    const { comp, id } = await w.linkComputer(mia);
    const page = docpage(app, id, comp);
    const cookie = await page.open(docId);
    const before = (await page.pageData(docId, cookie!)).body;
    expect(before.primary).toMatchObject({ ref: `app:${key}`, sendPath: `/mobile/chat/app/${key}` });
    expect(before.primary.removed).toBeUndefined();
    expect((await page.comment(docId, before)).status).toBe(201);
    const del = await owner('DELETE', `/mobile/conversations/${key}`, { requestId: rid() });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    const after = (await page.pageData(docId, cookie!)).body;
    expect(after.primary).toMatchObject({ ref: null, removed: true, removedRef: `app:${key}`, sendPath: null, name: null });
    expect(after.me.canSend).toBe(false);
    const s = await page.send(docId, after);
    expect(s.status, JSON.stringify(s.body)).toBe(409);
    expect(s.body.error).toBe('conversation-removed');
    const call = client(app, id, comp);
    expect((await call('POST', `/mobile/chat/app/${key}`, { text: `I left 1 comment on "Temp doc" (version 1): https://${HOST}/docs/${docId}`, requestId: rid() })).status).toBeGreaterThanOrEqual(400);
  });

  it('a forgotten computer\'s earlier rows still verify against the team position they were accepted at; a row stamped after the forget does not', async () => {
    // Regression (live proof, bug 4): a peer pulling after the revocation refused, with reason
    // `origin`, every row the computer wrote while it was linked, so machines diverged.
    const w = await world();
    const { app, docId, mia, server } = w;
    const { comp, id } = await w.linkComputer(mia);
    const page = docpage(app, id, comp);
    const cookie = await page.open(docId);
    expect((await page.comment(docId, (await page.pageData(docId, cookie!)).body)).status).toBe(201);
    const store = (server as any).documents.store;
    const originCheck = (row: unknown) => store.opts.origin(row, new Set());
    const row = store.rowsOf(docId).find((r: { actor: { type: string; deviceId?: string } }) => r.actor.type === 'person' && r.actor.deviceId === id);
    expect(row).toBeTruthy();
    expect(originCheck(row)).toBe('ok');
    expect((await mia.call('POST', `/mobile/browsers/${id}/forget`, {})).status).toBe(200);
    expect(await page.open(docId)).toBeNull();
    // As a peer that pulls after the forget re-checks it: accepted, at the position in its `access`.
    expect(originCheck(row)).toBe('ok');
    // The same signed write stamped at a team position that includes the forget: refused.
    const later = { ...row, access: server.mobilePairing!.teamLog()!.vector() };
    expect(originCheck(later)).toBe('denied');
  });

  it('a guest computer reads but never writes; an owner phone cannot link', async () => {
    const w = await world();
    const { app, docId, gus, owner } = w;
    const { l, comp, id } = await w.linkComputer(gus);
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    expect(l.body.scope).toBe('documents-read');
    const page = docpage(app, id, comp);
    const cookie = await page.open(docId);
    const data = await page.pageData(docId, cookie!);
    expect(data.status).toBe(200);
    const c = await page.comment(docId, data.body);
    expect(c.status).toBe(403);
    expect(c.body.error).toBe('read-only-computer');
    // Not even the template send.
    const call = client(app, id, comp);
    expect((await call('POST', `/mobile/chat/app/${w.shared}`, { text: `I left 1 comment on "Plan" (version 1): https://${HOST}/docs/${docId}`, requestId: rid() })).status).toBe(403);

    // The owner links computers through the console's own flow, never this one.
    const comp2 = makeDevice();
    const n = await request(app).post('/docs/_link/nonce').set('Host', HOST).set('X-Instar-Request', '1').send({ browserPublicKey: comp2.publicKey });
    const r = await owner('POST', '/mobile/browsers/link', { browserPublicKey: comp2.publicKey, nonce: n.body.nonce, machineId: n.body.machineId, host: HOST, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('member-phone-required');
    expect((await owner('POST', '/mobile/browsers/link/lookup', { nonce: n.body.nonce, browserPublicKey: comp2.publicKey })).body.error).toBe('member-phone-required');
  });

  it('a member lowered to guest: the computer loses its writes and its send', async () => {
    const w = await world();
    const { app, docId, mia, auth } = w;
    const { comp, id } = await w.linkComputer(mia);
    const page = docpage(app, id, comp);
    const cookie = await page.open(docId);
    const data = (await page.pageData(docId, cookie!)).body;
    expect((await page.comment(docId, data)).status).toBe(201);
    expect((await auth(request(app).post('/team/people/mia/lower')).send({ role: 'guest' })).status).toBe(200);
    expect(w.server.mobilePairing!.teamStanding('mia')?.tier).toBe('guest');
    const after = await page.comment(docId, data, 'Another');
    expect(after.status).toBeGreaterThanOrEqual(400);
    expect(after.status).toBeLessThan(500);
    const call = client(app, id, comp);
    expect((await call('POST', `/mobile/chat/app/${w.shared}`, { text: `I left 1 comment on "Plan" (version 1): https://${HOST}/docs/${docId}`, requestId: rid() })).status).toBe(403);
  });

  it('a computer this machine does not hold is checked from the replicated link, and refused once it lapses', async () => {
    const w = await world();
    const { app, docId, mia, server, config } = w;
    const svc = server.mobilePairing!;
    /** Link, then drop the local record: this machine now knows the computer only from the team log and ledger. */
    const remoteComputer = async (expiresInMs?: number) => {
      const c = await w.linkComputer(mia, expiresInMs);
      expect(c.l.status, JSON.stringify(c.l.body)).toBe(201);
      svc.devices.remove(c.id);
      expect(svc.devices.get(c.id)).toBeNull();
      return { ...c, page: docpage(app, c.id, c.comp) };
    };
    const works = async (p: ReturnType<typeof docpage>) => {
      const cookie = await p.open(docId);
      if (!cookie) return false;
      const d = await p.pageData(docId, cookie);
      if (d.status !== 200) return false;
      return (await p.comment(docId, d.body)).status === 201;
    };

    // Valid: reads and writes through the replicated-link path.
    const a = await remoteComputer();
    expect(await works(a.page)).toBe(true);

    // The browser switch off: refused; on again: works.
    const cfg = config as unknown as { mobilePairing: Record<string, unknown> };
    cfg.mobilePairing.browser = { enabled: false };
    expect(svc.browserOn()).toBe(false);
    expect(await a.page.open(docId)).toBeNull();
    delete cfg.mobilePairing.browser;
    expect(await works(a.page)).toBe(true);

    // Link expiry.
    const b = await remoteComputer(1_500);
    expect(await b.page.open(docId)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1_700));
    expect(await b.page.open(docId)).toBeNull();

    // The linking phone revoked: every computer it linked is refused here.
    svc.keyLedger!.recordRevocation(svc.devices.get(mia.id)!, new Date().toISOString());
    svc.devices.revoke(mia.id);
    expect(await a.page.open(docId)).toBeNull();
  });

  it('a removed person: a computer this machine does not hold is refused', async () => {
    const w = await world();
    const { app, docId, mia, server, auth } = w;
    const c = await w.linkComputer(mia);
    server.mobilePairing!.devices.remove(c.id);
    const page = docpage(app, c.id, c.comp);
    expect(await page.open(docId)).toBeTruthy();
    expect((await auth(request(app).post('/team/people/mia/lower')).send({ remove: true })).status).toBe(200);
    expect(await page.open(docId)).toBeNull();
  });

  it('the expiry sweep also runs when team phones are reconciled', async () => {
    const w = await world();
    const c = await w.linkComputer(w.mia, 1_200);
    expect(w.server.mobilePairing!.devices.get(c.id)!.status).toBe('active');
    await new Promise((r) => setTimeout(r, 1_400));
    w.server.mobilePairing!.reconcileTeamPhones();
    expect(w.server.mobilePairing!.devices.get(c.id)!.status).toBe('revoked');
    expect(w.server.mobilePairing!.teamLog()!.state().browserLinks.get([...w.server.mobilePairing!.teamLog()!.state().browserLinks.keys()][0]!)!.unbound).toBe(true);
  });

  it('with documents off, the link routes answer 503', async () => {
    const w = await world();
    const { app, mia, config } = w;
    (config as unknown as Record<string, unknown>).documents = { enabled: false };
    expect((await request(app).post('/docs/_link/nonce').set('Host', HOST).set('X-Instar-Request', '1').send({ browserPublicKey: makeDevice().publicKey })).status).toBe(503);
    expect((await request(app).post('/docs/_link/status').set('Host', HOST).set('X-Instar-Request', '1').send({ nonce: 'x' })).status).toBe(503);
    expect((await mia.call('GET', '/mobile/browsers')).status).toBe(503);
    expect((await mia.call('POST', '/mobile/browsers/link', { nonce: 'x' })).status).toBe(503);
    expect((await mia.call('POST', '/mobile/browsers/link/lookup', { nonce: 'x' })).status).toBe(503);
    expect((await mia.call('POST', `/mobile/browsers/${crypto.randomUUID()}/forget`, {})).status).toBe(503);
  });
});
