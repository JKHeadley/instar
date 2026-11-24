import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { expect, it } from 'vitest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS } from '../../src/core/ChiefOfStaffLoop.js';
import { createChiefOfStaffProjectComparisonJournal } from '../../src/core/ChiefOfStaffProjectComparisonJournal.js';
import { createChiefOfStaffProjectComparisonSource } from '../../src/core/ChiefOfStaffProjectComparisonSource.js';
import { CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY } from '../../src/core/ChiefOfStaffStore.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { createTaskFlowProjectsComparisonSource } from '../../src/tasks/taskFlowProjectsComparison.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { createMockSessionManager } from '../helpers/setup.js';

const HOST = 'comparison-local-cos.example.dev';
const PIN = '456789';
const MASTER = 'fixture-comparison-master';
const AGENT = 'comparison-local-cos';
const TITLE = 'Same visible title';
const PROJECT_ID = 'private-initiative-identity';
const GOAL = 'Private CoS goal';

function nativeLoop(journal: CoherenceJournal, machineId: string) {
  const registry = new ReplicatedKindRegistry();
  registry.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
  journal.open();
  journal.setReplicatedKindRegistry(registry);
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

function master(q: request.Test) {
  return q.set('Authorization', `Bearer ${MASTER}`).set('X-Instar-AgentId', AGENT);
}

async function pairOwner(server: AgentServer) {
  const app = server.getApp();
  const pairing = server.mobilePairing!;
  pairing.deps.fetchFn = (async (url: string) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.host !== HOST) throw new Error('Not a fixture pairing URL');
    const response = await request(app).get(target.pathname + target.search).set('Host', HOST);
    return { ok: response.ok, status: response.status, json: async () => response.body };
  }) as unknown as typeof fetch;
  const minted = await master(request(app).post('/mobile/pairing-codes')).send({}).expect(200);
  const dms: string[] = [];
  pairing.deps.ownerDM = async text => { dms.push(text); return 1; };
  pairing.deps.telegramOwnerPresent = () => true;
  const device = makeDevice();
  const redeemed = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST)
    .send({ code: minted.body.code, deviceName: 'Disposable owner simulator', devicePublicKey: device.publicKey }).expect(200);
  const deviceId = redeemed.body.deviceId as string;
  const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
  let now = Date.now();
  const signed = (method: 'POST' | 'DELETE', route: string, body: object) => {
    const raw = Buffer.from(JSON.stringify(body));
    const time = String(++now);
    const signature = device.sign(canonicalString(deviceId, HOST, method, route, time, raw));
    return (method === 'POST' ? request(app).post(route) : request(app).delete(route))
      .set('Host', HOST).set('Content-Type', 'application/json')
      .set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', signature)
      .send(raw.toString());
  };
  expect((await signed('POST', '/mobile/device/confirm', { code }).expect(200)).body.status).toBe('active');
  return { signed };
}

it('compares separate native same-title rows and withholds an App title erased before release', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-comparison-local-cos-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const store = new TaskFlowStore({ dbPath: path.join(stateDir, 'task-flows.db') });
  let server: AgentServer | undefined;
  let journal: CoherenceJournal | undefined;
  try {
    allowTestIdentities(stateDir);
    const machine = await new MachineIdentityManager(stateDir).generateIdentity({ name: 'Disposable comparison machine' });
    journal = new CoherenceJournal({ stateDir, machineId: machine.machineId, flushIntervalMs: 25 });
    const loop = nativeLoop(journal, machine.machineId);
    const projectJournal = journal;
    await store.open();
    const tracker = new InitiativeTracker(stateDir);
    tracker.setTaskFlowRegistry(new TaskFlowRegistry({ store }), 'fixture-controller');
    await tracker.create({
      id: PROJECT_ID, kind: 'project', title: TITLE,
      description: 'Fixture private description', phases: [{ id: 'start', name: 'Start' }],
    });
    // The fixture controls all writers, app identities and grants in this temp root.
    // The scope is established before reads and does not use the existence of a row as an ACL.
    let authorizedAppKey: string | undefined;
    const exclusivelyOwned = () => !!authorizedAppKey;
    const journalReader = createChiefOfStaffProjectComparisonJournal({
      journal: projectJournal,
      isAuthorized: exclusivelyOwned,
      workerUrl: new URL('../../dist/core/ChiefOfStaffProjectComparisonJournal.worker.js', import.meta.url),
    });
    const chiefOfStaff = createChiefOfStaffProjectComparisonSource({
      journal: journalReader,
      ownerBoundary: () => server?.appConversations && exclusivelyOwned() ? {
        app: server.appConversations,
        isCurrent: exclusivelyOwned,
        mayReadNativeOwnerApp: key => {
          if (key !== authorizedAppKey) return false;
          const app = server?.appConversations;
          const original = app?.store.getCreationRecord(key);
          return !!original && original.conversationKey === key && original.machineId === machine.machineId
            && original.ownerPerson === undefined && !!app?.liveConversation(key);
        },
      } : null,
    });
    const projects = createTaskFlowProjectsComparisonSource({
      workerUrl: new URL('../../dist/tasks/taskFlowProjectsComparison.worker.js', import.meta.url),
      proveAuthority: () => tracker.proveWholeTaskFlowProjectsComparison(exclusivelyOwned),
    });
    let eraseBeforeRelease: (() => Promise<void>) | undefined;
    const cfg = {
      projectName: AGENT, projectDir: root, stateDir, port: 0,
      developmentAgent: true, throwawayAgent: { createdAt: new Date().toISOString() },
      projectListComparison: { enabled: true }, authToken: MASTER, dashboardPin: PIN,
      security: { dashboardScopedToken: { enabled: true } },
      mobilePairing: { multiRoute: { enabled: false } },
      tunnel: { enabled: true, type: 'named', token: 'disposable-no-network', hostname: HOST },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as InstarConfig;
    server = new AgentServer({
      config: cfg, state: new StateManager(stateDir), sessionManager: createMockSessionManager() as never,
      initiativeTracker: tracker, chiefOfStaffLoop: loop, meshSelfId: machine.machineId,
      tunnel: { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as never,
      projectComparisonSources: {
        projects,
        chiefOfStaff: { async read(signal) {
          const value = await chiefOfStaff.read(signal);
          if (eraseBeforeRelease) {
            expect(value).not.toBeNull();
            await eraseBeforeRelease();
          }
          return value;
        } },
      },
    });
    await server.start();
    const app = server.getApp();
    expect(server.appConversations).not.toBeNull();
    const phone = await pairOwner(server);
    const created = await phone.signed('POST', '/mobile/conversations', {
      title: TITLE, requestId: `${Date.now()}-${randomUUID()}`, parentConversationKey: null,
    }).expect(200);
    const key = created.body.conversationKey as string;
    const appKey = `app:${key}`;
    authorizedAppKey = key;
    expect(server.appConversations!.liveConversation(key)).toMatchObject({ title: TITLE });
    expect(server.appConversations!.store.getCreationRecord(key)).toMatchObject({ conversationKey: key, machineId: machine.machineId });
    await master(request(app).post('/chief-of-staff/projects')).send({
      pin: PIN, conversationKey: appKey, goal: GOAL, initiativeId: PROJECT_ID, parentConversationKey: null,
      doneDefinition: [{ id: 'fixture', kind: 'judgment', text: 'Verify the native fixture' }],
    }).expect(201);
    projectJournal.flush();
    const origin = projectJournal.readKindComplete(CHIEF_OF_STAFF_RECORD_KIND).entries;
    expect(origin).toHaveLength(1);

    const unlocked = await request(app).post('/dashboard/unlock').send({ pin: PIN }).expect(200);
    expect(unlocked.body.token).toMatch(/^dst_/);
    const compare = () => request(app).get('/work/projects/compare?view=all')
      .set('Authorization', `Bearer ${unlocked.body.token}`).expect(200).expect('Cache-Control', 'no-store');
    const before = await compare();
    expect(before.body.coverage).toMatchObject({ projects: { status: 'complete' }, chiefOfStaff: { status: 'complete' } });
    expect(before.body.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'counterpart-unchecked', projects: [expect.objectContaining({ title: TITLE })], chiefOfStaff: [] }),
      expect.objectContaining({ state: 'counterpart-unchecked', projects: [], chiefOfStaff: [expect.objectContaining({ title: TITLE })] }),
    ]));
    expect(before.body.rows).toHaveLength(2);
    expect(before.body.rows[0].ordinal).not.toBe(before.body.rows[1].ordinal);
    expect(before.text).not.toContain(PROJECT_ID);
    expect(before.text).not.toContain(key);
    expect(before.text).not.toContain(GOAL);

    let erased = false;
    eraseBeforeRelease = async () => {
      const deletion = await phone.signed('DELETE', `/mobile/conversations/${key}`, { requestId: `${Date.now()}-${randomUUID()}` }).expect(200);
      expect(deletion.body).toMatchObject({ deleted: true });
      erased = true;
    };
    const after = await compare();
    expect(erased).toBe(true);
    expect(server.appConversations!.liveConversation(key)).toBeNull();
    expect(server.appConversations!.store.getConversation(key)?.tombstoned).toBe(true);
    expect(after.body).toMatchObject({
      status: 'partial',
      coverage: { projects: { status: 'complete' }, chiefOfStaff: { status: 'unavailable' } },
      rows: [{ state: 'counterpart-unchecked', projects: [{ title: TITLE }], chiefOfStaff: [] }],
    });
    eraseBeforeRelease = undefined;
    const repeat = await compare();
    expect(repeat.body.rows).toEqual(after.body.rows);
    expect(projectJournal.readKindComplete(CHIEF_OF_STAFF_RECORD_KIND).entries).toEqual(origin);
    expect(tracker.get(PROJECT_ID)?.title).toBe(TITLE);
  } finally {
    if (server) await server.stop();
    journal?.close();
    store.close();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'project-list-comparison-local-cos-e2e' });
  }
}, 25_000);
