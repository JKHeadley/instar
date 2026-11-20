/**
 * Tier-3 alive test — cross-machine POST /messages/send through two REAL booted
 * AgentServers (messages-send-cross-machine-honest).
 *
 * Mirrors server.ts: each machine's MessageRouter gets its cross-machine deps
 * from its MultiMachineCoordinator (identityManager / nonceStore / securityLog)
 * and the machine's signing key; the router is handed to AgentServer, which
 * mounts the Machine-HMAC routes. Proves, through the full middleware stack:
 *  - a send to a paired peer actually lands on that peer (the relay path used
 *    to POST a URL no route served, so every cross-machine send fell into the
 *    outbound queue as "machine unreachable");
 *  - a send to a machine nobody knows answers 502 with a plain notice, not 201.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager, generateMachineId, generateSigningKeyPair, generateEncryptionKeyPair } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const b64 = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');

function machineEnv(name: string, role: 'awake' | 'standby') {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `instar-e2-alive-${name}-`));
  const mgr = new MachineIdentityManager(stateDir);
  const machineId = generateMachineId();
  const signingKeys = generateSigningKeyPair();
  const encryptionKeys = generateEncryptionKeyPair();
  const identity = {
    machineId,
    signingPublicKey: b64(signingKeys.publicKey),
    encryptionPublicKey: b64(encryptionKeys.publicKey),
    name,
    platform: `${os.platform()}-${os.arch()}`,
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'] as string[],
  };
  const machineDir = path.join(stateDir, 'machine');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'identity.json'), JSON.stringify(identity, null, 2));
  fs.writeFileSync(path.join(machineDir, 'signing-private.pem'), signingKeys.privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(machineDir, 'encryption-private.pem'), encryptionKeys.privateKey, { mode: 0o600 });
  mgr.registerMachine(identity as any, role);
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  const config = {
    projectName: `e2-alive-${name}`,
    projectDir: stateDir,
    stateDir,
    port: 0,
    host: '127.0.0.1',
    authToken: `auth-${name}`,
    requestTimeoutMs: 30_000,
    version: '0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [],
    monitoring: {},
    updates: {},
  } as unknown as InstarConfig;
  return { stateDir, mgr, machineId, identity, signingKeys, config };
}

describe('E2E: cross-machine /messages/send is alive', () => {
  const envA = machineEnv('a', 'awake');
  const envB = machineEnv('b', 'standby');
  let coordA: MultiMachineCoordinator;
  let coordB: MultiMachineCoordinator;
  let serverA: AgentServer;
  let serverB: AgentServer;
  let storeA: MessageStore;
  let storeB: MessageStore;
  let baseA = '';
  const injectedB: string[] = [];

  async function boot(env: ReturnType<typeof machineEnv>, coord: MultiMachineCoordinator, injected: string[]) {
    const store = new MessageStore(path.join(env.stateDir, 'messages'));
    await store.initialize();
    const tmux = {
      getForegroundProcess: () => 'bash',
      isSessionAlive: () => true,
      hasActiveHumanInput: () => false,
      sendKeys: (s: string) => { injected.push(s); return true; },
      getOutputLineCount: () => 100,
    };
    // Exactly the server.ts construction (crossMachineDeps from the coordinator).
    const router = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), tmux), {
      localAgent: 'echo',
      localMachine: coord.identity!.machineId,
      serverUrl: 'http://localhost:0',
      isOwnSession: (s: string) => s === 'echo-topic-1',
    }, {
      identityManager: coord.managers.identityManager,
      signingKeyPem: env.signingKeys.privateKey,
      nonceStore: coord.managers.nonceStore,
      securityLog: coord.managers.securityLog,
    });
    const server = new AgentServer({
      config: env.config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(env.stateDir),
      coordinator: coord,
      localSigningKeyPem: env.signingKeys.privateKey,
      messageRouter: router,
    });
    await server.start();
    return { server, store };
  }

  beforeAll(async () => {
    envA.mgr.registerMachine(envB.identity as any, 'standby');
    envA.mgr.storeRemoteIdentity(envB.identity as any);
    envB.mgr.registerMachine(envA.identity as any, 'awake');
    envB.mgr.storeRemoteIdentity(envA.identity as any);

    coordA = new MultiMachineCoordinator(new StateManager(envA.stateDir), { stateDir: envA.stateDir });
    coordA.start();
    const hbSrc = path.join(envA.stateDir, 'state', 'heartbeat.json');
    if (fs.existsSync(hbSrc)) fs.copyFileSync(hbSrc, path.join(envB.stateDir, 'state', 'heartbeat.json'));
    coordB = new MultiMachineCoordinator(new StateManager(envB.stateDir), { stateDir: envB.stateDir });
    coordB.start();

    ({ server: serverB, store: storeB } = await boot(envB, coordB, injectedB));
    envA.mgr.updateMachineUrl(envB.machineId, boundAgentServerBase(serverB));
    ({ server: serverA, store: storeA } = await boot(envA, coordA, []));
    baseA = boundAgentServerBase(serverA);
  }, 30_000);

  afterAll(async () => {
    await serverA?.stop();
    await serverB?.stop();
    coordA?.stop();
    coordB?.stop();
    await storeA?.destroy();
    await storeB?.destroy();
    for (const e of [envA, envB]) SafeFsExecutor.safeRmSync(e.stateDir, { recursive: true, force: true, operation: 'tests/e2e/messages-send-cross-machine-alive.test.ts' });
  }, 15_000);

  const send = (to: string) =>
    fetch(`${baseA}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${envA.config.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { agent: 'echo', session: 'echo-a', machine: envA.machineId }, to: { agent: 'echo', session: 'echo-topic-1', machine: to }, type: 'info', priority: 'medium', subject: 's', body: 'b' }),
    });

  it('a send to a paired peer lands on that peer (201 received, not queued as unreachable)', async () => {
    const res = await send(envB.machineId);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(201);
    expect(body.phase).toBe('received');
    expect(body.delivered).toBe(true);
    expect(await storeB.exists(String(body.messageId))).toBe(true);
  });

  it('a send to a machine nobody knows answers 502 with a notice, not a silent 201', async () => {
    const res = await send('m_unknown_machine_zz');
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(502);
    expect(body.delivered).toBe(false);
    expect(String(body.notice)).toMatch(/not delivered/);
  });
});
