/**
 * Integration — POST /messages/send across machines: the real relay route, and
 * an honest failure for a target this registry does not know or has revoked
 * (messages-send-cross-machine-honest).
 *
 * Real HTTP end to end: machine O runs the real AgentServer (the /messages/send
 * route); peer P and target T run the real machine routes
 * (POST /api/messages/relay-machine behind real Machine-HMAC auth) on real
 * listening ports, each with a real MachineIdentityManager registry, NonceStore
 * and MessageRouter. Registries model the 2026-11-20 split: O knows {O,P,R(revoked)};
 * P knows {O,P,T}; T knows {P,T} only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { MachineIdentityManager, generateSigningKeyPair, generateMachineId, pemToBase64 } from '../../src/core/MachineIdentity.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import type { MachineIdentity, InstarConfig } from '../../src/core/types.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Machine {
  id: string;
  keys: { publicKey: string; privateKey: string };
  identity: MachineIdentity;
  dir: string;
  identityManager: MachineIdentityManager;
  store: MessageStore;
  router: MessageRouter;
  injected: string[];
  url?: string;
  server?: http.Server;
}

function newMachine(name: string, dir: string): Omit<Machine, 'identityManager' | 'store' | 'router' | 'injected'> {
  const keys = generateSigningKeyPair();
  const id = generateMachineId();
  return {
    id,
    keys,
    dir,
    identity: {
      machineId: id,
      signingPublicKey: pemToBase64(keys.publicKey),
      encryptionPublicKey: 'unused',
      name,
      platform: 'test',
      createdAt: new Date().toISOString(),
      capabilities: ['sessions'],
    },
  };
}

async function wire(m: Omit<Machine, 'identityManager' | 'store' | 'router' | 'injected'>, known: Array<{ m: { id: string; identity: MachineIdentity }; url?: string; revoke?: boolean }>): Promise<Machine> {
  fs.mkdirSync(path.join(m.dir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(m.dir, 'machine', 'identity.json'), JSON.stringify(m.identity));
  const identityManager = new MachineIdentityManager(m.dir);
  identityManager.registerMachine(m.identity, 'awake');
  for (const k of known) {
    identityManager.registerMachine(k.m.identity, 'standby');
    identityManager.storeRemoteIdentity(k.m.identity);
    if (k.url) identityManager.updateMachineUrl(k.m.id, k.url);
    if (k.revoke) identityManager.revokeMachine(k.m.id, m.id, 'test: machine rebuilt');
  }
  const store = new MessageStore(path.join(m.dir, 'messages'));
  await store.initialize();
  const injected: string[] = [];
  const tmux = {
    getForegroundProcess: () => 'bash',
    isSessionAlive: () => true,
    hasActiveHumanInput: () => false,
    sendKeys: (s: string) => { injected.push(s); return true; },
    getOutputLineCount: () => 100,
  };
  const nonceStore = new NonceStore(path.join(m.dir, 'nonces'));
  const securityLog = new SecurityLog(m.dir);
  securityLog.initialize();
  const router = new MessageRouter(
    store,
    new MessageDelivery(new MessageFormatter(), tmux),
    { localAgent: 'echo', localMachine: m.id, serverUrl: 'http://localhost:0', isOwnSession: (s) => s === 'echo-topic-144319' },
    { identityManager, signingKeyPem: m.keys.privateKey, nonceStore, securityLog },
  );
  return { ...m, identityManager, store, router, injected };
}

function serveMachineRoutes(m: Machine): Promise<void> {
  const nonceStore = new NonceStore(path.join(m.dir, 'route-nonces'));
  const securityLog = new SecurityLog(m.dir);
  securityLog.initialize();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(createMachineRoutes({
    identityManager: m.identityManager,
    heartbeatManager: new HeartbeatManager(m.dir, m.id),
    securityLog,
    authDeps: { identityManager: m.identityManager, nonceStore, securityLog, localMachineId: m.id },
    localMachineId: m.id,
    localSigningKeyPem: m.keys.privateKey,
    messageRouter: m.router,
  }));
  return new Promise((resolve) => {
    m.server = app.listen(0, '127.0.0.1', () => {
      m.url = `http://127.0.0.1:${(m.server!.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

describe('POST /messages/send — cross-machine relay route and honest failure (real HTTP)', () => {
  let project: TempProject;
  let tmp: string;
  let O: Machine;
  let P: Machine;
  let T: Machine;
  let R: ReturnType<typeof newMachine>;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH = 'test-auth-e2-fallback';

  beforeAll(async () => {
    project = createTempProject();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-e2-int-'));
    const o = newMachine('origin', path.join(tmp, 'o'));
    const p = newMachine('peer', path.join(tmp, 'p'));
    const t = newMachine('target', path.join(tmp, 't'));
    R = newMachine('revoked', path.join(tmp, 'r'));
    // Ports first (URLs go into registries), so start P and T with placeholder routers.
    P = await wire(p, [{ m: o }]);
    T = await wire(t, [{ m: p }]);
    await serveMachineRoutes(P);
    await serveMachineRoutes(T);
    // Now that URLs exist, finish registries: P knows T (with URL); T knows P.
    P.identityManager.registerMachine(T.identity, 'standby');
    P.identityManager.storeRemoteIdentity(T.identity);
    P.identityManager.updateMachineUrl(T.id, T.url!);
    O = await wire(o, [{ m: P, url: P.url }, { m: R, revoke: true }]);

    const config: InstarConfig = {
      projectName: 'test-e2-fallback',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH,
      requestTimeoutMs: 15000,
      version: '0.9.81',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
      users: [],
    };
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: project.state, messageRouter: O.router });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    for (const m of [P, T]) await new Promise<void>((r) => m.server!.close(() => r()));
    for (const m of [O, P, T]) await m.store.destroy();
    project.cleanup();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/messages-send-cross-machine-honest.test.ts' });
  });

  const send = (toMachine: string, session = 'echo-topic-144319') =>
    request(app)
      .post('/messages/send')
      .set('Authorization', `Bearer ${AUTH}`)
      .send({ from: { agent: 'echo', session: 'echo-cos', machine: O.id }, to: { agent: 'echo', session, machine: toMachine }, type: 'info', priority: 'medium', subject: 'join code', body: 'run instar join' });

  it('a known peer is reached through the real Machine-HMAC relay route (201, received)', async () => {
    const res = await send(P.id);
    expect(res.status).toBe(201);
    expect(res.body.phase).toBe('received');
    expect(res.body.delivered).toBe(true);
    expect(await P.store.exists(res.body.messageId)).toBe(true);
  });

  it('a machine this registry does not know (but a peer does) still fails honestly: 502 + notice, nothing relayed', async () => {
    const res = await send(T.id);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ phase: 'failed', delivered: false });
    expect(res.body.failureReason).toMatch(/not known to this machine/);
    expect(await T.store.exists(res.body.messageId)).toBe(false);
    expect(await P.store.exists(res.body.messageId)).toBe(false);
  });

  it('a revoked machine is refused with 502 and a plain notice, nothing relayed', async () => {
    const res = await send(R.id);
    expect(res.status).toBe(502);
    expect(res.body.delivered).toBe(false);
    expect(res.body.failureReason).toMatch(/revoked/);
    expect(res.body.notice).toMatch(/removed from this agent's machines/);
    expect(res.body.error).toMatch(/revoked/);
  });

  it('a machine no peer knows fails with 502 and a notice instead of a silent 201', async () => {
    const res = await send('m_nobody_knows_this_one');
    expect(res.status).toBe(502);
    expect(res.body.phase).toBe('failed');
    expect(res.body.notice).toMatch(/not delivered/);
  });
});
