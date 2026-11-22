// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * A member's computer joining from the owner's team invite, no app needed
 * (docs/specs/member-browser-any-computer.md), on a REAL AgentServer booted on its production path:
 * real pairing, a real team log, real device signatures. The owner invites as today; the link carries
 * j=1; the computer redeems it, the owner's phone reads the code in People, the computer confirms with
 * its own key, then opens and comments on a document through the real page routes. Forget ends it, and
 * its earlier comment still verifies. On a fleet config the join routes answer 503.
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
import { joinConfirmString, joinForgetString } from '../../src/server/documentJoinRoutes.js';
import { deviceKeyHashOf } from '../../src/core/AppRecordSignatures.js';

const HOST = 'echo-join-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/documents-join.test.ts' });
});

type Dev = ReturnType<typeof makeDevice>;
let clock = Date.now();
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

async function boot(opts: { privacy?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'docjoin-e2e-'));
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


/** Join a fresh computer for this person from a new owner invite, exactly as the join page does. */
async function joinComputer(w: Awaited<ReturnType<typeof world>>, personKey: string) {
  const { app, owner } = w;
  const inv = await owner('POST', '/mobile/team/invites', { existingPersonKey: personKey });
  expect(inv.status, JSON.stringify(inv.body)).toBe(200);
  expect(String(inv.body.link)).toContain('&j=1');
  const code = new URLSearchParams(String(inv.body.link).split('#')[1]).get('c');
  const comp = makeDevice();
  const red = await request(app).post('/docs/_join/redeem').set('Host', HOST).set('X-Forwarded-Proto', 'https').set('X-Instar-Request', '1')
    .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0').send({ code, browserPublicKey: comp.publicKey });
  expect(red.status, JSON.stringify(red.body)).toBe(200);
  const deviceId = red.body.deviceId as string;
  // The owner's People screen shows the waiting computer and its code, named by the server.
  const waiting = await owner('GET', `/mobile/team/invites/${personKey}`);
  const entry = waiting.body.waiting.find((x: { deviceId: string }) => x.deviceId === deviceId);
  expect(entry.deviceName).toMatch(/^Computer [0-9A-F]{4}-[0-9A-F]{4}, Chrome on Windows, from /);
  const typed = String(entry.code).replace(/\s/g, '');
  const timeMs = String(Date.now());
  const conf = await request(app).post('/docs/_join/confirm').set('Host', HOST).set('X-Forwarded-Proto', 'https').set('X-Instar-Request', '1')
    .send({ deviceId, code: typed, timeMs, sig: comp.sign(joinConfirmString(deviceId, HOST, timeMs, typed)) });
  expect(conf.status, JSON.stringify(conf.body)).toBe(200);
  expect(conf.body.status).toBe('active');
  return { comp, id: deviceId };
}

describe('a computer joins from the owner\'s team invite — feature is alive on a real server', () => {
  it('joins, opens and comments on a document; other device routes refuse it; Forget ends it and its comment still verifies', async () => {
    const w = await world();
    const { app, docId, server } = w;
    const shell = await request(app).get('/docs/_join').set('Host', HOST);
    expect(shell.status).toBe(200);
    expect(shell.headers['content-security-policy']).toContain("script-src 'self'");
    expect((await request(app).get('/docs/_assets/join-page.js').set('Host', HOST)).status).toBe(200);

    const { comp, id } = await joinComputer(w, 'mia');
    const kh = deviceKeyHashOf(comp.publicKey);
    expect(server.mobilePairing!.teamLog()!.state().computerLinks.get(kh)).toMatchObject({ boundTo: 'mia', scope: 'documents' });
    expect(server.mobilePairing!.devices.get(id)).toMatchObject({ status: 'active', approvedVia: 'team-invite', joinedVia: 'team-invite' });

    const page = docpage(app, id, comp);
    const sess = await request(app).post(`/docs/${docId}/session`);
    expect(sess.status).toBe(403); // no request header, no key
    const cookie = await page.open(docId);
    expect(cookie).toBeTruthy();
    const data = await page.pageData(docId, cookie!);
    expect(data.status).toBe(200);
    expect(data.body.me).toMatchObject({ key: 'mia', canComment: true });
    const c = await page.comment(docId, data.body, 'From my computer');
    expect(c.status, JSON.stringify(c.body)).toBe(201);

    // Device routes beyond the Send template stay closed to it.
    const call = client(app, id, comp);
    expect((await call('GET', '/mobile/conversations')).status).toBe(403);

    // As a peer re-checks a pulled row: the joined computer's comment verifies.
    const store = (server as any).documents.store;
    const originCheck = (row: unknown) => store.opts.origin(row, new Set());
    const row = store.rowsOf(docId).find((r: { actor: { type: string; deviceId?: string } }) => r.actor.type === 'person' && r.actor.deviceId === id);
    expect(row).toBeTruthy();
    expect(originCheck(row)).toBe('ok');

    // The agent lists it, and Forget (signed by the computer itself) ends it everywhere.
    const listed = await w.auth(request(app).get('/team/computers'));
    expect(listed.body.people.find((p: { personKey: string }) => p.personKey === 'mia').computers.map((x: { deviceId: string }) => x.deviceId)).toContain(id);
    const t = String(Date.now());
    const f = await request(app).post('/docs/_link/forget-self').set('Host', HOST).set('X-Instar-Request', '1').send({ deviceId: id, timeMs: t, sig: comp.sign(joinForgetString(id, HOST, t)) });
    expect(f.body).toEqual({ ok: true });
    expect(await page.open(docId)).toBeNull();
    // The comment written while it stood still verifies at the team position it was accepted at;
    // the same write stamped after the Forget does not.
    expect(originCheck(row)).toBe('ok');
    expect(originCheck({ ...row, access: server.mobilePairing!.teamLog()!.vector() })).toBe('denied');
  });

  it('a guest\'s joined computer reads but never writes', async () => {
    const w = await world();
    const { comp, id } = await joinComputer(w, 'gus');
    const page = docpage(w.app, id, comp);
    const cookie = await page.open(w.docId);
    expect(cookie).toBeTruthy();
    const data = await page.pageData(w.docId, cookie!);
    expect(data.body.me).toMatchObject({ key: 'gus', canComment: false });
    expect((await page.comment(w.docId, data.body)).status).toBe(403);
  });

  it('SEC-169: the public way-back list is empty until a computer is set up, then names only that address', async () => {
    const w = await world();
    const list = async () => {
      const r = await request(w.app).get('/docs/_join/addresses').set('Host', HOST);
      expect(r.status).toBe(200);
      return r.body.addresses as string[];
    };
    // No computer set up anywhere: an anonymous caller is told no machine address.
    expect(await list()).toEqual([]);
    await joinComputer(w, 'mia');
    expect(await list()).toEqual([`https://${HOST}`]);
  });

  it('with documents off, the join routes answer 503 and team links carry no j=1', async () => {
    const w = await world();
    (w.config as unknown as { documents?: { enabled?: boolean } }).documents = { enabled: false };
    expect((await request(w.app).get('/docs/_join').set('Host', HOST)).status).toBe(503);
    expect((await request(w.app).post('/docs/_join/redeem').set('Host', HOST).set('X-Instar-Request', '1').send({})).status).toBe(503);
    const inv = await w.owner('POST', '/mobile/team/invites', { existingPersonKey: 'mia' });
    expect(String(inv.body.link)).not.toContain('&j=1');
  });
});
