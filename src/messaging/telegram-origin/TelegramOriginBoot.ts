import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MachineIdentityManager } from '../../core/MachineIdentity.js';
import { IdentityStore } from '../../core/IdentityStore.js';
import { resolveFrameworkBinaryPath } from '../../core/frameworkSessionLaunch.js';
import { resolveIdentityOriginKey } from './OriginIdentityKeys.js';
import { verifyOriginAttestation } from './OriginAttestation.js';
import type { InstarConfig } from '../../core/types.js';
import type { OriginSessionBinding, OriginSessionLifecycle } from './OriginSessionRegistry.js';
import { TelegramOriginRuntime } from './TelegramOriginRuntime.js';
import { resolveOriginDisplay } from './OriginPresentation.js';
import type { OriginDisplaySettings } from './types.js';
import type { OutageNoticeState } from './TelegramOriginOutageNotifier.js';
import { validateProfileFields } from '../../core/topicProfileValidation.js';
import { PlaywrightProfileRegistry } from '../../core/PlaywrightProfileRegistry.js';
import { TelegramWebKDriver } from './TelegramWebKDriver.js';
import { OriginBrowserExecutor } from './OriginBrowserExecutor.js';
import { signMessage } from '../../core/agentSignatureProvenance.js';
import { inspectOriginInstallation } from './OriginInstallation.js';
import type { OriginActivationObservation } from './OriginActivation.js';
import { OriginProductionEnrollment } from './OriginProductionEnrollment.js';
import { OriginConfigReader } from './OriginConfigReader.js';
import { OriginNoticePolicyObserver } from './OriginNoticePolicyObserver.js';
import { projectOriginNoticePolicy } from './OriginNoticePolicy.js';
import type { OriginNoticeDestinationPolicy } from './OriginNoticePolicy.js';
import { OriginDetectorCanary } from './OriginDetectorCanary.js';
import { originDetectorCanaryInterval } from './OriginConfig.js';
import { OriginNativeCanaryLane, type OriginNativeCanary } from './OriginNativeCanaryLane.js';
import { resolveCodexNativeCanaryBinary, runCodexNativeModelCanary } from './OriginCodexModelCanary.js';

/** Production authorities are read independently of the origin/outbox workers.
 * A failed refresh invalidates the policy immediately; reads of the cached
 * snapshot never extend its validity. No fire-time origin database lookup.
 */
export async function bootTelegramOrigin(options: {
  config: InstarConfig;
  /** Compiled worker seam for production-factory lifecycle tests. */
  workerUrl?: URL;
  configWorkerUrl?: URL;
  detectorCanaryWorkerUrl?: URL;
  /** Only a verified isolated native adapter may enroll; no provider fallback. */
  nativeModelCanary?: OriginNativeCanary;
  token?: string;
  noticeOwner: boolean;
  holdsLease: () => boolean;
  isSessionLive?: (binding: OriginSessionBinding) => boolean;
  attachSessionLifecycle?: (lifecycle: OriginSessionLifecycle) => void;
  diagnoseUnknown: (originId: string, reason: string) => Promise<string | void>;
  diagnosticMode?: 'local' | 'delegate';
  reviewLegacyRecovery?: (text: string) => Promise<boolean>;
  authorizeOrigin?: import('./TelegramOriginService.js').OriginServiceOptions['authorizeOrigin'];
  onNoticeState: (state: OutageNoticeState) => void;
  onBrowserRecoveryAttention?: (input: { id: string; profileId: string; publicTransportAlternative: boolean }) => Promise<void>;
  listLiveSessions?: () => Array<{ sessionId: string; harnessId: string | null }>;
  enrollmentObservations?: () => OriginActivationObservation[];
  /** Internal packaged-build fixture seam, never read from agent config or HTTP. */
  enrollmentPackageRoot?: string;
  /** Optional trusted application authority; production defaults to the independent
   * configured-hub observer. Fire-time access must be synchronous and memory-only. */
  readAlertDestinationPolicy?: (destination: OriginNoticeDestinationPolicy['destination']) => OriginNoticeDestinationPolicy | null;
}): Promise<{ runtime: TelegramOriginRuntime; close: () => Promise<void> }> {
  const { config } = options;
  const originConfig = (config.messaging?.find(entry => entry.type === 'telegram')?.config as { messageOrigin?: unknown } | undefined)?.messageOrigin;
  const canaryIntervalMs = originDetectorCanaryInterval(originConfig);
  const identities = new MachineIdentityManager(config.stateDir);
  if (!identities.hasIdentity()) await identities.generateIdentity({ name: 'Local machine' });
  const identity = identities.loadIdentity();
  const originIdentityStore = new IdentityStore({ stateDir: config.stateDir });
  const resolveOriginKey = (machineId: string, epoch?: number) => resolveIdentityOriginKey(originIdentityStore, machineId, config.projectName, epoch);
  const publicMachineName = identities.loadRegistry().machines[identity.machineId]?.nickname ?? `Machine ${identity.machineId.slice(0, 8)}`;
  const demo = (config as InstarConfig & { liveTest?: { demo?: { telegramBotToken?: string; telegramChatId?: string | number } } }).liveTest?.demo;
  const additionalBots = demo?.telegramBotToken && demo.telegramChatId != null
    ? [{ token: demo.telegramBotToken, accountId: demo.telegramBotToken.split(':')[0], producerId: 'telegram-demo' }] : [];
  const configReader = new OriginConfigReader(config.stateDir, options.configWorkerUrl);
  let snapshot: { observedAt: number; configRevision: number; chatId: string; ownerIds: string[]; hub: string | null;
    display: Partial<OriginDisplaySettings>; enabled: boolean; demoChatId: string | null;
    conversationDisplays: Record<string, Partial<OriginDisplaySettings>> } | null = null;
  let closed = false, timer: ReturnType<typeof setTimeout> | undefined, configTimer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    try {
      const observation = await configReader.read();
      const current = observation.config;
      const telegram = current.messaging?.find((m: { type?: string }) => m.type === 'telegram');
      if (!telegram || typeof telegram.config?.chatId !== 'string' ||
        (options.token && (typeof telegram.config.token !== 'string' || telegram.config.token !== options.token))) throw new Error('Telegram config unavailable');
      let hub: string | null = null;
      try {
        const value = JSON.parse(await readFile(path.join(config.stateDir, 'state', 'agent-attention-topic.json'), 'utf8'));
        if (Number.isSafeInteger(value) && value > 0) hub = String(value);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const display = resolveOriginDisplay(telegram.config.messageOrigin?.display);
      const conversationDisplays: Record<string, Partial<OriginDisplaySettings>> = {};
      try {
        const profiles = JSON.parse(await readFile(path.join(config.stateDir, 'state', 'topic-profiles.json'), 'utf8'));
        for (const [topic, entry] of Object.entries(profiles.topics ?? {})) {
          const raw = (entry as { current?: { messageOriginDisplay?: Partial<OriginDisplaySettings> } })?.current?.messageOriginDisplay;
          if (raw == null) continue;
          const validated = validateProfileFields({ messageOriginDisplay: raw }, 'claude-code');
          if (!validated.ok) throw new Error('origin conversation display invalid');
          conversationDisplays[topic] = validated.patch.messageOriginDisplay!;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      snapshot = { observedAt: observation.observedAt, configRevision: observation.revision, chatId: telegram.config.chatId,
        demoChatId: current.liveTest?.demo?.telegramChatId == null ? null : String(current.liveTest.demo.telegramChatId),
        ownerIds: [telegram.config.ownerUserId, telegram.config.promptGate?.ownerId, ...(telegram.config.authorizedUserIds ?? [])]
          .filter((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0).map(String),
        hub, display, conversationDisplays, enabled: telegram.enabled === true };
    } catch { snapshot = null; }
  };
  await refresh();
  const healthy = () => !closed && snapshot !== null && snapshot.configRevision === configReader.revision && Date.now() - snapshot.observedAt <= 30_000;
  const currentChatId = () => snapshot?.chatId;
  const conversationChatId = (chatId: string | null): string | null => {
    if (chatId?.startsWith('channel:')) return `-100${chatId.slice(8)}`;
    if (chatId?.startsWith('chat:')) return `-${chatId.slice(5)}`;
    if (chatId?.startsWith('user:')) return chatId.slice(5);
    return chatId;
  };
  const noticePolicyObserver = options.readAlertDestinationPolicy ? null : await OriginNoticePolicyObserver.open({
    stateDir: config.stateDir, accountId: options.token?.split(':')[0] ?? 'unresolved-tokenless-source', token: options.token, configReader });
  const detectorCanary = new OriginDetectorCanary({ intervalMs: canaryIntervalMs, workerUrl: options.detectorCanaryWorkerUrl, configWorkerUrl: options.configWorkerUrl });
  const codexPath = resolveFrameworkBinaryPath({ framework: 'codex-cli', frameworkBinaryPaths: config.sessions?.frameworkBinaryPaths });
  const nativeModelCanary: OriginNativeCanary | undefined = options.nativeModelCanary ?? (codexPath ? async input => {
    const cliPath = await resolveCodexNativeCanaryBinary(codexPath);
    if (!cliPath || input.signal.aborted) return { state: 'unavailable', cleanupVerified: true };
    return runCodexNativeModelCanary({ ...input, cliPath, scratchParent: os.tmpdir() });
  } : undefined);
  const nativeCanary = new OriginNativeCanaryLane(canaryIntervalMs, nativeModelCanary);
  const runtime = await TelegramOriginRuntime.open({ storage: { stateDir: config.stateDir, agentId: config.projectName }, workerUrl: options.workerUrl,
    identity: { agentId: config.projectName, agentName: config.projectName, originMachineId: identity.machineId, originMachineName: publicMachineName },
    signingKey: { keyId: `${identity.machineId}:${identity.keyEpoch ?? 0}`, keyEpoch: identity.keyEpoch ?? 0, privateKey: identities.loadSigningKey() },
    bot: { token: options.token, accountId: options.token?.split(':')[0] ?? 'unresolved-tokenless-source', chatId: currentChatId() },
    additionalBots,
    isSessionLive: options.isSessionLive, attachSessionLifecycle: options.attachSessionLifecycle,
    display: destination => { if (!healthy()) throw new Error('origin-display-authority-unavailable');
      return { agent: snapshot!.display, conversation: conversationChatId(destination.chatId) === snapshot!.chatId && destination.topicId
        ? snapshot!.conversationDisplays[destination.topicId] : undefined }; },
    authorize: request => healthy() && snapshot!.enabled && options.holdsLease() &&
      (additionalBots.some(bot => bot.accountId === request.accountId)
        ? request.destination.chatId === snapshot!.demoChatId
        : request.destination.chatId === snapshot!.chatId || snapshot!.ownerIds.includes(request.destination.chatId ?? '')),
    diagnoseUnknown: options.diagnoseUnknown,
    diagnosticMode: options.diagnosticMode,
    reviewLegacyRecovery: options.reviewLegacyRecovery,
    resolveOriginKey,
    authorizeOrigin: options.authorizeOrigin ?? (record => {
      try {
        const machineId = record.producerKind === 'imported-legacy' ? record.importedByMachineId : record.originMachineId;
        if (!machineId) return false;
        if (machineId === identity.machineId && (!identities.hasIdentity() || identities.loadIdentity().machineId !== machineId)) return false;
        const entry = identities.loadRegistry().machines[machineId];
        if (machineId !== identity.machineId && (!entry || entry.status !== 'active' || entry.revokedAt)) return false;
        if (entry?.status === 'revoked' || entry?.revokedAt) return false;
        const key = resolveOriginKey(machineId);
        return !!key && verifyOriginAttestation(record, key, { machineId, agentId: config.projectName }).valid;
      } catch { return false; }
    }),
    alertDestinations: () => healthy() && snapshot!.enabled && snapshot!.hub
      ? [{ id: 'operator-attention-hub', chatId: snapshot!.chatId, topicId: snapshot!.hub }] : [],
    getAlertPolicy: id => {
      if (!healthy() || !snapshot!.hub || id !== 'operator-attention-hub') return null;
      const destination = { accountId: options.token?.split(':')[0] ?? 'unresolved-tokenless-source', chatId: snapshot!.chatId, topicId: snapshot!.hub };
      let source: OriginNoticeDestinationPolicy | null = null;
      try { source = options.readAlertDestinationPolicy ? options.readAlertDestinationPolicy(destination) : noticePolicyObserver!.read(destination); } catch { return null; }
      return projectOriginNoticePolicy({ id, destination, source, configObservedAt: snapshot!.observedAt,
        enabled: snapshot!.enabled, ownershipValid: options.holdsLease(),
        display: resolveOriginDisplay(snapshot!.display, snapshot!.conversationDisplays[snapshot!.hub]) });
    },
    onNoticeState: options.onNoticeState,
    ownsCapacityLease: options.holdsLease,
    noticeProcess: { role: options.noticeOwner ? 'owner' : 'client', socketPath: path.join(config.stateDir, 'origin-notice.sock') },
  }).catch(error => { noticePolicyObserver?.close(); configReader.close(); throw error; });
  const close = async () => { closed = true; if (timer) clearTimeout(timer); if (configTimer) clearTimeout(configTimer);
    noticePolicyObserver?.close(); configReader.close();
    await Promise.all([detectorCanary.close(), nativeCanary.close()]); await runtime.close(); };
  try {
  runtime.options.readDetectorHealth = () => ({ sources: { config: configReader.getHealth(),
    noticePolicy: noticePolicyObserver?.getHealth() ?? { state: 'unavailable', reason: 'external-policy-observer-health-not-attached' },
    nativeObservations: runtime.observer.getHealth() },
    canaries: { ownedContracts: detectorCanary.getHealth(), nativeModels: nativeCanary.getHealth() } });
  if (options.attachSessionLifecycle) {
    const registry = new PlaywrightProfileRegistry({ stateDir: config.stateDir, projectDir: config.projectDir, listVaultNames: () => null });
    for (const profile of registry.listProfiles()) {
      if (profile.executionOwner !== 'telegram-origin-broker' || !profile.telegramBroker?.exclusiveEnrollment || !profile.userDataDir) continue;
      const enrollment = profile.telegramBroker;
      let driver: TelegramWebKDriver | undefined;
      const getDriver = () => driver ??= new TelegramWebKDriver({ ...enrollment, expectedAccountId: enrollment.accountId,
        userDataDir: registry.requireTelegramBrokerProfile(profile.id).userDataDir! });
      let signing: { privateKey: Buffer; publicKey: Buffer } | null = null;
      try {
        const identity = JSON.parse(await readFile(path.join(config.stateDir, 'identity.json'), 'utf8'));
        if (typeof identity.privateKey === 'string' && typeof identity.publicKey === 'string' &&
          (!identity.privateKeyEncryption || identity.privateKeyEncryption === 'none')) {
          const privateKey = Buffer.from(identity.privateKey, 'base64'), publicKey = Buffer.from(identity.publicKey, 'base64');
          if (privateKey.length === 32 && publicKey.length === 32) signing = { privateKey, publicKey };
        }
      } catch { /* Missing signing enrollment is a write hold; no unsigned browser fallback. */ }
      const executor = new OriginBrowserExecutor({ service: runtime.service, store: () => runtime.store,
        accountId: enrollment.accountId, transport: 'telegram-web',
        recovery: async action => {
          const result = await runtime.store.browserRecovery({ profileId: profile.id, action });
          if (result.state.attentionId && !result.state.attentionAccepted && options.onBrowserRecoveryAttention) {
            try {
              await options.onBrowserRecoveryAttention({ id: `${profile.id}:${result.state.attentionId}`,
                profileId: profile.id, publicTransportAlternative: result.state.failedBuilds.length >= 2 });
              await runtime.store.browserRecovery({ profileId: profile.id, action: { kind: 'attention-accepted', fence: result.state.fence } });
            } catch { /* Durable pending attention stays visible and is retried by the next bounded recovery action. */ }
          }
          return result;
        },
        signBody: (body, topicId, timestamp) => {
          if (!signing) throw new Error('browser-signing-unavailable');
          return signMessage({ agentId: config.projectName, body, topicId, timestamp, privateKey: signing.privateKey }).text;
        },
        authorize: destination => healthy() && snapshot!.enabled && options.holdsLease() &&
          (conversationChatId(destination.chatId) === snapshot!.chatId || snapshot!.ownerIds.includes(conversationChatId(destination.chatId) ?? '')),
        driverFactory: async () => {
          const current = getDriver();
          return { canary: () => current.canary(), readSnapshot: () => current.readSnapshot(), resolvePeer: destination => current.resolvePeer(destination), invoke: child => current.invoke(child),
            close: async () => { try { await current.close(); } finally { if (driver === current) driver = undefined; } } };
        },
        resolveAgentPublicKey: agentId => agentId === config.projectName ? signing?.publicKey : null,
        isProfileExclusivelyOwned: () => {
          try {
            const live = registry.requireTelegramBrokerProfile(profile.id);
            return live.userDataDir === profile.userDataDir && live.telegramBroker?.exclusiveEnrollment?.proofDigest === enrollment.exclusiveEnrollment!.proofDigest;
          }
          catch { return false; }
        },
        // Signer and Web worker are on this same host; no remote clock inferred.
        clockSkewMs: () => 0,
      });
      runtime.browsers.set(profile.id, { executor, resolvePeer: destination => executor.broker.resolvePeer(destination) });
    }
  }
  const productionEnrollment = new OriginProductionEnrollment({ selfMachineId: identity.machineId,
    packageRoot: options.enrollmentPackageRoot,
    accountId: runtime.options.bot.token ? runtime.options.bot.accountId : null,
    activePeerIds: () => identities.getActiveMachines().map(peer => peer.machineId),
    producerIds: () => runtime.service.listAutomationProducerIds(), peerTransport: () => runtime.enrollmentPeerTransport });
  const inspectEnrollment = async (storageHealthy: boolean) => {
    try {
      runtime.enrollment = await inspectOriginInstallation({ runtime, projectDir: config.projectDir, stateDir: config.stateDir,
        automationOnly: !options.attachSessionLifecycle, sessions: options.listLiveSessions?.(), storageHealthy,
        additionalObservations: [...await productionEnrollment.inspect(), ...(options.enrollmentObservations?.() ?? [])] });
    } catch { runtime.enrollment = null; }
  };
  let initialStorageHealthy = false;
  try { await runtime.confirmRecordingHealthy(); initialStorageHealthy = true; } catch { /* Never certify a failed boot transaction. */ }
  await inspectEnrollment(initialStorageHealthy);
  // Configuration/display freshness must not wait behind origin worker health,
  // retention, or enrollment probes. The destination observer has its own loop.
  const refreshConfig = async () => {
    await refresh();
    if (!closed) { configTimer = setTimeout(() => void refreshConfig(), 5000); configTimer.unref(); }
  };
  configTimer = setTimeout(() => void refreshConfig(), 5000); configTimer.unref();
  const tick = async () => {
    // Reserve a hub that appeared after boot, and re-arm only after a real
    // durable health transaction. This never reopens workers or redelivers work.
    let storageHealthy = false;
    try { await runtime.confirmRecordingHealthy(); storageHealthy = true; }
    catch { /* Origin health/status remains unavailable; no notice permit is granted. */ }
    await inspectEnrollment(storageHealthy);
    await runtime.maintainRetention();
    if (!closed) { timer = setTimeout(() => void tick(), 5000); timer.unref(); }
  };
  timer = setTimeout(() => void tick(), 5000); timer.unref();
  detectorCanary.start(); nativeCanary.start();
  return { runtime, close };
  } catch (error) { await close(); throw error; }
}
