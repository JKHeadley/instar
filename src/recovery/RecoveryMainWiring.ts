/**
 * Starts the main server's view of server-down recovery. The separately
 * supervised SSH and relay listeners stay alive across this server's restart
 * and shutdown; this only observes them.
 *
 * Lives outside src/commands/server.ts because that file's startup function is
 * at the TypeScript compiler's control-flow limit (TS2563).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LiveConfig } from '../config/LiveConfig.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import type { MachineIdentityManager } from '../core/MachineIdentity.js';
import type { MeshRpcClient } from '../core/MeshRpcClient.js';
import type { MultiMachineCoordinator } from '../core/MultiMachineCoordinator.js';
import type { StateManager } from '../core/StateManager.js';
import type { InstarConfig, MeshEndpoint } from '../core/types.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import type { bootTelegramOrigin } from '../messaging/telegram-origin/TelegramOriginBoot.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import type { RecoveryEnrollmentAdvert } from './RecoveryEnrollment.js';
import type { Signed } from './RecoveryProtocol.js';
import type { RecoveryRuntime } from './RecoveryRuntime.js';
import type { RecoverySetupRuntime } from './RecoverySetupRuntime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RecoveryMainWiringDeps {
  config: InstarConfig;
  liveConfig: Pick<LiveConfig, 'set'>;
  state: Pick<StateManager, 'get' | 'set'>;
  coordinator: Pick<MultiMachineCoordinator, 'isRouter' | 'getLeaseEpoch'>;
  identity: Pick<MachineIdentityManager, 'getActiveMachines' | 'getSigningPublicKeyPem'>;
  meshClient: Pick<MeshRpcClient, 'send'>;
  peerUrl: (machineId: string) => string | null;
  machineId: string;
  machineSigningKey: string;
  selfEndpoints: MeshEndpoint[];
  /** Read when a notice is sent: the origin service may boot after this starts, or not at all. */
  telegramOriginBoot: () => Awaited<ReturnType<typeof bootTelegramOrigin>> | undefined;
}

/**
 * A machine's pairedAt is its membership epoch, not a pair epoch. The symmetric
 * maximum changes when either membership changes and is identical from both
 * sides of an agreed MachineAuth registry.
 */
export function recoveryPairedPeers(identity: RecoveryMainWiringDeps['identity'], machineId: string) {
  const active = identity.getActiveMachines(), self = active.find(row => row.machineId === machineId);
  const selfEpoch = Date.parse(self?.entry.pairedAt ?? '');
  if (!Number.isSafeInteger(selfEpoch) || selfEpoch < 1) return [];
  return active.filter(row => row.machineId !== machineId).map(row => ({
    machineId: row.machineId,
    pairingEpoch: Math.max(selfEpoch, Date.parse(row.entry.pairedAt)),
    publicKey: identity.getSigningPublicKeyPem(row.machineId) ?? '',
  }));
}

/** The first private or Tailscale address this machine advertises; '' when it has none. */
export function recoveryDirectHost(endpoints: MeshEndpoint[]): string {
  return endpoints.flatMap(endpoint => {
    try { return [new URL(endpoint.url).hostname]; } catch { return []; }
  }).find(host => /^(100\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) ?? '';
}

function readReleaseRoot(): string | null {
  const root = path.resolve(__dirname, '../keys/instar-recovery-certification-root.pem');
  try { return fs.readFileSync(root, 'utf8'); } catch {
    DegradationReporter.getInstance().report({ feature: 'ServerDownRecovery.releaseRoot', primary: 'Installed release certification public key', fallback: 'Recovery setup remains incomplete', reason: 'Installed release certification key cannot be read', impact: 'No recovery authority or host admission can be trusted.' });
    return null;
  }
}

function readHostSshKey(): string {
  try { return fs.readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8'); } catch {
    DegradationReporter.getInstance().report({ feature: 'ServerDownRecovery.hostSshKey', primary: 'Pinned local host sshd key', fallback: 'Recovery setup remains incomplete', reason: 'Host SSH public key cannot be read', impact: 'The direct recovery route cannot be enrolled or counted as ready.' });
    return '';
  }
}

export async function startRecoveryMainWiring(deps: RecoveryMainWiringDeps): Promise<RecoveryRuntime> {
  const { config, liveConfig, state, coordinator, identity, meshClient, peerUrl, machineId, machineSigningKey } = deps;
  const { RecoveryRuntime } = await import('./RecoveryRuntime.js');
  const { RecoverySetupRuntime } = await import('./RecoverySetupRuntime.js');
  const recoveryPaired = () => recoveryPairedPeers(identity, machineId);

  const setup = new RecoverySetupRuntime({
    stateDir: config.stateDir, agentId: config.projectName, machineId,
    machineSigningKey,
    membershipEpochs: () => Object.fromEntries(identity.getActiveMachines().map(row => [row.machineId, Date.parse(row.entry.pairedAt)])),
    machineName: verifiedEntityName(machineId, identity.getActiveMachines().find(r => r.machineId === machineId)?.entry.nickname) ?? 'This machine',
    machineNames: () => Object.fromEntries(identity.getActiveMachines().filter(r => r.machineId !== machineId).map(r => [r.machineId, verifiedEntityName(r.machineId, r.entry.nickname ?? r.entry.name) ?? 'Another machine'])),
    paired: recoveryPaired,
    releaseRoot: readReleaseRoot,
    activate: async () => {
      liveConfig.set('multiMachine.serverDownRecovery.enabled', true);
      if (config.multiMachine) config.multiMachine.serverDownRecovery = { ...config.multiMachine.serverDownRecovery, enabled: true };
      await runtime.enable();
    },
    peerAdvert: async peer => {
      const url = peerUrl(peer); if (!url) throw new Error('recovery-peer-unreachable');
      const result = await meshClient.send({ machineId: peer, url }, { type: 'recovery-enrollment-advert' }, 0, { timeoutMs: 15_000 });
      if (!result.ok) throw new Error('recovery-peer-unreachable');
      return result.result as Signed<RecoveryEnrollmentAdvert>;
    },
    directHost: recoveryDirectHost(deps.selfEndpoints), sshPort: config.multiMachine?.peerExecution?.port ?? 22,
    sshHostPublicKey: readHostSshKey(),
    username: os.userInfo().username, agentHome: os.homedir(),
    mainServicePlist: path.join(os.homedir(), 'Library', 'LaunchAgents', `ai.instar.${config.projectName}.plist`),
    mainHealthPort: config.port, mainAuthToken: config.authToken ?? '',
    entrypoint: path.resolve(__dirname, '../../scripts/recovery-entrypoint.mjs'),
  });
  (globalThis as { __instarRecoverySetup?: RecoverySetupRuntime }).__instarRecoverySetup = setup;

  const { RecoveryRepairCoordinator } = await import('./RecoveryRepairCoordinator.js');
  const repair = new RecoveryRepairCoordinator({
    stateDir: config.stateDir,
    lease: () => ({ eligible: coordinator.isRouter(), epoch: coordinator.getLeaseEpoch() }),
    paired: target => recoveryPaired().some(row => row.machineId === target.targetMachineId && row.pairingEpoch === target.pairingEpoch),
    notify: async (key, message) => {
      const originBoot = deps.telegramOriginBoot();
      if (!originBoot) throw new Error('recovery-notice-outbox-unavailable');
      const savedTopic = state.get<number>('recovery-notice-topic:' + key), topic = savedTopic ?? state.get<number>('agent-attention-topic');
      if (!topic) throw new Error('recovery-notice-destination-unavailable');
      if (!savedTopic) state.set('recovery-notice-topic:' + key, topic);
      const origin = originBoot.runtime, producerId = 'server-down-recovery-notice';
      const operationId = origin.service.automationOperationId(producerId, topic, key);
      const { postOriginAutomationReply } = await import('../messaging/telegram-origin/OriginAutomationReply.js');
      const { deterministicAutomationAuthor } = await import('../messaging/telegram-origin/OriginAutomationAuthor.js');
      const response = await postOriginAutomationReply({ service: origin.service, port: config.port, authToken: config.authToken ?? '', producerId, topicId: topic,
        logicalSendId: key, author: deterministicAutomationAuthor(), body: { text: message, metadata: { messageKind: 'health-alert' } } });
      await response.body?.cancel();
      const record = await origin.store.getOperation(operationId);
      if (!record?.operation || record.operation.operationId !== operationId) throw new Error('recovery-notice-outbox-pending');
      return { operationId };
    },
  });
  const enabled = resolveDevAgentGate(config.multiMachine?.serverDownRecovery?.enabled, config);
  const runtime = new RecoveryRuntime({
    stateDir: config.stateDir, agentId: config.projectName, machineId,
    enabled,
    entrypoint: path.resolve(__dirname, '../../scripts/recovery-entrypoint.mjs'),
    onStatus: (target, route, healthy, evidence) => repair.observe(target, route, healthy, evidence),
    repairStatus: target => repair.status(target),
    onPending: target => repair.retryPending(target),
    onRouteFailure: (target, route, security) => repair.routeLost(target, route, security),
    onRouteSuccess: (target, route, evidence) => repair.routeRestored(target, route, evidence),
    onSetupRequired: async reason => {
      if (!coordinator.isRouter() || state.get<string>('recovery-setup-blocker-id')) return;
      try {
        const response = await fetch(`http://127.0.0.1:${config.port}/blockers`, { method: 'POST', headers: { Authorization: `Bearer ${config.authToken ?? ''}`, 'Content-Type': 'application/json', 'X-Instar-Request': '1' },
          body: JSON.stringify({ detectedText: 'Paired machines do not have verified server-down recovery. Recovery setup must inspect existing authority and owner-phone enrollment, then prepare the phone approval surface before any human handoff.', origin: 'server-down-recovery:' + machineId + ':' + reason }), signal: AbortSignal.timeout(5_000) });
        if (response.ok) { const opened = await response.json() as { id?: string }; if (opened.id) state.set('recovery-setup-blocker-id', opened.id); }
        else { await response.body?.cancel(); console.warn('[recovery] setup blocker ledger unavailable; recovery remains visibly degraded'); }
      } catch { console.warn('[recovery] setup blocker recording unavailable; recovery remains visibly degraded'); }
    },
    paired: recoveryPaired,
  });
  (globalThis as { __instarRecoveryRuntime?: RecoveryRuntime }).__instarRecoveryRuntime = runtime;
  if (enabled) {
    try { await setup.refreshOwnedBindings(); }
    catch { DegradationReporter.getInstance().report({ feature: 'ServerDownRecovery.mainBindingRefresh', primary: 'Current trusted local main credentials', fallback: 'Existing recovery binding remains degraded', reason: 'Owned binding refresh could not be verified', impact: 'Recovery cannot be counted ready until its exact main-service binding is restored.' }); }
  }
  await runtime.start();
  return runtime;
}
