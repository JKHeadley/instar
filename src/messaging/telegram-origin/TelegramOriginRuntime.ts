import { QuietRecordedError } from '../NotificationSelectivityGate.js';
import { randomUUID } from 'node:crypto';
import { DegradationReporter } from '../../monitoring/DegradationReporter.js';
import { OriginStore } from './OriginStore.js';
import { OriginSessionRegistry } from './OriginSessionRegistry.js';
import type { OriginSessionBinding, OriginSessionLifecycle } from './OriginSessionRegistry.js';
import { RuntimeOriginObserver } from './RuntimeOriginObserver.js';
import { TelegramOriginService } from './TelegramOriginService.js';
import type { OriginPreparedBotOperation } from './TelegramOriginService.js';
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
import { OriginUnrecordedReceipts } from './OriginUnrecordedReceipts.js';
import { definiteSessionLine, lateDeliverySessionBatch, lateLineForParseMode, lateRecoveredReplyNotice, LATE_REPLY_THRESHOLD_MS, ownerUnstatedSessionLine, uncertainSessionLine } from './SessionDeliveryNotice.js';
import type { DefiniteFailureCause } from './SessionDeliveryNotice.js';
import { forwardExpiryArm } from './OriginForwardToHolder.js';
import type { HeldForwardDetail } from './OriginForwardToHolder.js';
import { escapeOriginFooter, originFooter } from './OriginPresentation.js';
import type { HeldOperationRow } from './StoreTypes.js';

/** How long an origin keeps full detail in the hot tables; the archive holds it after that. */
const HOT_DETAIL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_AUDIT_RETENTION_DAYS = 365;
const MIN_AUDIT_RETENTION_DAYS = 30;
const RETENTION_TICK_BUDGET_MS = 500;
const RETENTION_STEP_SLOW_MS = 250;
const RETENTION_STEP_QUICK_MS = 100;
/** The scan raises reader-visible notices; recovery running more often must not raise them faster. */
const SESSION_EXCEPTION_SCAN_INTERVAL_MS = 5 * 60_000;
const RETENTION_BATCHES = { fold: { min: 200, max: 2000 }, compact: { min: 4, max: 32 }, purge: { min: 10, max: 50 } };
/** A mistyped setting must never read as "delete all history". */
export function auditRetentionDays(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= MIN_AUDIT_RETENTION_DAYS ? value as number : DEFAULT_AUDIT_RETENTION_DAYS;
}

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
  wireParams?: OriginServiceOptions['wireParams'];
  authorizeOrigin?: OriginServiceOptions['authorizeOrigin'];
  resolveOriginKey?: (machineId: string, epoch?: number) => OriginVerificationKey | null;
  reviewLegacyRecovery?: OriginServiceOptions['reviewLegacyRecovery'];
  /** A peer's forwarded reply this holder just delivered: record it in this
   * machine's topic history. History only — never a send, never a gate. */
  onForwardedDelivered?: (row: import('./ForwardedDeliveryHistory.js').ForwardedDeliveryRow) => void;
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
  /** a2a-single-agent-identity §4 — the serving lease. Feeds the service's
   * `lease-not-held` hold reason and the holder-side `submit` check. */
  holdsLease?: () => boolean;
  /** §4.2 — recovery of a held FORWARDED operation (execution owner ≠ self).
   * Wired by the server; absent ⇒ such rows are retained, never executed here. */
  forwardRecovery?: (operation: OriginPreparedBotOperation, row: import('./StoreTypes.js').HeldOperationRow) => Promise<'resolved' | 'sent' | 'settled' | 'retained' | 'skipped'>;
  /** §4.2 — a held forward reached its deadline: report it ONCE, honestly. */
  onHeldForwardExpired?: (row: import('./StoreTypes.js').HeldOperationRow) => Promise<void> | void;
  /** §4.2 — a DIRECT-path `lease-not-held` hold (owner = this machine, no forward
   * detail) was observed for the first time: the server sends the notice/item. */
  onLeaseHoldObserved?: (row: import('./StoreTypes.js').HeldOperationRow) => Promise<void> | void;
  /** Mirror a recovered, receipt-confirmed Bot API message into topic history.
   * native-conversation-base §3a item 2 — `firstPreparedAt` and `lateMarkedAt` travel beside `preparedAt`. */
  onRecoveredMessage?: (input: { operationId: string; chatId: string; threadId: number | null; messageId: number; text: string; acceptedAt: number; preparedAt: number; producerKind: string;
    firstPreparedAt?: number; lateMarkedAt?: number | null }) => Promise<void> | void;
  /** native-conversation-base §3a items 5, 7, 8 — type one line into the running session
   * bound to a reply on THIS machine. True only when the line was injected. */
  injectSessionLine?: (binding: OriginSessionBinding, text: string) => Promise<boolean> | boolean;
  /** §3a item 8 — the hub-only attention item for a reply handed back to its author (once per operation). */
  raiseHandBackItem?: (row: HeldOperationRow) => Promise<void> | void;
  /** §3a item 7 — one record-only item per topic (`telegram-origin-unresolved:<topicId>`) while unresolved rows remain. */
  syncUnresolvedTopics?: (counts: ReadonlyMap<string, number>) => Promise<void> | void;
  onSessionDeliveryHeld?: (input: { source: 'live' | 'scan'; operationId: string; reason: string; chatId: string | null; threadId: number | null; state?: string; uncertain?: boolean; preparedAt?: number; acceptedAt?: number | null; outOfOrder?: boolean }) => Promise<void> | void;
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
  private readonly retentionBatch = { fold: RETENTION_BATCHES.fold.min, compact: RETENTION_BATCHES.compact.min, purge: RETENTION_BATCHES.purge.min };
  poolAudit?: import('./OriginPoolAudit.js').OriginPoolAudit;
  /** native-conversation-base §3b — asks the execution owner for the outcome route. Absent on a machine with no mesh. */
  ownerReader?: import('./OriginOwnerRead.js').OriginOwnerReader;
  readonly browsers = new Map<string, { executor: OriginBrowserExecutor;
    resolvePeer: (destination: BrowserDestination) => Promise<{ [key: string]: BrowserJson }>;
    /** Typed test-group operations (docs/specs/telegram-test-groups.md); Web K profiles only. */
    testGroups?: import('./TelegramTestGroups.js').TelegramTestGroups }>();
  readonly ownerBootId = randomUUID();
  readonly observer = new RuntimeOriginObserver();
  readonly sessions: OriginSessionRegistry;
  readonly service: TelegramOriginService;
  /** Telegram acceptances whose receipt write failed (held-reply outcome lookup). */
  readonly unrecordedReceipts: OriginUnrecordedReceipts;
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
    this.unrecordedReceipts = new OriginUnrecordedReceipts(options.storage.stateDir);
    this.service = new TelegramOriginService({ store, sessions: this.sessions, observer: this.observer,
      unrecordedReceipts: this.unrecordedReceipts,
      identity: options.identity, signingKey: options.signingKey, ownerBootId: this.ownerBootId,
      display: options.display, authorize: options.authorize, wireParams: options.wireParams, holdsLease: options.holdsLease, spoolEvidence: record => this.spool.putEvidence(record),
      authorizeOrigin: options.authorizeOrigin,
      capacity: this.capacity,
      reviewLegacyRecovery: options.reviewLegacyRecovery,
      peerEvidence: options.peerEvidence, diagnoseUnknown: options.diagnoseUnknown,
      diagnosticMode: options.diagnosticMode,
      onHold: ({ operationId, reason, producerKind, operationKind, destination }) => {
        if (producerKind === 'session' && operationKind === 'sendMessage' && reason !== 'lease-not-held' && reason !== 'destination-not-authorized' && reason !== 'original-operation-unresolved') {
          const uncertain = reason === 'transport-acceptance-unknown' || reason === 'response-without-correlated-receipt' || reason === 'partial-platform-receipt';
          // Only an originating conversational session's first send owns a live notice.
          // Recovery and holder-side mesh submissions can report the same old
          // session record; their durable provenance is not a new conversation.
          let source: 'live' | 'scan' = 'scan';
          try {
            const producer = this.service.isFirstSendRunning(operationId) && this.service.hasProducerContext()
              ? this.service.currentProducer() : null;
            if (producer?.producerKind === 'session' && !this.service.notificationJobSession(producer.sessionId)) source = 'live';
          } catch (error) {
            // Optional notice eligibility must not replace the original outcome.
            console.warn('[telegram-origin] notice capability unavailable; recording only', error instanceof Error ? error.name : 'unknown-error');
          }
          Promise.resolve(options.onSessionDeliveryHeld?.({ source, operationId, reason, chatId: destination.chatId,
            threadId: destination.topicId === null ? null : Number(destination.topicId), state: uncertain ? 'outcome-unknown' : 'held', uncertain }))
            .catch(error => console.warn('[telegram-origin] session delivery notice unavailable',
              error instanceof Error ? error.name : 'unknown-error'));
        }
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
  /** Synchronous worker health for /health and status; never touches the worker. */
  storageHealth() { return { store: this.store.health(), spool: this.spool.health() }; }
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
    return { detectorHealth, storage: this.storageHealth(), activation: assessOriginActivation(this.closed ? null : this.enrollment), metrics: await this.service.metrics(),
      browserRecovery: await this.store.getBrowserRecoveryStates().then(states => ({ coverage: 'complete', states }))
        .catch(() => ({ coverage: 'unknown', states: null })),
      retention: { running: this.retentionRunning, succeededAt: this.retentionSucceededAt, unavailable: this.retentionUnavailable },
      held: await this.heldStatusWithDurable(),
      heldForward: this.heldForwardHealth(),
      expiredHolds: this.service.expiredHeldStatus(),
      // §3b — owner-read latency for the 2026-11-25 review; a missing counter reads unknown, never zero.
      ownerRead: this.ownerReader?.stats() ?? { state: 'unknown', reason: 'owner-read-not-wired' },
      // §3a — per machine, read by the 2026-11-25 review (CMT-056). Unreadable reads unknown, never zero.
      heldReplies: await this.heldReplyCounters(),
      browsers: [...this.browsers].map(([profileId, browser]) => ({ profileId, ...browser.executor.broker.readStatus() })),
      notices: this.options.alertDestinations().map(d => this.remoteNotices.get(d.id) ?? this.notifier.getState(d.id)) };
  }
  /** native-conversation-base §3a review counters, from the store's keyed operation events. */
  async heldReplyCounters(): Promise<Record<string, number> | { state: 'unknown'; reason: string }> {
    try {
      const counts = (await this.store.getMetrics()).counts ?? {};
      const read = (metric: string) => counts[metric] ?? 0;
      return { lateDeliveries: read('late-delivery'), recoveredUnderThreshold: read('recovered-under-threshold'), lateUnmarked: read('late-unmarked'),
        ownerUnstated: read('owner-unstated'), definiteNoSession: read('definite-no-session'), neverHandedBack: read('never-handed-back') };
    } catch { return { state: 'unknown', reason: 'origin-store-unavailable' }; }
  }
  /**
   * The phone's Messages summary inputs (docs/specs/mobile-native-phones-messages.md): exactly the
   * held, heldForward, expiredHolds, activation and metrics values status() returns, without the
   * notice sockets, browser, detector, storage and retention reads the phone does not use.
   */
  async deliverySummaryInputs() {
    const held = await this.#heldWithDurable();
    return { held: held.rows, heldComplete: held.complete, heldForward: this.heldForwardHealth(), expiredHolds: this.service.expiredHeldStatus(),
      activation: assessOriginActivation(this.closed ? null : this.enrollment), metrics: await this.service.metrics() };
  }
  /** §4.2 — the in-memory held map is a CACHE of the store: durable held rows
   * (with their reason) are listed beside it, deduped on operation id. */
  async heldStatusWithDurable(): Promise<Array<Record<string, unknown>>> {
    return (await this.#heldWithDurable()).rows;
  }
  /** The held rows, and whether the durable read was complete: false when it failed or filled its
   * 200-row page (more may exist), so a count built from the rows is then a lower bound. */
  async #heldWithDurable(): Promise<{ rows: Array<Record<string, unknown>>; complete: boolean }> {
    const limit = 200;
    const memory = this.service.heldStatus() as Array<Record<string, unknown> & { operationId: string }>;
    let durable: import('./StoreTypes.js').HeldOperationRow[] = [];
    let complete = true;
    try { durable = await this.store.listHeldOperations({ limit }); complete = durable.length < limit; } catch { durable = []; complete = false; } // @silent-fallback-ok — not silent: `complete: false` reaches the phone summary, which marks the count incomplete; the store reports its own health
    const seen = new Set(memory.map(row => row.operationId));
    const rows: Array<Record<string, unknown>> = memory.map(row => {
      const match = durable.find(d => d.operationId === row.operationId);
      return match ? { ...row, hold_reason: match.holdReason, durable: true, topicId: match.destination.topicId, holder: match.executionOwnerMachineId, deadlineAt: match.deadlineAt, producerKind: match.producerKind } : row;
    });
    for (const row of durable) {
      if (seen.has(row.operationId) || row.state !== 'held') continue;
      rows.push({ operationId: row.operationId, reason: row.holdReason, hold_reason: row.holdReason, since: row.preparedAt,
        payloadRetainedInMemory: false, durable: true, deadlineAt: row.deadlineAt, topicId: row.destination.topicId,
        holder: row.executionOwnerMachineId, recovery: row.recovery, producerKind: row.producerKind });
    }
    return { rows, complete };
  }

  #heldForward: { count: number; sessionReplies: number; automaticMessages: number; otherMessages: number; topics: string[]; oldestSince: number | null; observedAt: number | null; expiredUnreported: number } =
    { count: 0, sessionReplies: 0, automaticMessages: 0, otherMessages: 0, topics: [], oldestSince: null, observedAt: null, expiredUnreported: 0 };
  #heldForwardRefreshedAt = 0;
  #sessionExceptionCursor: { afterPreparedAt: number; afterOperationId: string } | null = null;
  #reportingSessionExceptions = false;
  #sessionExceptionScannedAt = 0;
  /** Direct-path lease holds already reported (bounded: pruned to the live held set). */
  #observedLeaseHolds = new Set<string>();
  /** `/health → telegramOrigin.heldForward` — a synchronous read of the last
   * refresh (never a live query on the health path). */
  heldForwardHealth() { return { ...this.#heldForward, topics: [...this.#heldForward.topics] }; }
  /** Refresh the held-forward summary and report expiries once. Bounded to
   * one store read per `minIntervalMs` unless forced (a fresh hold forces). */
  async refreshHeldForward(input: { force?: boolean; minIntervalMs?: number } = {}): Promise<void> {
    if (this.closed) return;
    const now = Date.now();
    if (!input.force && now - this.#heldForwardRefreshedAt < (input.minIntervalMs ?? 30_000)) return;
    this.#heldForwardRefreshedAt = now;
    let rows: import('./StoreTypes.js').HeldOperationRow[];
    try { rows = await this.store.listHeldOperations({ holdReason: 'lease-not-held', limit: 500 }); }
    catch { return; /* The last known summary stands; the store reports its own health. */ }
    // native-conversation-base §3a item 7 — a row with `ownerVerdict` is ended, not held: it
    // stays `held` only to keep its text, and is left out of every "will still be delivered" count.
    const held = rows.filter(row => row.state === 'held' && !(row.holdDetail as { ownerVerdict?: unknown } | null)?.ownerVerdict);
    const expired = rows.filter(row => row.state === 'expired' && row.expiryReportedAt === null);
    const unresolved = new Map<string, number>();
    for (const row of held) {
      const unstated = (row.holdDetail as { ownerUnstated?: { settled?: unknown } } | null)?.ownerUnstated;
      if (unstated?.settled === true && row.destination.topicId !== null) unresolved.set(row.destination.topicId, (unresolved.get(row.destination.topicId) ?? 0) + 1);
    }
    try { await this.options.syncUnresolvedTopics?.(unresolved); } catch { /* re-synced on the next refresh */ }
    // Direct-path holds (sealed owner = this machine, no forward detail) are
    // reported once each; the forward path reports its own holds at hold time.
    const liveIds = new Set(held.map(row => row.operationId));
    for (const id of this.#observedLeaseHolds) if (!liveIds.has(id)) this.#observedLeaseHolds.delete(id);
    for (const row of held) {
      const detail = row.holdDetail as { kind?: string; reportedAt?: number } | null;
      const direct = (!row.executionOwnerMachineId || row.executionOwnerMachineId === this.options.identity.originMachineId) && detail?.kind !== 'forward-to-holder';
      // The report marker is DURABLE (on the row), so a restart never repeats the notice.
      if (!direct || detail?.reportedAt || this.#observedLeaseHolds.has(row.operationId)) continue;
      this.#observedLeaseHolds.add(row.operationId);
      try { await this.options.onLeaseHoldObserved?.(row); }
      catch { this.#observedLeaseHolds.delete(row.operationId); continue; /* reported again on the next refresh, never silently dropped */ }
      try { await this.store.recordOperationState({ operationId: row.operationId, state: 'held', holdDetail: { kind: 'direct-lease-hold', reportedAt: now } }); }
      catch { /* the in-memory set still dedupes this process; a restart may repeat the notice once */ }
    }
    const sessionReplies = held.filter(row => row.producerKind === 'session').length;
    const automaticMessages = held.filter(row => row.producerKind === 'server-automation').length;
    this.#heldForward = { count: held.length, sessionReplies, automaticMessages, otherMessages: held.length - sessionReplies - automaticMessages,
      topics: [...new Set(held.map(row => row.destination.topicId).filter((t): t is string => t !== null))],
      oldestSince: held.length ? Math.min(...held.map(row => row.preparedAt)) : null, observedAt: now, expiredUnreported: expired.length };
    for (const row of expired) {
      if (this.closed) return;
      try { await this.handBackExpiredForward(row, now); }
      catch { continue; /* Not marked: reported again on the next refresh, never silently dropped. */ }
    }
  }
  /** native-conversation-base §3a item 8 — the forward-expiry carrier. The hub item
   * is raised once under its own keyed event; `hold_expiry_reported_at` is written
   * only after the session line was injected (or for a row with no session author
   * here). With no running session the row is picked up again on each pass, until
   * it is older than the purge horizon, where it is counted `neverHandedBack`. */
  private async handBackExpiredForward(row: HeldOperationRow, now: number): Promise<void> {
    await this.raiseHandBackOnce(row);
    const binding = this.authorBinding(row);
    if (!binding) { await this.store.markHoldExpiryReported({ operationId: row.operationId, now }); return; }
    const arm = forwardExpiryArm(row);
    const first = row.firstPreparedAt ?? row.preparedAt;
    const shown = await this.originalOperationId(row.operationId);
    const text = arm.arm === 'uncertain' ? uncertainSessionLine({ operationId: shown, ageMs: now - first })
      : definiteSessionLine({ operationId: shown, ageMs: now - first, cause: arm.cause });
    const sent = await this.sessionLine({ operationId: row.operationId, binding, text });
    if (sent === 'sent' || sent === 'already') { await this.store.markHoldExpiryReported({ operationId: row.operationId, now }); return; }
    if (arm.arm === 'definite' && arm.cause !== 'refused') await this.countOnce(row.operationId, 'definite-no-session');
    if (row.preparedAt < now - HOT_DETAIL_MS) {
      await this.store.markHoldExpiryReported({ operationId: row.operationId, now });
      await this.countOnce(row.operationId, 'never-handed-back');
    }
  }
  /** The hub item for a reply handed back, once per operation (`<operationId>:handback-item`),
   * recorded only after it was raised, so a failed raise is raised again next pass. */
  private async raiseHandBackOnce(row: HeldOperationRow): Promise<void> {
    const key = { eventId: `${row.operationId}:handback-item`, metric: 'handback-item' };
    if (await this.store.hasOperationEvent(key)) return;
    await (this.options.raiseHandBackItem ?? this.options.onHeldForwardExpired)?.(row);
    await this.store.recordOperationEvent(key);
  }
  /** The reply's author binding when it was written by a session on THIS machine. */
  private authorBinding(row: Pick<HeldOperationRow, 'producerKind' | 'originMachineId' | 'sessionId' | 'harnessId'>): OriginSessionBinding | null {
    if (row.producerKind !== 'session' || row.originMachineId !== this.options.identity.originMachineId || !row.sessionId) return null;
    return { sessionId: row.sessionId, harnessId: row.harnessId ?? '' } as OriginSessionBinding;
  }
  /** One counted event per operation (`lateUnmarked`, `definiteNoSession`, …) for the 2026-11-25 review. */
  private async countOnce(operationId: string, metric: string): Promise<void> {
    try { await this.store.recordOperationEvent({ eventId: `${operationId}:${metric}`, metric }); } catch { /* counters never gate */ }
  }
  /** §3a items 7, 8 — one session line per operation, whichever carrier reaches it
   * first (`<operationId>:session-line`). Recorded only after it was injected, so a
   * line injected but not recorded is injected again; never one recorded but not sent. */
  async sessionLine(input: { operationId: string; binding: OriginSessionBinding; text: string; key?: 'session-line' | 'late-line' }): Promise<'sent' | 'already' | 'no-session' | 'failed'> {
    const key = input.key ?? 'session-line';
    const eventId = `${input.operationId}:${key}`;
    if (await this.store.hasOperationEvent({ eventId, metric: key }).catch(() => false)) return 'already';
    if (!this.options.injectSessionLine || !this.options.isSessionLive?.(input.binding)) return 'no-session';
    let injected = false;
    try { injected = await this.options.injectSessionLine(input.binding, input.text) === true; } catch { injected = false; }
    if (!injected) return 'failed';
    await this.store.recordOperationEvent({ eventId, metric: key }).catch(() => false);
    return 'sent';
  }
  /** §3a item 7 — the owner's verdict: the definite line in the same forward pass, and the hub item. */
  async handOwnerVerdict(row: HeldOperationRow, verdict: { failure: DefiniteFailureCause }): Promise<void> {
    try { await this.raiseHandBackOnce(row); } catch { /* raised again by the forward-expiry pass */ }
    const binding = this.authorBinding(row);
    if (!binding) return;
    const now = Date.now(), first = row.firstPreparedAt ?? row.preparedAt;
    const sent = await this.sessionLine({ operationId: row.operationId, binding,
      text: definiteSessionLine({ operationId: await this.originalOperationId(row.operationId), ageMs: now - first, cause: verdict.failure }) });
    if (sent === 'no-session' && verdict.failure !== 'refused') await this.countOnce(row.operationId, 'definite-no-session');
  }
  /** §3a item 7 — a second reasonless ending: one session line (the item is per topic, from the refresh). */
  async handOwnerUnstated(row: HeldOperationRow): Promise<void> {
    await this.countOnce(row.operationId, 'owner-unstated');
    const binding = this.authorBinding(row);
    if (binding) await this.sessionLine({ operationId: row.operationId, binding, text: ownerUnstatedSessionLine(await this.originalOperationId(row.operationId)) });
    await this.refreshHeldForward({ force: true });
  }
  async countLateUnmarked(operationId: string): Promise<void> { await this.countOnce(operationId, 'late-unmarked'); }
  /** §3a item 5 — late deliveries noted during a pass; one line per session per pass. */
  #lateNotes: Array<{ operationId: string; binding: OriginSessionBinding; deliveredAfterMs: number; marked: boolean }> = [];
  /** Every reply delivered through recovery is counted with its delay; a late one is noted for its author. */
  private async noteRecoveredDelivery(input: { operationId: string; reportedId: string; record: Pick<TelegramOriginRecord, 'producerKind' | 'originMachineId' | 'sessionId' | 'harnessId'>;
    firstPreparedAt: number; acceptedAt: number; marked: boolean }): Promise<void> {
    const delay = input.acceptedAt - input.firstPreparedAt;
    if (!Number.isFinite(delay)) return;
    await this.countOnce(input.reportedId, delay > LATE_REPLY_THRESHOLD_MS ? 'late-delivery' : 'recovered-under-threshold');
    if (delay <= LATE_REPLY_THRESHOLD_MS) return;
    const binding = this.authorBinding(input.record);
    if (binding) this.#lateNotes.push({ operationId: input.reportedId, binding, deliveredAfterMs: delay, marked: input.marked });
  }
  /** A forward delivered by recovery: follow its successors to the accepted copy. */
  private async noteForwardDelivery(row: HeldOperationRow, operation: OriginPreparedBotOperation): Promise<void> {
    try {
      let audit = await this.store.getOperation(row.operationId);
      for (let hop = 0; hop < 8 && audit?.operation?.state === 'superseded'; hop++) {
        const next = (audit.operation.holdDetail as { supersededBy?: unknown } | null)?.supersededBy;
        if (typeof next !== 'string') return;
        audit = await this.store.getOperation(next);
      }
      if (!audit?.operation) return;
      const accepted = audit.attempts.filter(a => a.outcome === 'accepted').map(a => a.resolvedAt ?? a.createdAt);
      if (!accepted.length) return;
      const record = JSON.parse(audit.record.envelopeJson) as TelegramOriginRecord;
      const detail = row.holdDetail as { authoredPreparedAt?: unknown } | null;
      const first = audit.operation.firstPreparedAt ?? record.firstPreparedAt ?? (typeof detail?.authoredPreparedAt === 'number' ? detail.authoredPreparedAt : row.preparedAt);
      await this.noteRecoveredDelivery({ operationId: audit.operation.operationId, reportedId: await this.originalOperationId(row.operationId),
        record: record.producerKind === 'session' ? record : operation.record, firstPreparedAt: first, acceptedAt: Math.max(...accepted), marked: !!audit.operation.lateMarkedAt });
    } catch { /* a missed line is a missed courtesy, never a send */ }
  }
  /** The id the session was given: walk `supersedes` back to the first operation of the chain. */
  private async originalOperationId(operationId: string): Promise<string> {
    let current = operationId;
    for (let hop = 0; hop < 8; hop++) {
      const audit = await this.store.getOperation(current).catch(() => null);
      const previous = (audit?.operation?.holdDetail as { supersedes?: unknown } | null)?.supersedes;
      if (typeof previous !== 'string' || previous === current) break;
      current = previous;
    }
    return current;
  }
  private async flushLateNotes(): Promise<void> {
    const notes = this.#lateNotes.splice(0);
    const bySession = new Map<string, typeof notes>();
    for (const note of notes) {
      const key = `${note.binding.sessionId}\u0000${note.binding.harnessId}`;
      bySession.set(key, [...bySession.get(key) ?? [], note]);
    }
    for (const group of bySession.values()) {
      const fresh: typeof group = [];
      for (const note of group) if (!await this.store.hasOperationEvent({ eventId: `${note.operationId}:late-line`, metric: 'late-line' }).catch(() => false)) fresh.push(note);
      const text = lateDeliverySessionBatch(fresh);
      if (!text || !this.options.injectSessionLine || !this.options.isSessionLive?.(group[0].binding)) continue;
      let injected = false;
      try { injected = await this.options.injectSessionLine(group[0].binding, text) === true; } catch { injected = false; }
      if (!injected) continue;
      for (const note of fresh) await this.store.recordOperationEvent({ eventId: `${note.operationId}:late-line`, metric: 'late-line' }).catch(() => false);
    }
  }
  /** §3a item 2 — the author is the execution owner: replace a late, unmarked session
   * reply with one whose first line says so, `admitted`, and send it in this pass.
   * Single-part replies only; anything else goes out as it is, counted `lateUnmarked`. */
  private async markLateDirect(operation: OriginPreparedBotOperation): Promise<OriginPreparedBotOperation> {
    const record = operation.record;
    if (record.producerKind !== 'session' || record.operationKind !== 'sendMessage' || record.originMachineId !== this.options.identity.originMachineId) return operation;
    const audit = await this.store.getOperation(record.operationId).catch(() => null);
    const op = audit?.operation;
    if (!op || op.lateMarkedAt || op.state !== 'admitted') return operation;
    const now = Date.now(), first = op.firstPreparedAt ?? record.firstPreparedAt ?? op.preparedAt;
    const line = lateRecoveredReplyNotice(first, now);
    if (!line || op.deadlineAt <= now) return operation;
    if (await this.store.hasOperationEvent({ eventId: `${record.operationId}:late-unmarked`, metric: 'late-unmarked' }).catch(() => true)) return operation;
    try {
      if (operation.admission.children.length !== 1 || audit!.attempts.some(a => a.outcome !== 'known-failed')) throw new Error('late-mark-shape');
      const request = JSON.parse(operation.admission.children[0].materializations[0].requestJson) as { method?: string; body?: string; policy?: import('./OriginSendPolicy.js').OriginSendPolicyInput };
      const params = JSON.parse(request.body ?? '{}') as import('./types.js').BotParameters;
      if (request.method !== 'sendMessage' || typeof params.text !== 'string') throw new Error('late-mark-shape');
      const footer = originFooter(record, record.display);
      const tail = footer ? `\n\n${escapeOriginFooter(footer, typeof params.parse_mode === 'string' ? params.parse_mode : undefined)}` : '';
      const authored = tail && params.text.endsWith(tail) ? params.text.slice(0, -tail.length) : params.text;
      const text = `${lateLineForParseMode(line, params.parse_mode)}\n\n${authored}`;
      const next = this.service.runAsRecordedProducer(record, () => this.service.prepareBot({ method: 'sendMessage', accountId: record.destination.accountId,
        params: { ...params, text }, executionOwnerMachineId: this.options.identity.originMachineId,
        ...(request.policy ? { policyInput: request.policy } : {}), replacement: { firstPreparedAt: first, deadlineAt: op.deadlineAt } }));
      if (next.admission.children.length !== 1) throw new Error('late-mark-part-limit');
      this.service.authorizeSendPolicyDispatch(next.record);
      await this.service.recordIntent(next);
      if (!await this.store.supersedeWithAdmission({ operationId: record.operationId, admission: next.admission, holdReason: null, holdDetail: null,
        replacementState: 'admitted', firstPreparedAt: first, lateMarkedAt: now })) throw new Error('late-mark-supersede-refused');
      return next;
    } catch {
      await this.countLateUnmarked(record.operationId);
      return operation;
    }
  }
  /** §4.2 — the quick retry ladder for held FORWARDS, driven by the 5 s boot
   * tick: a held forward whose recorded next step is due is re-forwarded
   * (or resolved at the old holder's receipt). Bounded, single-flight with
   * `recoverHeld`, scheduling only — the holder re-runs its full gate. */
  async runForwardLadder(now = Date.now()): Promise<{ processed: number; recovered: number }> {
    if (this.closed || this.recovering || !this.options.forwardRecovery) return { processed: 0, recovered: 0 };
    this.recovering = true;
    let processed = 0, recovered = 0;
    try {
      let due: Array<{ admission: import('./StoreTypes.js').OriginAdmission; row: import('./StoreTypes.js').HeldOperationRow }> = [];
      try { due = await this.store.heldForwardAdmissions({ now, limit: 10 }); } catch { return { processed, recovered }; }
      for (const { admission, row } of due) {
        if (this.closed) break;
        const operation = { record: parseOriginJson(admission.record.envelopeJson) as unknown as TelegramOriginRecord, admission };
        if (!operation.record.executionOwnerMachineId || operation.record.executionOwnerMachineId === this.options.identity.originMachineId) continue;
        try {
          processed++;
          if (!await this.allowQueuedRecovery(operation)) continue;
          const outcome = await this.options.forwardRecovery(operation, row);
          if (outcome === 'sent' || outcome === 'resolved') { recovered++; await this.noteForwardDelivery(row, operation); }
        } catch (error) {
          console.warn('[telegram-origin] forward ladder retained operation', row.operationId, error instanceof Error ? error.name : 'unknown-error');
        }
      }
      if (processed) await this.refreshHeldForward({ force: true });
      await this.flushLateNotes();
      return { processed, recovered };
    } finally { this.recovering = false; }
  }
  /** Existing runtime maintenance tick owns cleanup and archival; this never
   * dispatches or grants retry authority. Work is bounded and off-event-loop. */
  async maintainRetention(now = Date.now(), scope: 'all' | 'expiry-only' = 'all'): Promise<void> {
    if (this.closed || this.retentionRunning || now - this.retentionAttemptedAt < 60_000) return;
    this.retentionAttemptedAt = now; this.retentionRunning = true;
    try {
      if (scope === 'expiry-only') { await this.store.cleanupPayloads(now); this.retentionSucceededAt = now; this.retentionUnavailable = false; return; }
      const started = Date.now(), inBudget = () => Date.now() - started < RETENTION_TICK_BUDGET_MS;
      const before = now - HOT_DETAIL_MS;
      let keepOperations: string[];
      try { keepOperations = this.unrecordedReceipts.pending({ requireReadable: true }).map(entry => entry.operationId); }
      catch { return; } // Without this list a receipt still to fold in could lose its attempt row.
      // One request per step, awaited, so a queued admit waits for one step at most.
      await this.store.cleanupPayloads(now);
      const fold = inBudget() ? await this.paced('fold', limit => this.store.foldMetricEvents({ before, limit })) : { folded: 0, more: true };
      if (inBudget()) await this.store.archive({ before, limit: 100, minRecords: 100, flushBefore: before - HOT_DETAIL_MS, now, keepOperations });
      if (inBudget()) await this.paced('compact', limit => this.store.compactArchives({ limit }));
      // The fold reads operation rows, so a backlog there keeps them in place.
      if (inBudget() && !fold.more) await this.paced('purge', limit => this.store.purgeArchived({ before, limit, keepOperations }));
      if (inBudget()) await this.store.expireAudit({ before: now - auditRetentionDays(this.options.storage.auditRetentionDays) * 24 * 60 * 60_000 });
      this.retentionSucceededAt = now; this.retentionUnavailable = false;
    } catch { this.retentionUnavailable = true; }
    finally { this.retentionRunning = false; }
  }
  /** Batch sizes follow what this disk just managed, so a cold or busy store takes
   * smaller steps instead of one that overruns a queued admit's budget. */
  private async paced<T>(step: keyof typeof RETENTION_BATCHES, run: (limit: number) => Promise<T>): Promise<T> {
    const { min, max } = RETENTION_BATCHES[step], limit = this.retentionBatch[step], started = Date.now();
    const result = await run(limit), ms = Date.now() - started;
    this.retentionBatch[step] = ms > RETENTION_STEP_SLOW_MS ? Math.max(min, Math.floor(limit / 2)) : ms < RETENTION_STEP_QUICK_MS ? Math.min(max, limit * 2) : limit;
    return result;
  }
  /** Fold Telegram acceptances whose receipt write failed back into the store.
   * The attempt becomes reconcilable once its claim was reaped to
   * outcome-unknown; until then it stays pending for the next tick. */
  async reconcileUnrecordedReceipts(): Promise<number> {
    let folded = 0;
    let pending: ReturnType<OriginUnrecordedReceipts['pending']>;
    try { pending = this.unrecordedReceipts.pending(); } catch { return 0; }
    for (const entry of pending.slice(0, 50)) {
      try {
        if (await this.store.reconcileReceipt({ childId: entry.childId, attemptId: entry.attemptId, receiptJson: entry.receiptJson, outcome: 'accepted' })) {
          this.unrecordedReceipts.markReconciled(entry.operationId, entry.childId);
          folded++;
        }
      } catch { return folded; } // the store is still down: try again next tick
    }
    return folded;
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
      // Never replace them merely because a queue drain was requested. A store
      // restarts its own failed generations with bounded backoff; this
      // fifteen-minute reopen is only the slower path once it has given up.
      if (this.store.needsReplacement() || this.spool.needsReplacement()) {
        const mayReopen = Date.now() - this.lastWorkerReopenAt >= 15 * 60_000;
        if (!mayReopen && this.store.needsReplacement()) return { processed, recovered };
        if (mayReopen) {
          this.lastWorkerReopenAt = Date.now();
          if (this.store.needsReplacement()) {
            const replacement = await OriginStore.openReplacement(this.store, this.options.storage, undefined, this.options.workerUrl);
            if (this.closed) { await replacement.close(); return { processed, recovered }; }
            this.store = replacement; this.service.options.store = replacement;
          }
          if (this.spool.needsReplacement()) {
            try {
              const replacement = await OriginStore.openReplacement(this.spool, this.options.storage, 'spool', this.options.workerUrl);
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
      // A store still inside its own bounded restart policy is not replaced;
      // this tick only asks for its next attempt now.
      if (this.spool.isUnavailable() && !this.spool.needsReplacement()) {
        await this.spool.restartNow().catch(() => console.warn('[telegram-origin] evidence spool remains unavailable'));
      }
      if (this.store.isUnavailable() && !this.store.needsReplacement()) await this.store.restartNow();
      const held = this.service.heldOperations();
      await this.confirmRecordingHealthy();
      await this.importLegacyQueue();
      await this.store.reapAbandoned();
      await this.reconcileUnrecordedReceipts();
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
        if (this.service.isFirstSendRunning(operation.record.operationId)) continue;
        if (await this.withholdHistoricalDeliveryNotice(operation)) continue;
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
            if (error instanceof QuietRecordedError) { this.service.forgetTerminalHold(operation.record.operationId); continue; }
            console.warn('[telegram-origin] browser recovery retained operation', operation.record.operationId,
              error instanceof Error ? error.name : 'unknown-error');
          }
          continue;
        }
        if (operation.record.executionOwnerMachineId && operation.record.executionOwnerMachineId !== this.options.identity.originMachineId) {
          // §4.2 — a held FORWARDED operation is re-forwarded to the holder (or
          // resolved at the old holder), never executed through this machine's
          // credential: its sealed execution owner is another machine.
          if (!this.options.forwardRecovery) continue;
          try {
            const audit = await this.store.getOperation(operation.record.operationId);
            if (!audit?.operation) continue;
            const row: import('./StoreTypes.js').HeldOperationRow = { operationId: operation.record.operationId, originId: audit.record.originId,
              state: audit.operation.state === 'expired' ? 'expired' : 'held', holdReason: audit.operation.holdReason ?? null, holdDetail: audit.operation.holdDetail ?? null,
              preparedAt: audit.operation.preparedAt, deadlineAt: audit.operation.deadlineAt, executionOwnerMachineId: operation.record.executionOwnerMachineId,
              destination: { accountId: operation.record.destination.accountId, chatId: operation.record.destination.chatId, topicId: operation.record.destination.topicId },
              recovery: audit.recovery ?? null, expiryReportedAt: null, producerKind: operation.record.producerKind };
            if (!await this.store.reserveRecoveryAttempt({ operationId: operation.record.operationId })) continue;
            processed++;
            if (!await this.allowQueuedRecovery(operation)) continue;
            const outcome = await this.options.forwardRecovery(operation, row);
            if (outcome === 'sent' || outcome === 'resolved') { recovered++; await this.noteForwardDelivery(row, operation); }
          } catch (error) {
            if (error instanceof QuietRecordedError) { this.service.forgetTerminalHold(operation.record.operationId); continue; }
            console.warn('[telegram-origin] forward recovery retained operation', operation.record.operationId,
              error instanceof Error ? error.name : 'unknown-error');
          }
          continue;
        }
        const owners = [this.options.bot, ...(this.options.additionalBots ?? [])].filter(bot =>
          bot.token && bot.accountId === operation.record.destination.accountId);
        if (owners.length !== 1) continue;
        try {
        if (!candidate.admitted) await this.service.admit(operation);
        // §4.2 — a DIRECT-path `lease-not-held` row (durably `held`, owner = this
        // machine) is replayable only once this machine holds the lease again:
        // re-admit it (the claim fence admits `admitted|partial` only) and let the
        // ordinary replay below run `authorize` afresh. Still not the holder → wait.
        if (candidate.admitted) {
          const audit = await this.store.getOperation(operation.record.operationId).catch(() => null);
          if (audit?.operation?.holdReason === 'lease-not-held') {
            if (this.options.holdsLease && !this.options.holdsLease()) continue;
            if (!await this.store.recordOperationState({ operationId: operation.record.operationId, state: 'admitted' })) continue;
            this.#observedLeaseHolds.delete(operation.record.operationId);
          }
        }
        // Pre-claim holds used to re-run paid review on every recovery tick.
        // Reserve in the same durable owner before entering either review or
        // transport. Memory-held candidates pass this gate too; a missing or
        // timed-out reservation leaves the payload queued and spends no review.
        // native-conversation-base §3a item 2 — a late, unmarked session reply is replaced
        // (`admitted`) with its first line saying so, and the replacement is sent now.
        const sending = await this.markLateDirect(operation);
        if (!await this.store.reserveRecoveryAttempt({ operationId: sending.record.operationId })) continue;
        processed++;
        const request = JSON.parse(sending.admission.children[0].materializations[0].requestJson);
        if (!await this.allowQueuedRecovery(sending)) continue;
        const response = await telegramFetch(`https://api.telegram.org/bot${owners[0].token}/${request.method}`,
          { method: 'POST', headers: { 'Content-Type': request.contentType }, body: request.body,
            networkTimeoutMs: 10_000 }, undefined, sending);
        if (request.method === 'sendMessage') {
          try {
            const receipt = await response.json() as { ok?: boolean; result?: { message_id?: number; date?: number } };
            const body = JSON.parse(request.body) as { chat_id?: string | number; message_thread_id?: number; text?: string };
            if (receipt.ok && Number.isSafeInteger(receipt.result?.message_id) && typeof body.text === 'string' && body.chat_id != null) {
              const settled = await this.store.getOperation(sending.record.operationId).catch(() => null);
              const firstPreparedAt = settled?.operation?.firstPreparedAt ?? sending.record.firstPreparedAt ?? sending.admission.preparedAt;
              const lateMarkedAt = settled?.operation?.lateMarkedAt ?? null;
              const acceptedAt = Number.isSafeInteger(receipt.result?.date) ? receipt.result!.date! * 1000 : Date.now();
              await this.options.onRecoveredMessage?.({ operationId: sending.record.operationId,
                chatId: String(body.chat_id), threadId: body.message_thread_id ?? null,
                messageId: receipt.result!.message_id!, text: body.text,
                acceptedAt,
                preparedAt: sending.admission.preparedAt, producerKind: sending.record.producerKind, firstPreparedAt, lateMarkedAt });
              await this.noteRecoveredDelivery({ operationId: sending.record.operationId, reportedId: operation.record.operationId, record: sending.record,
                firstPreparedAt, acceptedAt, marked: !!lateMarkedAt });
            }
          } catch (error) {
            console.warn('[telegram-origin] recovered message history unavailable', operation.record.operationId,
              error instanceof Error ? error.name : 'unknown-error');
          }
        }
        recovered++;
        } catch (error) {
          if (error instanceof QuietRecordedError) { this.service.forgetTerminalHold(operation.record.operationId); continue; }
          // One held operation must not starve unrelated queued destinations.
          // The service/store retains the authoritative fence and outcome.
          console.warn('[telegram-origin] recovery retained operation', operation.record.operationId,
            error instanceof Error ? error.name : 'unknown-error');
        }
      }
      await this.flushLateNotes();
      await this.refreshHeldForward({ force: true });
      // Notice I/O cannot hold up the outbox drain. The scan is repeatable and
      // uses a cursor so an old or busy topic cannot permanently hide a loss.
      void this.reportSessionDeliveryExceptions();
      return { processed, recovered };
    } finally { this.recovering = false; }
  }
  /** Historical notice automation has no authority to resume a conversation. */
  private async withholdHistoricalDeliveryNotice(operation: OriginPreparedBotOperation): Promise<boolean> {
    if (operation.record.producerKind !== 'server-automation' || operation.record.producerId !== 'reply-delivery-notice') return false;
    if (this.service.isFirstSendRunning(operation.record.operationId)) return true;
    // A foreign holder may have dispatched since our snapshot. Withhold it
    // intact until the existing expiry; local queued state cannot prove remote
    // non-delivery, and a read before suppression would still race the holder.
    if (operation.record.executionOwnerMachineId && operation.record.executionOwnerMachineId !== this.options.identity.originMachineId) return true;
    try {
      if (await this.store.recordOperationState({ operationId: operation.record.operationId, state: 'suppressed', holdReason: 'historical-notice-retired' })) {
        this.service.forgetTerminalHold(operation.record.operationId);
        console.info('[telegram-origin] retired historical delivery notice', { operationId: operation.record.operationId });
      }
    } catch (error) {
      console.warn('[telegram-origin] historical notice retirement retained', error instanceof Error ? error.name : 'unknown-error');
    }
    // A failed transition or a stale snapshot must never fall through to send.
    return true;
  }
  /** Shared gate for direct recovery and both forward retry schedulers.
   * native-conversation-base §3a item 1 — a later timestamp no longer ends a
   * queued reply (the causal rule is the only rule): no timestamp comparison is
   * computed here. The one retirement left is the historical delivery notice,
   * which is never a reply; a reply's own retirement is the execution owner's
   * content check, which fires only on platform acceptance of the same text. */
  private async allowQueuedRecovery(operation: OriginPreparedBotOperation): Promise<boolean> {
    return !await this.withholdHistoricalDeliveryNotice(operation);
  }
  private async reportSessionDeliveryExceptions(): Promise<void> {
    if (this.#reportingSessionExceptions || !this.options.onSessionDeliveryHeld || this.closed) return;
    if (Date.now() - this.#sessionExceptionScannedAt < SESSION_EXCEPTION_SCAN_INTERVAL_MS) return;
    this.#sessionExceptionScannedAt = Date.now();
    this.#reportingSessionExceptions = true;
    try {
      const rows = await this.store.listSessionDeliveryExceptions({ ...this.#sessionExceptionCursor ?? {}, limit: 100 });
      this.#sessionExceptionCursor = rows.length === 100
        ? { afterPreparedAt: rows[99].preparedAt, afterOperationId: rows[99].operationId } : null;
      for (const row of rows) {
        if (this.closed) break;
        // §3a item 7 — a settled reasonless ending is unresolved, not ended: its session
        // line and per-topic item carry it; the scan raises no per-operation notice for it.
        if (!row.ownerUnstated) {
          try { await this.options.onSessionDeliveryHeld({ ...row, source: 'scan' }); }
          catch (error) { console.warn('[telegram-origin] session delivery notice retry retained',
            error instanceof Error ? error.name : 'unknown-error'); }
        }
        try { await this.scanSessionLine(row); } catch { /* retried on the next scan */ }
      }
    } catch (error) { console.warn('[telegram-origin] session delivery exception scan unavailable',
      error instanceof Error ? error.name : 'unknown-error'); }
    finally { this.#reportingSessionExceptions = false; }
  }

  /** native-conversation-base §3a item 8 — the existing scan is the carrier for a row
   * this machine both wrote and sent (or whose forward the owner settled unknown).
   * Session lines go only to replies authored here; the arm is never the state alone. */
  private async scanSessionLine(row: { operationId: string; state: string; uncertain: boolean; preparedAt: number; firstPreparedAt?: number;
    originMachineId?: string | null; sessionId?: string | null; harnessId?: string | null; failure?: DefiniteFailureCause | null; ownerUnstated?: boolean }): Promise<void> {
    const binding = this.authorBinding({ producerKind: 'session', originMachineId: row.originMachineId ?? null, sessionId: row.sessionId ?? null, harnessId: row.harnessId ?? null });
    if (!binding) return;
    const now = Date.now(), ageMs = now - (row.firstPreparedAt ?? row.preparedAt);
    const shown = row.ownerUnstated || row.uncertain || ['outcome-unknown', 'known-failed', 'expired'].includes(row.state) ? await this.originalOperationId(row.operationId) : row.operationId;
    let text: string | null = null, definite: DefiniteFailureCause | null = null;
    if (row.ownerUnstated) text = ownerUnstatedSessionLine(shown);
    else if (row.uncertain || row.state === 'outcome-unknown') text = uncertainSessionLine({ operationId: shown, ageMs });
    else if ((row.state === 'known-failed' || row.state === 'expired') && row.failure) { definite = row.failure; text = definiteSessionLine({ operationId: shown, ageMs, cause: row.failure }); }
    if (!text) return;
    const sent = await this.sessionLine({ operationId: row.operationId, binding, text });
    if (sent === 'no-session' && definite && definite !== 'refused') await this.countOnce(row.operationId, 'definite-no-session');
  }
  async importLegacyQueue(): Promise<number> {
    if (this.closed || this.importingLegacy || !this.options.bot.token || !this.options.bot.chatId) return 0;
    this.importingLegacy = true;
    let imported = 0;
    try {
      for (const snapshot of await this.store.legacyCandidates()) {
        // One row that cannot be prepared (e.g. an issues-group topic on a machine
        // without issuesChatId) must not block the rest of the queue.
        let operation: ReturnType<TelegramOriginService['prepareImportedLegacy']>;
        // Label the row with what this machine can truthfully say about its
        // author (always its own machine; the session when the reply script
        // recorded its credential digest). A failed lookup degrades to unknown.
        const attribution = await this.service.attributeLegacy(snapshot).catch(() => undefined);
        try { operation = this.service.prepareImportedLegacy(snapshot, this.options.bot.accountId, this.options.bot.chatId, attribution); }
        catch (error) { console.warn(`[telegram-origin] legacy row not imported: ${error instanceof Error ? error.message : String(error)}`); continue; }
        if (await this.store.importLegacy({ snapshot, admission: operation.admission })) imported++;
      }
      return imported;
    } finally { this.importingLegacy = false; }
  }
  async close(): Promise<void> {
    await this.service.notificationGate?.close?.();
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
