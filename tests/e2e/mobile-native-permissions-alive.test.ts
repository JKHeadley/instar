/**
 * Feature-is-alive proof for the phone's native Permission slips and What I'm allowed to do
 * (docs/specs/mobile-native-permissions.md): an AgentServer booted on its production path
 * (development agent, mobile pairing on, a dashboard PIN, authorization requests on), a phone paired
 * through the real redeem/confirm path, its presence key enrolled through the real route, both lists
 * 200, one approve (a real signed carrier mandate and its audit row naming the phone), one decline,
 * and one switch round-trip (discovery event `operator-switch`), each with a real P-256 presence
 * signature over a single-use challenge. Wiring integrity: the routes are on the production device
 * allowlist (not 403 device-not-allowed), mounted (not 404) and live (not 503), the raw routes stay
 * refused for the phone, and the console's own PIN approve still works. The custody simulator case uses the same
 * disposable local app and does not qualify either independent replica recovery or physical-phone presence.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
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
import { presenceEnrollMessage } from '../../src/server/mobileConsoleTicket.js';
import { permissionPresenceMessage, actionLine } from '../../src/server/mobilePermissionsRoutes.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS } from '../../src/core/ChiefOfStaffLoop.js';
import { CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY } from '../../src/core/ChiefOfStaffStore.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';

const HOST = 'echo-permissions-e2e.example.dev';
const PIN = '424242';
const MIA = 'U0B9SFJ7QAK';
const servers: AgentServer[] = [];
const dirs: string[] = [];
const journals: CoherenceJournal[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const journal of journals) journal.close();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-permissions-alive.test.ts' });
});

async function boot(withProjects = false) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'permissions-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  allowTestIdentities(stateDir);
  const machine = await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'permissions-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    users: [{ id: 'mia', name: 'Mia', slackUserId: MIA, channels: [{ type: 'slack', identifier: MIA }], permissions: [] }],
    monitoring: { authorizationRequests: { enabled: true } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  // As server.ts builds it: open, register the built-ins, bootstrap from config.
  const featureRegistry = new FeatureRegistry(stateDir);
  await featureRegistry.open();
  for (const def of BUILTIN_FEATURES) featureRegistry.register(def);
  featureRegistry.bootstrap(config as unknown as Record<string, unknown>);
  const projectJournal = withProjects ? new CoherenceJournal({ stateDir, machineId: machine.machineId, flushIntervalMs: 25 }) : undefined;
  const chiefOfStaffLoop = projectJournal && projectLoop(projectJournal, machine.machineId);
  const server = new AgentServer({ config, chiefOfStaffLoop, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, featureRegistry } as never);
  servers.push(server);
  return { server, stateDir, projectJournal };
}

function projectLoop(journal: CoherenceJournal, machineId: string): ChiefOfStaffLoop {
  const registry = new ReplicatedKindRegistry();
  registry.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
  journal.open();
  journal.setReplicatedKindRegistry(registry);
  journals.push(journal);
  const emitter = new ReplicatedRecordEmitter({
    journal, clock: new HybridLogicalClock({ node: machineId, now: Date.now }), registry, origin: machineId,
    stores: () => ({ [CHIEF_OF_STAFF_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined,
  });
  return new ChiefOfStaffLoop({
    now: Date.now, machineId, enabled: () => true, holdsLease: () => true, config: () => CHIEF_OF_STAFF_LOOP_DEFAULTS,
    journal: {
      emit: (key, build) => emitter.emit(CHIEF_OF_STAFF_STORE_KEY, key, build),
      loadUnion: () => journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 100).entries
        .map(entry => ({ data: entry.data as Record<string, unknown>, origin: machineId })),
      awaitDurable: seq => journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, seq),
    },
    verifyRenewal: () => false,
    gather: async () => { throw new Error('Fixture does not run project checks'); },
    judge: async () => null, protocol: {} as never,
    mirrorInitiativeStatus: () => {}, sendNote: async () => {}, sendImmediate: async () => {},
    statusUrl: () => null, localHour: () => 8,
  });
}

const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'permissions-e2e');

async function pairSimulator(server: AgentServer, deviceName: string) {
  // This in-process transport has no configurable destination or live credentials.
  const app = server.getApp();
  expect(server.mobilePairing).not.toBeNull();
  server.mobilePairing!.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.host !== HOST) throw new Error('Unexpected non-fixture pairing URL');
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const m = await bearer(request(app).post('/mobile/pairing-codes')).send({});
  expect(m.status).toBe(200);
  const dms: string[] = [];
  server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
  server.mobilePairing!.deps.telegramOwnerPresent = () => true;
  const dev = makeDevice();
  const presence = makeDevice();
  const redeemed = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName, devicePublicKey: dev.publicKey });
  expect(redeemed.status).toBe(200);
  const deviceId = redeemed.body.deviceId as string;
  const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
  let t = Date.now();
  const signed = (method: 'GET' | 'POST', p: string, body?: unknown) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const time = String(++t);
    const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
    let r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
    r = r.set('Host', HOST).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    return raw ? r.send(raw.toString()) : r;
  };
  expect((await signed('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');

  return { signed, deviceId, presence };
}

describe('native permissions — production wiring', () => {
  it('records an owner simulator checklist tap durably and denies the revoked simulator', async () => {
    const { server, projectJournal } = await boot(true);
    const app = server.getApp();
    const key = 'telegram:982174';
    const text = 'Verify the synthetic item';
    await bearer(request(app).post('/chief-of-staff/projects')).send({
      pin: PIN, conversationKey: key, goal: 'Verify test custody', parentConversationKey: null,
      doneDefinition: [{ id: 'witness', kind: 'judgment', text }],
    }).expect(201);
    await vi.waitFor(() => expect(projectJournal!.readKindComplete(CHIEF_OF_STAFF_RECORD_KIND).entries).not.toHaveLength(0));

    const owner = await pairSimulator(server, 'Custody simulator owner');
    const revoked = await pairSimulator(server, 'Custody simulator formerly authorized');
    expect(owner.deviceId).not.toBe(revoked.deviceId);
    await owner.signed('POST', '/mobile/device/presence-key', {
      publicKey: owner.presence.publicKey,
      proof: owner.presence.sign(presenceEnrollMessage(owner.deviceId, HOST, owner.presence.publicKey)),
    }).expect(200);

    const read = await owner.signed('GET', '/mobile/work/projects').expect(200);
    const item = read.body.projects.find((project: { key: string }) => project.key === key).done.items[0];
    expect(item).toMatchObject({ id: 'witness', canMark: true, checkedByYou: null });
    const issue = { action: 'project-item-check', target: key, itemId: item.id, checkRef: item.checkRef, value: 'checked' };
    const challenge = await owner.signed('POST', '/mobile/permissions/challenge', issue).expect(200);
    const line = `project-item-check ${key} ${item.checkRef} checked`;
    const body = {
      key, itemId: item.id, checkRef: item.checkRef, value: 'checked', challenge: challenge.body.challenge,
      presenceSig: owner.presence.sign(permissionPresenceMessage(owner.deviceId, HOST, challenge.body.challenge, line)),
    };
    const checked = await owner.signed('POST', '/mobile/work/projects/done-item', body).expect(200);
    expect(checked.body.project.done.items[0].stateWords).toBe('Checked by you');
    await owner.signed('POST', '/mobile/work/projects/done-item', body).expect(401);

    const durable = projectJournal!.readKindComplete(CHIEF_OF_STAFF_RECORD_KIND);
    expect(durable.complete).toBe(true);
    const matching = durable.entries.map(entry => entry.data).filter(row => row.event === 'owner-item-check');
    expect(matching).toEqual([expect.objectContaining({
      conversationKey: key, itemId: 'witness', itemChecked: true, checkRef: item.checkRef, askId: expect.stringMatching(/^app-/),
    })]);

    const before = await revoked.signed('GET', '/mobile/work/projects').expect(200);
    expect(before.body.projects.find((project: { key: string }) => project.key === key).done.items[0].stateWords).toBe('Checked by you');
    const removal = await owner.signed('POST', `/mobile/devices/${revoked.deviceId}/revoke`).expect(200);
    expect(removal.body).toMatchObject({ revoked: true });
    const denied = await revoked.signed('GET', '/mobile/work/projects');
    expect([401, 403]).toContain(denied.status);
    expect(denied.text).not.toContain(key);
    expect(denied.text).not.toContain(text);
    const after = await owner.signed('GET', '/mobile/work/projects').expect(200);
    expect(after.body.projects.find((project: { key: string }) => project.key === key).done.items[0].stateWords).toBe('Checked by you');
  }, 30_000);

  it('is alive: lists, approve, decline and a switch from an owner phone with fresh presence proofs', async () => {
    const { server, stateDir } = await boot();
    const app = server.getApp();
    const { signed, deviceId, presence } = await pairSimulator(server, 'e2e phone');

    // Before the key: read-only lists say the phone can enrol, and a write is refused for the missing key.
    const before = await signed('GET', '/mobile/permissions/slips');
    expect(before.status).toBe(200);
    expect(before.body.actions).toEqual({ state: 'available', reason: null, presenceKey: false });
    expect((await signed('POST', '/mobile/permissions/challenge', { action: 'set-feature', target: 'dashboard-file-viewer', value: 'disabled' })).status).toBe(409);
    expect((await signed('POST', '/mobile/device/presence-key', { publicKey: presence.publicKey, proof: presence.sign(presenceEnrollMessage(deviceId, HOST, presence.publicKey)) })).status).toBe(200);

    // Two waiting requests from the agent (bearer; inert until approved).
    // Each request differs (a declined proposal has a re-proposal cooldown).
    const propose = async (floorAction = 'prod-deploy') => {
      const r = await bearer(request(app).post('/authorization-requests')).send({ createdByAgent: 'echo', proposal: { floorAction, grantedToSlackUserId: MIA, durationMs: 3_600_000 }, reason: 'release' });
      expect(r.status).toBe(201);
      return r.body.id as string;
    };
    const a = await propose();
    const slips = await signed('GET', '/mobile/permissions/slips');
    expect(slips.status).toBe(200);
    expect(slips.body.actions).toEqual({ state: 'available', reason: null, presenceKey: true });
    const row = slips.body.approvals.rows.find((r: { id: string }) => r.id === a);
    expect(row).toMatchObject({ headline: 'Let Mia deploy to production for 1 hour.', here: true });
    expect(row.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(slips.body)).not.toContain(MIA);

    const act = async (issue: Record<string, unknown>, route: string, body: Record<string, unknown>, line: string) => {
      const ch = await signed('POST', '/mobile/permissions/challenge', issue);
      expect(ch.status, JSON.stringify(ch.body)).toBe(200);
      return signed('POST', route, { ...body, challenge: ch.body.challenge, presenceSig: presence.sign(permissionPresenceMessage(deviceId, HOST, ch.body.challenge, line)) });
    };

    // Approve: a real signed carrier mandate, its audit row names the phone.
    const ok = await act({ action: 'approve-request', target: a, proposalHash: row.proposalHash }, `/mobile/permissions/requests/${a}/approve`, { proposalHash: row.proposalHash }, `approve-request ${a} ${row.proposalHash}`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ approved: true, request: { status: 'approved' } });
    const mandates = await bearer(request(app).get('/mandate'));
    const carrier = mandates.body.mandates.find((x: { id: string }) => x.id === ok.body.request.resultMandateId);
    expect(carrier).toMatchObject({ scope: 'user-authority-grant', authorshipValid: true });
    const audit = await bearer(request(app).get('/mandate/audit?limit=20'));
    expect(JSON.stringify(audit.body)).toContain(`device ${deviceId}`);
    const after = await signed('GET', '/mobile/permissions/slips');
    expect(after.body.slips.active.some((s: { summary: string }) => s.summary === 'Mia may deploy to production')).toBe(true);

    // Decline another.
    const b = await propose('external-send');
    const bRow = (await signed('GET', '/mobile/permissions/slips')).body.approvals.rows.find((r: { id: string }) => r.id === b);
    expect(bRow).toBeTruthy();
    const reason = 'Not this week.';
    const no = await act({ action: 'decline-request', target: b, reason }, `/mobile/permissions/requests/${b}/decline`, { reason }, actionLine({ kind: 'decline-request', target: b, reason }));
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect(no.body.request).toMatchObject({ status: 'denied', denyReason: reason });

    // A switch, off from the phone: the operator path, recorded as such.
    const feats = await signed('GET', '/mobile/permissions/features');
    expect(feats.status).toBe(200);
    expect(feats.body.features.some((f: { id: string }) => f.id === 'dashboard-file-viewer')).toBe(true);
    const sw = await act({ action: 'set-feature', target: 'dashboard-file-viewer', value: 'disabled' }, '/mobile/permissions/features/dashboard-file-viewer', { to: 'disabled' }, 'set-feature dashboard-file-viewer disabled none');
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    expect(sw.body).toMatchObject({ success: true, viaOperatorSwitch: true, newState: 'disabled' });
    const events = await bearer(request(app).get('/features/events?featureId=dashboard-file-viewer&limit=50'));
    const ev = (events.body.events as Array<{ trigger?: string; newState: string; context?: string }>).find((e) => e.trigger === 'operator-switch');
    expect(ev).toMatchObject({ trigger: 'operator-switch', newState: 'disabled' });
    expect(ev!.context).toContain(deviceId);

    // The phone audit file records each one.
    const rows = fs.readFileSync(path.join(stateDir, 'state', 'mobile-permission-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.filter((x) => x.event !== 'challenge').map((x) => x.event)).toEqual(expect.arrayContaining(['approved', 'declined', 'feature-set']));

    // The raw routes stay refused for the phone; the bearer cannot write here; the console's PIN path still works.
    for (const [method, p] of [['GET', '/mandate'], ['GET', '/authorization-requests'], ['GET', '/features']] as const) {
      expect((await signed(method, p)).status, p).toBe(403);
    }
    expect((await bearer(request(app).post('/mobile/permissions/challenge')).send({ action: 'approve-request', target: a, proposalHash: row.proposalHash })).status).toBe(403);
    const c = await propose('destructive-data');
    const viaPin = await bearer(request(app).post(`/authorization-requests/${c}/approve`)).send({ pin: PIN });
    expect(viaPin.status).toBe(201);
  });
});
