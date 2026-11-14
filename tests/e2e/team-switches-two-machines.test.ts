/**
 * Feature-is-alive proof for team settings across the whole agent (docs/specs/team-switches-agent-wide.md):
 * two real AgentServers on the production boot path. The owner's one Face ID tap on the Studio turns
 * memory privacy on in the laptop's own config over the real signed machine route and asks for the
 * laptop's restart; a third registered machine with no address is listed and kept for retry.
 * Wiring integrity: the applier, its peers, the peer route and the context summary are live delegates.
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
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';

const HOST = 'echo-team-sw.example.dev';
const servers: AgentServer[] = [];
const coords: MultiMachineCoordinator[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const c of coords) c.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/team-switches-two-machines.test.ts' });
});

const pem = (k: string) => k.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');

function machine(name: string, role: 'awake' | 'standby') {
  const stateDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), `team-sw-${name}-`));
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
    projectName: 'team-sw', projectDir: m.stateDir, stateDir: m.stateDir, port: 0, host: '127.0.0.1', authToken: 'two-token', developmentAgent: true,
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
  sessionManager.memoryPrivacyStatus = () => ({ enabled: false, sandboxReady: false, multiPerson: false, ownerUserId: null, blocker: null, fix: null });
  sessionManager.applyConversationChange = async (ref: string, change: () => unknown) => { changed.push(ref); return change(); };
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({
    config, sessionManager, state, initiativeTracker: new InitiativeTracker(m.stateDir), tunnel, coordinator,
    localSigningKeyPem: m.signing.privateKey, resolvePeerUrls: peers, liveConfig: new LiveConfig(m.stateDir),
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

describe('team settings turn on for the whole agent', () => {
  it('one owner tap on the Studio sets memory privacy on the laptop over the signed route, and lists a machine it cannot reach', async () => {
    const a = machine('studio', 'awake');
    const b = machine('laptop', 'standby');
    const c = machine('mama', 'standby');
    a.mgr.registerMachine(b.identity as never, 'standby'); a.mgr.storeRemoteIdentity(b.identity as never);
    a.mgr.registerMachine(c.identity as never, 'standby'); a.mgr.storeRemoteIdentity(c.identity as never);
    b.mgr.registerMachine(a.identity as never, 'awake'); b.mgr.storeRemoteIdentity(a.identity as never);
    const urls: Record<string, string> = {};
    // Mama PC is in the Studio's registry but has no address right now.
    const A = await serve(a, () => [{ machineId: b.identity.machineId, url: urls.b, kind: 'lan' }]);
    urls.a = A.base;
    const B = await serve(b, () => [{ machineId: a.identity.machineId, url: urls.a, kind: 'lan' }]);
    urls.b = B.base;
    expect(A.server.teamSwitchApplier).toBeTruthy();
    expect(B.server.teamSwitchApplier).toBeTruthy();

    const auth = (q: request.Test) => q.set('Authorization', 'Bearer two-token').set('X-Instar-AgentId', 'team-sw');
    const m = await auth(request(A.app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const ownerDev = makeDevice();
    const r = await request(A.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'Ann phone', devicePublicKey: ownerDev.publicKey });
    const owner = client(A.app, r.body.deviceId, ownerDev);
    const ownerCode = /is (\d{3}) (\d{3})\./.exec(A.dms[0]!)!.slice(1).join('');
    expect((await owner('POST', '/mobile/device/confirm', { code: ownerCode })).body.status).toBe('active');
    const presence = makeDevice();
    A.server.mobilePairing!.devices.setPresenceKey(r.body.deviceId, presence.publicKey);

    // Before: the context gives one line for memory privacy, counting the Studio itself.
    const before = await owner('GET', '/mobile/team/context');
    expect(before.status).toBe(200);
    const line = (before.body.teamSwitches as Array<{ setting: string; offOn: string[]; action: string }>).find((l) => l.setting === 'memory-privacy');
    expect(line).toMatchObject({ action: 'turn-on-everywhere' });
    expect(line!.offOn).toContain(a.identity.machineId);

    const ch = await owner('POST', '/mobile/permissions/challenge', { action: 'team-switch-on', target: 'memory-privacy' });
    expect(ch.status).toBe(200);
    const presenceSig = presence.sign(permissionPresenceMessage(r.body.deviceId, HOST, ch.body.challenge, 'team-switch-on memory-privacy'));
    const on = await owner('POST', '/mobile/team/switches/turn-on', { setting: 'memory-privacy', challenge: ch.body.challenge, presenceSig });
    expect(on.status).toBe(200);
    expect(on.body.ok).toBe(true);
    const byId = new Map((on.body.machines as Array<{ machineId: string; result: string; willRetry: boolean; self: boolean }>).map((x) => [x.machineId, x]));
    expect(byId.get(b.identity.machineId)).toMatchObject({ result: 'applied', self: false, willRetry: false });
    expect(byId.get(c.identity.machineId)).toMatchObject({ result: 'unreachable', willRetry: true });
    expect(byId.get(a.identity.machineId)).toMatchObject({ result: 'applied', self: true });

    // The laptop's own config now has it on, and it asked for its own planned restart.
    const cfgB = JSON.parse(fs.readFileSync(path.join(b.stateDir, 'config.json'), 'utf8'));
    expect(cfgB.memoryPrivacy?.enabled).toBe(true);
    const flagB = JSON.parse(fs.readFileSync(path.join(b.stateDir, 'state', 'restart-requested.json'), 'utf8'));
    expect(flagB).toMatchObject({ plannedRestart: true, requestedBy: 'team-switch-memory-privacy' });
    expect(JSON.parse(fs.readFileSync(path.join(a.stateDir, 'config.json'), 'utf8')).memoryPrivacy?.enabled).toBe(true);
    // Nothing else on the laptop was touched.
    expect(cfgB.mobilePairing).toBeUndefined();

    // Mama PC is owed the request and kept on file; the context marks it as asked.
    expect(A.server.teamSwitchApplier!.pending().map((p) => p.machineId)).toEqual([c.identity.machineId]);
    expect(fs.existsSync(path.join(a.stateDir, 'state', 'team-access', 'switch-requests.json'))).toBe(true);

    // A request from an unsigned caller is refused by the peer route.
    const unsigned = await fetch(`${B.base}/api/team-access/switch-on`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setting: 'memory-privacy' }) });
    expect(unsigned.status).toBe(401);

    // One tap for everything team access needs (team-access), with its own signed line.
    const ch2 = await owner('POST', '/mobile/permissions/challenge', { action: 'team-switch-on', target: 'team-access' });
    expect(ch2.status).toBe(200);
    const sig2 = presence.sign(permissionPresenceMessage(r.body.deviceId, HOST, ch2.body.challenge, 'team-switch-on team-access'));
    const all = await owner('POST', '/mobile/team/switches/turn-on', { setting: 'team-access', challenge: ch2.body.challenge, presenceSig: sig2 });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ ok: true, setting: 'team-access' });
    expect(Array.isArray(all.body.settings)).toBe(true);
    expect((all.body.results as unknown[]).length).toBe((all.body.settings as unknown[]).length);

    // Files in app conversations (the app's "Files are turned off" notice): the laptop has them off in its
    // own config; the owner's one tap turns them on there over the same signed route.
    const cfgPathB = path.join(b.stateDir, 'config.json');
    const offB = JSON.parse(fs.readFileSync(cfgPathB, 'utf8'));
    offB.mobilePairing = { ...(offB.mobilePairing ?? {}), native: { ...(offB.mobilePairing?.native ?? {}), media: { enabled: false } } };
    fs.writeFileSync(cfgPathB, JSON.stringify(offB, null, 2));
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(cfgPathB, future, future);
    const ch3 = await owner('POST', '/mobile/permissions/challenge', { action: 'team-switch-on', target: 'files' });
    expect(ch3.status).toBe(200);
    const sig3 = presence.sign(permissionPresenceMessage(r.body.deviceId, HOST, ch3.body.challenge, 'team-switch-on files'));
    const files = await owner('POST', '/mobile/team/switches/turn-on', { setting: 'files', challenge: ch3.body.challenge, presenceSig: sig3 });
    expect(files.status).toBe(200);
    const filesById = new Map((files.body.machines as Array<{ machineId: string; result: string }>).map((x) => [x.machineId, x]));
    expect(filesById.get(b.identity.machineId)).toMatchObject({ result: 'applied' });
    expect(JSON.parse(fs.readFileSync(cfgPathB, 'utf8')).mobilePairing.native.media.enabled).toBe(true);
  }, 30_000);
});
