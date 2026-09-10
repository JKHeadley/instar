import { randomUUID } from 'node:crypto';
import { DegradationReporter } from '../../monitoring/DegradationReporter.js';
import { OriginStore } from './OriginStore.js';
import { OriginSessionRegistry } from './OriginSessionRegistry.js';
import type { OriginSessionBinding, OriginSessionLifecycle } from './OriginSessionRegistry.js';
import { RuntimeOriginObserver } from './RuntimeOriginObserver.js';
import { TelegramOriginService } from './TelegramOriginService.js';
import type { OriginServiceOptions } from './TelegramOriginService.js';
import { TelegramOriginOutageNotifier } from './TelegramOriginOutageNotifier.js';
import type { OutageNoticeState, OutagePolicyProjection } from './TelegramOriginOutageNotifier.js';
import { prepareOriginOutageNotice } from './OriginOutagePreparation.js';
import { registerOriginBot, requirePreparedOriginEgress } from './OriginBotEgress.js';
import { telegramFetch } from '../telegram-egress.js';
import type { OriginStoreOptions } from './StoreTypes.js';
import { callOriginNotice, listenOriginNotices, originCapacityClient } from './OriginNoticeIpc.js';
import { OriginEgressCapacity, ORIGIN_CAPACITY_WINDOW_MS } from './OriginEgressCapacity.js';
import type { OriginCapacityAuthority } from './OriginEgressCapacity.js';
import { parseOriginJson } from './CanonicalOrigin.js';
import type { TelegramOriginRecord } from './types.js';
import type { OriginSendPolicyAuthority } from './OriginSendPolicy.js';
import type { OriginBrowserExecutor } from './OriginBrowserExecutor.js';
import type { BrowserDestination, BrowserJson } from './BrowserTypes.js';
import { OriginPoolAudit } from './OriginPoolAudit.js';
import { assessOriginActivation, type OriginEnrollmentSnapshot } from './OriginActivation.js';
import { verifyHistoricalOriginAttestation } from './OriginAttestation.js';
import type { OriginVerificationKey } from './OriginAttestation.js';

export interface TelegramOriginRuntimeOptions {
  storage: OriginStoreOptions;
  identity: OriginServiceOptions['identity'];
  signingKey: OriginServiceOptions['signingKey'];
  bot: { token?: string; accountId: string; chatId?: string };
  additionalBots?: Array<{ token: string; accountId: string; producerId: string }>;
  isSessionLive?: (binding: OriginSessionBinding) => boolean;
  /** Omitted by automation-only processes such as the lifeline. */
  attachSessionLifecycle?: (lifecycle: OriginSessionLifecycle) => void;
  display: OriginServiceOptions['display'];
  authorize: OriginServiceOptions['authorize'];
  authorizeOrigin?: OriginServiceOptions['authorizeOrigin'];
  resolveOriginKey?: (machineId: string, epoch?: number) => OriginVerificationKey | null;
  reviewLegacyRecovery?: OriginServiceOptions['reviewLegacyRecovery'];
  peerEvidence?: OriginServiceOptions['peerEvidence'];
  diagnoseUnknown: NonNullable<OriginServiceOptions['diagnoseUnknown']>;
  diagnosticMode?: OriginServiceOptions['diagnosticMode'];
  /** Existing operator notification authority; never derive the hub from the held recipient. */
  alertDestinations: () => Array<{ id: string; chatId: string; topicId: string | null }>;
  getAlertPolicy: (destinationId: string) => OutagePolicyProjection | null;
  onNoticeState: (state: OutageNoticeState) => void;
  /** Test seam for the identical worker implementation, built in an isolated directory. */
  workerUrl?: URL;
  noticeProcess?: { role: 'owner' | 'client'; socketPath: string };
  /** Independently refreshed credential-owner lease, not origin-store health. */
  ownsCapacityLease?: () => boolean;
  /** Synchronous diagnostics, independent of worker/transport authority. */
  readDetectorHealth?: () => Record<string, unknown>;
}

/** One credential-owner process. Both server and lifeline use this initialization
 * path; the serving/polling lease decides which one may execute, not this object.
 */
export class TelegramOriginRuntime {
  auditVerification(row: import('./StoreTypes.js').OriginAuditRecord) {
    try {
      const record = JSON.parse(row.record.envelopeJson) as TelegramOriginRecord;
      const machineId = record.producerKind === 'imported-legacy' ? record.importedByMachineId : record.originMachineId;
      const key = machineId && record.attestation && this.options.resolveOriginKey?.(machineId, record.attestation.keyEpoch);
      return { ...row, currentVerification: key ? verifyHistoricalOriginAttestation(record, key, row.acceptanceVerification ?? null)
        : { signatureValid: null, keyStatus: 'unknown', signedDuringKnownValidity: 'unknown', acceptedVerifiedAt: row.acceptanceVerification?.verifiedAt ?? null,
          verificationBeforeRevocation: 'unknown' } };
    } catch { return { ...row, currentVerification: { signatureValid: null, keyStatus: 'unknown', signedDuringKnownValidity: 'unknown',
      acceptedVerifiedAt: null, verificationBeforeRevocation: 'unknown' } }; }
  }
  /** Attached to the existing route authority after route initialization. A
   * covered send before attachment is held by the service, never fail-open. */
  attachSendPolicy(authority: OriginSendPolicyAuthority): void { this.service.options.sendPolicy = authority; }
  /** Set by production enrollment, independently of the durable origin worker. */
  enrollment: OriginEnrollmentSnapshot | null = null;
  enrollmentPeerTransport?: import('./OriginProductionEnrollment.js').OriginEnrollmentPeerTransport;
  private retentionRunning = false;
  private retentionAttemptedAt = 0;
  private retentionSucceededAt: number | null = null;
  private retentionUnavailable = false;
  poolAudit?: import('./OriginPoolAudit.js').OriginPoolAudit;
  readonly browsers = new Map<string, { executor: OriginBrowserExecutor;
    resolvePeer: (destination: BrowserDestination) => Promise<{ [key: string]: BrowserJson }> }>();
  readonly ownerBootId = randomUUID();
  readonly observer = new RuntimeOriginObserver();
  readonly sessions: OriginSessionRegistry;
  readonly service: TelegramOriginService;
  readonly notifier: TelegramOriginOutageNotifier;
  readonly capacity: OriginCapacityAuthority;
  private capacityOwner?: OriginEgressCapacity;
  private capacityReadyAt = 0;
  private readonly unregister: () => void;
  private closed = false;
  private lastWorkerReopenAt = 0;
  private recovering = false;
  private importingLegacy = false;
  private stopNoticeIpc?: () => Promise<void>;
  private remoteNotices = new Map<string, OutageNoticeState>();
  private constructor(readonly options: TelegramOriginRuntimeOptions, public store: OriginStore, public spool: OriginStore) {
    requirePreparedOriginEgress();
    if (options.noticeProcess?.role === 'client') {
      const client = originCapacityClient(options.noticeProcess.socketPath);
      this.capacity = {
        reserve: async accountId => this.closed ? null : client.reserve(accountId),
        consume: async grant => !this.closed && await client.consume(grant) && !this.closed,
      };
    }
    else {
      this.capacity = this.capacityOwner = new OriginEgressCapacity({ ownerBootId: this.ownerBootId,
        accountIds: () => [options.bot, ...(options.additionalBots ?? [])].filter(bot => bot.token).map(bot => bot.accountId),
        ownsLease: options.ownsCapacityLease ?? (() => !options.noticeProcess) });
      this.capacityReadyAt = Date.now() + ORIGIN_CAPACITY_WINDOW_MS;
    }
    this.poolAudit = new OriginPoolAudit({ shardIds: () => [options.identity.originMachineId], readShard: (_, query) => this.store.listOrigins(query),
      readShardMetrics: machineId => this.store.getFederatedMetrics(machineId) });
    this.sessions = new OriginSessionRegistry({ stateDir: options.storage.stateDir,
      agentId: options.identity.agentId, machineId: options.identity.originMachineId, isSessionLive: options.isSessionLive });
    this.service = new TelegramOriginService({ store, sessions: this.sessions, observer: this.observer,
      identity: options.identity, signingKey: options.signingKey, ownerBootId: this.ownerBootId,
      display: options.display, authorize: options.authorize, spoolEvidence: record => this.spool.putEvidence(record),
      authorizeOrigin: options.authorizeOrigin,
      capacity: this.capacity,
      reviewLegacyRecovery: options.reviewLegacyRecovery,
      peerEvidence: options.peerEvidence, diagnoseUnknown: options.diagnoseUnknown,
      diagnosticMode: options.diagnosticMode,
      onHold: ({ reason }) => {
        if (!['all-durable-recording-sinks-unavailable', 'execution-admission-unavailable',
          'origin-execution-state-unavailable', 'held-payload-capacity-unavailable'].includes(reason)) return;
        for (const destination of options.alertDestinations()) {
          if (options.noticeProcess?.role === 'client') {
            void callOriginNotice(options.noticeProcess.socketPath, destination.id, 'request')
              .then(state => { this.remoteNotices.set(destination.id, state); options.onNoticeState(state); })
              .catch(() => {
                const state: OutageNoticeState = { alertDestinationId: destination.id, notificationAttempted: false,
                  notificationOutcome: 'unavailable', reason: 'notice-owner-ipc-unavailable', generation: null,
                  materializationId: null, updatedAt: Date.now() };
                this.remoteNotices.set(destination.id, state); options.onNoticeState(state);
              });
          } else this.notifier.requestHoldNotice(destination.id);
        }
      },
    });
    this.notifier = new TelegramOriginOutageNotifier({ ownerBootId: this.ownerBootId,
      capacity: this.capacity,
      getPolicy: options.getAlertPolicy, onState: options.onNoticeState,
      prepareFixedNotice: async id => {
        const destination = options.alertDestinations().find(d => d.id === id);
        if (!destination) throw new Error('origin-notice: destination revoked');
        return prepareOriginOutageNotice(this.service, { ...destination, accountId: options.bot.accountId });
      },
      reserveNotice: input => this.store.reserveNotice(input),
      persistOutcome: async (reservation, state, response) => {
        const result = await this.store.recordNoticeOutcome({ ...reservation,
          materializationId: state.materializationId ?? reservation.materializations[0].materializationId,
          outcome: state.notificationOutcome === 'accepted' ? 'accepted' : state.notificationOutcome === 'known-failed' ? 'known-failed'
            : state.notificationOutcome === 'suppressed' ? 'suppressed' : 'outcome-unknown',
          ...(response ? { receiptJson: response } : {}),
        });
        if (!result.recorded) throw new Error(`origin-notice: ${result.reason}`);
      },
      sendOnce: (request, capability) => {
        if (!options.bot.token) throw new Error('origin-source-has-no-transport-credential');
        return telegramFetch(`https://api.telegram.org/bot${options.bot.token}/${request.method}`,
        { method: 'POST', headers: { 'Content-Type': request.contentType }, body: request.body,
          networkTimeoutMs: 10_000 }, capability);
      },
    });
    // A tokenless source prepares and records evidence but owns no Bot API door.
    const unregister: Array<() => void> = [];
    try {
      const accounts = [options.bot, ...(options.additionalBots ?? [])].filter(bot => bot.token);
      if (accounts.length > 16 || new Set(accounts.map(bot => bot.accountId)).size !== accounts.length ||
        new Set(accounts.map(bot => bot.token)).size !== accounts.length) throw new Error('origin-credential-enrollment-conflict');
      if (options.bot.token) unregister.push(registerOriginBot(options.bot.token, options.bot.accountId, this.service));
      for (const bot of options.additionalBots ?? []) unregister.push(registerOriginBot(bot.token, bot.accountId, this.service, bot.producerId));
    } catch (error) { for (const release of unregister.reverse()) release(); throw error; }
    this.unregister = () => { for (const release of unregister.reverse()) release(); };
  }

  static async open(options: TelegramOriginRuntimeOptions): Promise<TelegramOriginRuntime> {
    const store = await OriginStore.openForRuntime(options.storage, undefined, options.workerUrl);
    let spool: OriginStore | undefined, runtime: TelegramOriginRuntime | undefined;
    try {
      spool = await OriginStore.openForRuntime(options.storage, 'spool', options.workerUrl);
      runtime = new TelegramOriginRuntime(options, store, spool);
      if (options.attachSessionLifecycle) {
        if (!options.isSessionLive) throw new Error('origin-session-liveness-required');
        await runtime.sessions.initialize();
        for (const binding of runtime.sessions.listBindings()) {
          if (options.isSessionLive(binding)) runtime.observer.track(binding);
          else await runtime.sessions.revoke(binding.sessionId);
        }
      }
      const lifecycle: OriginSessionLifecycle = {
        issue: async launch => {
          if (runtime!.closed) throw new Error('origin-runtime-closed');
          const token = await runtime!.sessions.issue(launch);
          runtime!.observer.track(runtime!.sessions.getBinding(launch.sessionId)!);
          return token;
        },
        bindNative: (sessionId, nativeId) => runtime!.observer.bindNative(sessionId, nativeId),
        revoke: sessionId => { runtime!.observer.untrack(sessionId); return runtime!.sessions.revoke(sessionId); },
      };
      // Prepare the existing hub's exact notice while storage is known healthy,
      // before session credentials permit ordinary preparation.
      try { await runtime.confirmRecordingHealthy(); }
      catch { console.warn('[telegram-origin] recording unavailable at boot; ordinary sends held and no old notice permit restored'); }
      if (options.noticeProcess?.role === 'owner') {
        runtime.stopNoticeIpc = await listenOriginNotices(options.noticeProcess.socketPath, runtime.notifier,
          () => options.alertDestinations().map(d => d.id), runtime.capacity);
      }
      options.attachSessionLifecycle?.(lifecycle);
      runtime.observer.start();
      try { await runtime.importLegacyQueue(); }
      catch { console.warn('[telegram-origin] legacy import unavailable; legacy redrive stays disabled'); }
      // A replacement owner cannot overlap old, still-valid credits. Keep the
      // quiet interval before exposing a ready runtime; IPC fails closed meanwhile.
      if (runtime.capacityReadyAt > Date.now()) await new Promise(resolve => setTimeout(resolve, runtime!.capacityReadyAt - Date.now()));
      return runtime;
    } catch (error) {
      if (runtime) await runtime.close();
      else { await store.close(); await spool?.close(); }
      throw error;
    }
  }

  async confirmRecordingHealthy(): Promise<void> {
    if (this.closed) throw new Error('origin-runtime-closed');
    await this.store.healthTransaction();
    await this.store.registerOwner({ ownerBootId: this.ownerBootId, machineId: this.options.identity.originMachineId });
    if (this.options.bot.token && this.options.noticeProcess?.role !== 'client') await this.notifier.recordingRecovered(this.options.alertDestinations().map(d => d.id));
  }
  async status() {
    if (this.options.noticeProcess?.role === 'client') {
      for (const destination of this.options.alertDestinations()) {
        try { this.remoteNotices.set(destination.id, await callOriginNotice(this.options.noticeProcess.socketPath, destination.id, 'status')); }
        catch { this.remoteNotices.delete(destination.id); }
      }
    }
    let detectorHealth: Record<string, unknown>;
    try { detectorHealth = this.options.readDetectorHealth?.() ?? { sources: { state: 'unavailable', reason: 'detector-health-not-attached' }, canaries: { state: 'unavailable', reason: 'detector-canaries-not-attached' } }; }
    catch { detectorHealth = { state: 'unavailable', reason: 'detector-health-unavailable' };
      DegradationReporter.getInstance().report({ feature: 'telegram-origin.detector-health', primary: 'Read detector diagnostics',
        fallback: 'Return explicit unavailable health', reason: 'Detector health projection failed', impact: 'Diagnostics are unavailable; no delivery authority changed.' }); }
    return { detectorHealth, activation: assessOriginActivation(this.closed ? null : this.enrollment), metrics: await this.service.metrics(),
      browserRecovery: await this.store.getBrowserRecoveryStates().then(states => ({ coverage: 'complete', states }))
        .catch(() => ({ coverage: 'unknown', states: null })),
      retention: { running: this.retentionRunning, succeededAt: this.retentionSucceededAt, unavailable: this.retentionUnavailable },
      held: this.service.heldStatus(),
      expiredHolds: this.service.expiredHeldStatus(),
      browsers: [...this.browsers].map(([profileId, browser]) => ({ profileId, ...browser.executor.broker.readStatus() })),
      notices: this.options.alertDestinations().map(d => this.remoteNotices.get(d.id) ?? this.notifier.getState(d.id)) };
  }
  /** Existing runtime maintenance tick owns cleanup and archival; this never
   * dispatches or grants retry authority. Work is bounded and off-event-loop. */
  async maintainRetention(now = Date.now()): Promise<void> {
    if (this.closed || this.retentionRunning || now - this.retentionAttemptedAt < 60_000) return;
    this.retentionAttemptedAt = now; this.retentionRunning = true;
    try {
      await this.store.cleanupPayloads(now);
      await this.store.archive({ before: now - 30 * 24 * 60 * 60_000, limit: 100 });
      this.retentionSucceededAt = now; this.retentionUnavailable = false;
    } catch { this.retentionUnavailable = true; }
    finally { this.retentionRunning = false; }
  }
  /** Called by the existing recovery scheduler, never by a second retry loop.
   * One bounded worker reopen per fifteen minutes; replay uses the original
   * operation, children, bytes, deadline, and claims rather than minting a send.
   */
  async recoverHeld(): Promise<{ processed: number; recovered: number }> {
    if (this.closed || this.recovering) return { processed: 0, recovered: 0 };
    this.recovering = true;
    let processed = 0, recovered = 0;
    try {
      // Healthy workers may be holding another operation's receipt transaction.
      // Never replace them merely because a queue drain was requested. The
      // fifteen-minute restart brake applies only to failed worker generations;
      // healthy queued work uses the existing scheduler and its own retry times.
      if (this.store.isUnavailable() || this.spool.isUnavailable()) {
        const mayReopen = Date.now() - this.lastWorkerReopenAt >= 15 * 60_000;
        if (!mayReopen && this.store.isUnavailable()) return { processed, recovered };
        if (mayReopen) {
          this.lastWorkerReopenAt = Date.now();
          if (this.store.isUnavailable()) {
            const replacement = await OriginStore.open(this.options.storage, this.options.workerUrl);
            if (this.closed) { await replacement.close(); return { processed, recovered }; }
            this.store = replacement; this.service.options.store = replacement;
          }
          if (this.spool.isUnavailable()) {
            try {
              const replacement = await OriginStore.openSpool(this.options.storage, this.options.workerUrl);
              if (this.closed) { await replacement.close(); return { processed, recovered }; }
              this.spool = replacement;
            } catch {
              // Primary custody still permits a safe drain; a failed inert
              // fallback must not freeze already admitted work for 15 minutes.
              console.warn('[telegram-origin] evidence spool remains unavailable');
            }
          }
        }
      }
      const held = this.service.heldOperations();
      await this.confirmRecordingHealthy();
      await this.importLegacyQueue();
      await this.store.reapAbandoned();
      for (const origin of await this.store.undiagnosedOrigins()) this.service.requestDiagnosis(origin.originId, origin.reason);
      const admitted = await this.store.takeRecoverableAdmissions();
      const candidates = new Map(admitted.map(admission => [admission.operationId, {
        operation: { record: parseOriginJson(admission.record.envelopeJson) as unknown as TelegramOriginRecord, admission },
        admitted: true,
      }]));
      for (const operation of held) if (!candidates.has(operation.record.operationId)) {
        candidates.set(operation.record.operationId, { operation, admitted: false });
      }
      // Each source contributes at most ten, so a full durable batch cannot
      // permanently hide work retained only in the bounded memory hold buffer.
      for (const candidate of candidates.values()) {
        if (this.closed) break;
        const { operation } = candidate;
        if (operation.record.destination.transport !== 'bot-api') {
          const candidates = [...this.browsers.values()].filter(browser =>
            browser.executor.options.accountId === operation.record.destination.accountId &&
            browser.executor.options.transport === operation.record.destination.transport);
          if (candidates.length !== 1) continue; // Missing/ambiguous enrollment is a hold, never a profile guess.
          try {
            if (!candidate.admitted) await this.service.admit(operation);
            if (!await this.store.reserveRecoveryAttempt({ operationId: operation.record.operationId })) continue;
            processed++;
            await candidates[0].executor.execute(operation); recovered++;
          } catch (error) {
            console.warn('[telegram-origin] browser recovery retained operation', operation.record.operationId,
              error instanceof Error ? error.name : 'unknown-error');
          }
          continue;
        }
        const owners = [this.options.bot, ...(this.options.additionalBots ?? [])].filter(bot =>
          bot.token && bot.accountId === operation.record.destination.accountId);
        if (owners.length !== 1) continue;
        try {
        if (!candidate.admitted) await this.service.admit(operation);
        // Pre-claim holds used to re-run paid review on every recovery tick.
        // Reserve in the same durable owner before entering either review or
        // transport. Memory-held candidates pass this gate too; a missing or
        // timed-out reservation leaves the payload queued and spends no review.
        if (!await this.store.reserveRecoveryAttempt({ operationId: operation.record.operationId })) continue;
        processed++;
        const request = JSON.parse(operation.admission.children[0].materializations[0].requestJson);
        await telegramFetch(`https://api.telegram.org/bot${owners[0].token}/${request.method}`,
          { method: 'POST', headers: { 'Content-Type': request.contentType }, body: request.body,
            networkTimeoutMs: 10_000 }, undefined, operation);
        recovered++;
        } catch (error) {
          // One held operation must not starve unrelated queued destinations.
          // The service/store retains the authoritative fence and outcome.
          console.warn('[telegram-origin] recovery retained operation', operation.record.operationId,
            error instanceof Error ? error.name : 'unknown-error');
        }
      }
      return { processed, recovered };
    } finally { this.recovering = false; }
  }
  async importLegacyQueue(): Promise<number> {
    if (this.closed || this.importingLegacy || !this.options.bot.token || !this.options.bot.chatId) return 0;
    this.importingLegacy = true;
    let imported = 0;
    try {
      for (const snapshot of await this.store.legacyCandidates()) {
        const operation = this.service.prepareImportedLegacy(snapshot, this.options.bot.accountId, this.options.bot.chatId);
        if (await this.store.importLegacy({ snapshot, admission: operation.admission })) imported++;
      }
      return imported;
    } finally { this.importingLegacy = false; }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.observer.stop(); this.notifier.close(); this.unregister();
    this.capacityOwner?.close();
    const results = await Promise.allSettled([
      ...[...this.browsers.values()].map(browser => browser.executor.close()),
      this.stopNoticeIpc?.(), this.store.retireNoticeOwner(this.ownerBootId),
    ]);
    results.push(...await Promise.allSettled([this.store.close(), this.spool.close()]));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length === 1) throw failures[0].reason;
    if (failures.length) throw new AggregateError(failures.map(r => r.reason), 'Origin cleanup incomplete');
  }
}
