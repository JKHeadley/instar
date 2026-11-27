/**
 * Two real servers, one agent (team-roles-and-access, "Step 2b"). They exchange access rows over the
 * real signed machine route, reach the same answer, and a removal made on one machine reaches a phone
 * paired on the other. Each server's exchange is driven by hand here; production runs it every minute.
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
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager, generateMachineId, generateSigningKeyPair, generateEncryptionKeyPair } from '../../src/core/MachineIdentity.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';
import type { InstarConfig } from '../../src/core/types.js';

const HOST = 'echo-team-two.example.dev';
const servers: AgentServer[] = [];
const coords: MultiMachineCoordinator[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const c of coords) c.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/team-access-two-machines.test.ts' });
});

const pem = (k: string) => k.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');

function machine(name: string, role: 'awake' | 'standby') {
  const stateDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), `team-two-${name}-`));
  dirs.push(stateDir);
  for (const d of ['state/sessions', 'state/jobs', 'logs', 'machine']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'users.json'), '[]');
  const mgr = new MachineIdentityManager(stateDir);
  const signing = generateSigningKeyPair();
  const encryption = generateEncryptionKeyPair();
  const identity = {
    machineId: generateMachineId(), signingPublicKey: pem(signing.publicKey), encryptionPublicKey: pem(encryption.publicKey), name,
    platform: `${os.platform()}-${os.arch()}`, createdAt: new Date().toISOString(), capabilities: ['sessions'] as string[],
  };
  fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
  fs.writeFileSync(path.join(stateDir, 'machine', 'signing-private.pem'), signing.privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, 'machine', 'encryption-private.pem'), encryption.privateKey, { mode: 0o600 });
  mgr.registerMachine(identity as never, role);
  return { stateDir, mgr, identity, signing };
}
type Machine = ReturnType<typeof machine>;

async function serve(m: Machine, peers: () => Array<{ machineId: string; url: string; kind: 'lan' }>) {
  const config = {
    projectName: 'team-two', projectDir: m.stateDir, stateDir: m.stateDir, port: 0, host: '127.0.0.1', authToken: 'two-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } }, tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, threadline: { ownerName: 'Ann' },
  } as unknown as InstarConfig;
  const state = new StateManager(m.stateDir);
  const coordinator = new MultiMachineCoordinator(state, { stateDir: m.stateDir });
  coordinator.start();
  coords.push(coordinator);
  const changed: string[] = [];
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  sessionManager.spawnInteractiveSession = async () => 'app-session-1';
  sessionManager.injectMessage = () => true;
  sessionManager.memoryPrivacyStatus = () => ({ enabled: true, sandboxReady: true, multiPerson: false, ownerUserId: null, blocker: null, fix: null });
  sessionManager.applyConversationChange = async (ref: string, change: () => unknown) => { changed.push(ref); return change(); };
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({
    config, sessionManager, state, initiativeTracker: new InitiativeTracker(m.stateDir), tunnel, coordinator,
    localSigningKeyPem: m.signing.privateKey, resolvePeerUrls: peers,
  } as never);
  servers.push(server);
  await server.start();
  const app = server.getApp();
  const dms: string[] = [];
  server.mobilePairing!.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
  server.mobilePairing!.deps.telegramOwnerPresent = () => true;
  return { server, app, dms, changed, base: boundAgentServerBase(server) };
}

let clock = Date.now();
function client(app: Parameters<typeof request>[0], deviceId: string, dev: ReturnType<typeof makeDevice>) {
  return (method: 'GET' | 'POST', p: string, body?: unknown) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const time = String(++clock);
    const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
    const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
    q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    return raw ? q.send(raw.toString()) : q;
  };
}
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

describe('team access on two machines', () => {
  it('rows cross over the real signed route, both reach one answer, and a removal on one revokes a phone on the other', async () => {
    const a = machine('studio', 'awake');
    const b = machine('laptop', 'standby');
    a.mgr.registerMachine(b.identity as never, 'standby'); a.mgr.storeRemoteIdentity(b.identity as never);
    b.mgr.registerMachine(a.identity as never, 'awake'); b.mgr.storeRemoteIdentity(a.identity as never);
    const urls: Record<string, string> = {};
    const A = await serve(a, () => [{ machineId: b.identity.machineId, url: urls.b, kind: 'lan' }]);
    urls.a = A.base;
    const B = await serve(b, () => [{ machineId: a.identity.machineId, url: urls.a, kind: 'lan' }]);
    urls.b = B.base;
    const svcA = A.server.mobilePairing!; const svcB = B.server.mobilePairing!;
    expect(svcA.teamPuller).toBeTruthy();
    expect(svcB.teamPuller).toBeTruthy();

    // The owner's phone, on the Studio.
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer two-token').set('X-Instar-AgentId', 'team-two');
    const m = await auth(request(A.app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const ownerDev = makeDevice();
    const r = await request(A.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'Ann phone', devicePublicKey: ownerDev.publicKey });
    const owner = client(A.app, r.body.deviceId, ownerDev);
    const ownerCode = /is (\d{3}) (\d{3})\./.exec(A.dms[0]!)!.slice(1).join('');
    expect((await owner('POST', '/mobile/device/confirm', { code: ownerCode })).body.status).toBe('active');
    svcA.devices.setPresenceKey(r.body.deviceId, makeDevice().publicKey);

    const shared = (await owner('POST', '/mobile/conversations', { title: 'Client work', requestId: rid() })).body.conversationKey as string;
    const inv = await owner('POST', '/mobile/team/invites', { events: [
      { type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' },
      { type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' },
      { type: 'grant', personKey: 'mia', ref: shared, access: 'use' },
    ] });
    expect(inv.status).toBe(200);

    // Mia's phone, also on the Studio.
    const code = new URLSearchParams(String(inv.body.link).split('#')[1]).get('c');
    const miaDev = makeDevice();
    const redeemed = await request(A.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code, deviceName: 'Mia phone', devicePublicKey: miaDev.publicKey, appCaps: ['standing'] });
    const mia = client(A.app, redeemed.body.deviceId, miaDev);
    const waiting = await owner('GET', '/mobile/team/invites/mia');
    expect((await mia('POST', '/mobile/device/confirm', { code: waiting.body.waiting[0].code.replace(/\s/g, '') })).body.status).toBe('active');

    // The key ledger replicates through the journal in production.
    for (const row of svcA.keyLedger!.rows()) svcB.keyLedger!.ingestReplicated(row);

    // A peer that already holds everything counts as answering, though it has nothing to push.
    const noted: Array<[string, boolean]> = [];
    const real = svcA.teamPuller!.noteInbound.bind(svcA.teamPuller!);
    svcA.teamPuller!.noteInbound = (id, answered) => { noted.push([id, answered]); real(id, answered); };
    // The laptop pulls: real HTTP, real machine signature.
    const pulled = await svcB.teamPuller!.tick();
    expect(pulled!.outcomes).toEqual([expect.objectContaining({ answered: true, refused: 0 })]);
    expect(pulled!.outcomes[0].added).toBeGreaterThan(0);
    const logA = svcA.teamLog()!; const logB = svcB.teamLog()!;
    expect(logB.gaps()).toEqual([]);
    expect(svcB.teamOn()).toBe(true);
    expect(svcB.teamStanding('mia')).toEqual(svcA.teamStanding('mia'));
    await svcB.teamPuller!.tick();
    expect(noted.at(0)).toEqual([b.identity.machineId, false]);
    expect(noted.at(-1)).toEqual([b.identity.machineId, true]);
    expect(logB.isConfined(shared)).toBe(true);
    expect(B.changed).toContain(shared); // the laptop ended any session of it
    expect(svcA.teamPuller!.belowFloor()).toEqual([]);

    // Team phones wait for this machine's first exchange after it starts.
    expect((await mia('GET', '/mobile/conversations')).body.error).toBe('access-being-checked');
    await svcA.teamPuller!.tick();
    expect((await mia('GET', '/mobile/conversations')).status).toBe(200);

    // The agent removes her from the laptop; the Studio pulls and her phone there stops.
    const lowered = await auth(request(B.app).post('/team/people/mia/lower')).send({ remove: true });
    expect(lowered.status).toBe(200);
    expect((await mia('GET', '/mobile/conversations')).status).toBe(200);
    const back = await svcA.teamPuller!.tick();
    expect(back!.outcomes[0].answered).toBe(true);
    expect(svcA.teamStanding('mia')).toBeNull();
    expect((await mia('GET', '/mobile/conversations')).status).toBe(401);
    expect(logA.gaps()).toEqual([]);
    expect(logB.gaps()).toEqual([]);
    expect(logA.vector()).toEqual(logB.vector());
    expect((await owner('GET', '/mobile/conversations')).status).toBe(200);
  }, 30_000);
});
