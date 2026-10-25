import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { activateMachineIdentityAfterAuthenticatedPull } from '../../src/core/MachineIdentityActivationGate.js';
import { enforceMachineIdentityBootRecovery } from '../../src/core/MachineIdentityBootRecovery.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { IdentityReannounceClaimant } from '../../src/core/IdentityReannounceClaimant.js';
import { IdentityReannounceService, IssuedRefusalStore } from '../../src/core/IdentityReannounce.js';
import { IdentityStore } from '../../src/core/IdentityStore.js';
import { MachineRecoveryKey, type RecoverySecretStore } from '../../src/core/MachineRecoveryKey.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { signRequest } from '../../src/server/machineAuth.js';
import type { InstarConfig, MachineCapacity } from '../../src/core/types.js';

class Keychain implements RecoverySecretStore {
  readonly isKeychainBacked = true;
  readonly values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key); }
  set(key: string, value: unknown): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
}

const roots: string[] = [];
const servers: AgentServer[] = [];
const coordinators: MultiMachineCoordinator[] = [];
const removeTree = (target: string) => SafeFsExecutor.safeRmSync(target, {
  recursive: true, force: true, operation: 'machine-identity-double-fault-network-recovery.test:cleanup',
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const coordinator of coordinators.splice(0)) coordinator.stop();
  for (const root of roots.splice(0)) removeTree(root);
  ProcessIntegrity.reset();
});

function config(root: string, token: string, bearer: string): InstarConfig {
  return {
    projectName: path.basename(root), projectDir: root, stateDir: path.join(root, '.instar'),
    port: 0, host: '127.0.0.1', authToken: token, dashboardPin: '642913', requestTimeoutMs: 10_000,
    version: '1.3.1217', developmentAgent: true,
    multiMachine: {
      identityReannounce: { enabled: true, dryRun: false, sharedBearerToken: bearer },
      observedEndpoints: { enabled: true, dryRun: false },
      recoveryKeyEscrow: { enabled: true, dryRun: false },
    },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
}

function httpPort(server: AgentServer): number {
  const address = (server as unknown as { server: Server }).server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  return address.port;
}

function makeServer(cfg: InstarConfig, manager: MachineIdentityManager): { server: AgentServer; coordinator: MultiMachineCoordinator } {
  const state = new StateManager(cfg.stateDir);
  const coordinator = new MultiMachineCoordinator(state, {
    stateDir: cfg.stateDir, multiMachine: cfg.multiMachine, developmentAgent: true,
  });
  coordinator.start();
  const server = new AgentServer({
    config: cfg,
    sessionManager: { listRunningSessions: () => [], getSession: () => null, on: () => undefined } as never,
    state, coordinator, localSigningKeyPem: manager.loadSigningKey(),
  });
  servers.push(server);
  coordinators.push(coordinator);
  return { server, coordinator };
}

describe('E2E total machine-key loss across a real peer', () => {
  it('re-announces with pinned recovery continuity before the first authenticated activation pull', async () => {
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize('1.3.1217-test', null);
    const claimantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-double-fault-claimant-'));
    const peerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-double-fault-peer-'));
    roots.push(claimantRoot, peerRoot);
    const bearer = 'a'.repeat(64);
    const claimantConfig = config(claimantRoot, 'claimant-auth', bearer);
    const peerConfig = config(peerRoot, 'peer-auth', bearer);
    const claimantManager = new MachineIdentityManager(claimantConfig.stateDir);
    const peerManager = new MachineIdentityManager(peerConfig.stateDir);
    const claimantGenesis = await claimantManager.generateIdentity({ name: 'claimant', role: 'awake' });
    const peerIdentity = await peerManager.generateIdentity({ name: 'peer', role: 'standby' });
    const keychain = new Keychain();
    const recovery = new MachineRecoveryKey(keychain);
    const claimantEstablished = claimantManager.establishLocalRecoveryKey(recovery.ensure(claimantGenesis.machineId)!);
    recovery.rememberIdentity(claimantEstablished);

    claimantManager.registerMachine(peerIdentity, 'standby');
    claimantManager.storeRemoteIdentity(peerIdentity);
    peerManager.registerMachine(claimantEstablished, 'awake');
    peerManager.storeRemoteIdentity(claimantEstablished);

    removeTree(path.join(claimantConfig.stateDir, 'machine'));
    expect(await enforceMachineIdentityBootRecovery({
      config: claimantConfig, manager: claimantManager, recoveryStore: keychain,
    })).toBe('coherence-held');
    const recovered = claimantManager.loadIdentity();
    expect(recovered.keyEpoch).toBe((claimantEstablished.keyEpoch ?? 0) + 1);

    const peerStore = new IdentityStore({ stateDir: peerConfig.stateDir });
    const peerReannounce = new IdentityReannounceService({
      stateDir: peerConfig.stateDir,
      identityStore: peerStore,
      issuedRefusals: new IssuedRefusalStore({ stateDir: peerConfig.stateDir }),
      challengerMachineId: peerIdentity.machineId,
      dryRun: () => false,
    });
    const peerRuntime = makeServer(peerConfig, peerManager);
    peerRuntime.server.setIdentityRecoveryRuntime({
      identityStore: peerStore,
      identityReannounce: peerReannounce,
      resolveIdentityReannounceContext: async () => ({
        sourceVerifiedUnderIncumbent: false,
        recoveryAgreement: 'consistent',
        signingAgreement: 'consistent',
        governorAllowed: true,
        unackedAcceptedRotation: false,
      }),
    });
    await peerRuntime.server.start();
    const peerUrl = `http://127.0.0.1:${httpPort(peerRuntime.server)}`;
    claimantManager.updateMachineUrl(peerIdentity.machineId, peerUrl);

    const claimantRuntime = makeServer(claimantConfig, claimantManager);
    await claimantRuntime.server.start();
    const claimant = new IdentityReannounceClaimant({
      stateDir: claimantConfig.stateDir,
      identity: () => claimantManager.loadIdentity(),
      signingPrivateKey: () => claimantManager.loadSigningKey(),
      recoveryContinuitySignature: (binding) => recovery.signContinuity(recovered.machineId, binding),
      peers: () => [{ machineId: peerIdentity.machineId, url: peerUrl }],
      requestChallenge: async (peer, machineIdentity) => {
        const response = await fetch(`${peer.url}/api/identity/reannounce/challenge`, {
          method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ machineIdentity }),
        });
        if (!response.ok) throw new Error(`challenge-${response.status}`);
        return await response.json();
      },
      submitClaim: async (peer, claim) => {
        const response = await fetch(`${peer.url}/api/identity/reannounce/claim`, {
          method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ claim }),
        });
        return await response.json();
      },
      admit: async () => true,
      notify: () => {},
    });

    claimant.openContinuityRecovery();
    await claimant.tick();
    expect(claimant.status().episodes[`${recovered.machineId}:${recovered.keyEpoch}`].peers[peerIdentity.machineId].status)
      .toBe('accepted');
    expect(peerStore.loadIdentity(recovered.machineId, 'remote')).toMatchObject({
      keyEpoch: recovered.keyEpoch, signingPublicKey: recovered.signingPublicKey,
    });

    const modes = {
      'identityReannounce.enabled': 'live' as const,
      'observedEndpoints.enabled': 'live' as const,
      'recoveryKeyEscrow.enabled': 'live' as const,
    };
    let capacities: MachineCapacity[] = [];
    const activated = await activateMachineIdentityAfterAuthenticatedPull({
      pullAuthenticatedPresence: async () => {
        const body = { reqNonce: 'activation-after-recovery' };
        const response = await fetch(`${peerUrl}/api/lease/pull`, {
          method: 'POST', headers: { ...signRequest(recovered.machineId, claimantManager.loadSigningKey(), body), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        capacities = [{
          machineId: peerIdentity.machineId, online: true, sessions: 0, maxSessions: 1, availableSlots: 1,
          loadAvg: 0, memoryPressure: 'normal', coherenceAdvertReceivedAt: new Date().toISOString(),
          coherenceAdvert: {
            instarVersion: '1.3.1217', protocolVersion: 1, manifestHash: 'b'.repeat(64), guard: 'dry-run', beatSeq: 1,
            flags: modes,
          },
        } as MachineCapacity];
      },
      selfMachineId: recovered.machineId,
      requiredPeerMachineIds: [peerIdentity.machineId],
      capacities: () => capacities,
      localModes: modes,
      stateDir: claimantConfig.stateDir,
    });
    expect(activated.allowed).toBe(true);
  }, 30_000);
});
