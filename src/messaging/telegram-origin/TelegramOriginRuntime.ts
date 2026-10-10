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
  /** a2a-single-agent-identity §4 — the serving lease. Feeds the service's
   * `lease-not-held` hold reason and the holder-side `submit` check. */
  holdsLease?: () => boolean;
  /** §4.2 — recovery of a held FORWARDED operation (execution owner ≠ self).
   * Wired by the server; absent ⇒ such rows are retained, never executed here. */
  forwardRecovery?: (operation: OriginPreparedBotOperation, row: import('./StoreTypes.js').HeldOperationRow) => Promise<'resolved' | 'sent' | 'retained' | 'skipped'>;
  /** §4.2 — a held forward reached its deadline: report it ONCE, honestly. */
  onHeldForwardExpired?: (row: import('./StoreTypes.js').HeldOperationRow) => Promise<void> | void;
  /** §4.2 — a DIRECT-path `lease-not-held` hold (owner = this machine, no forward
   * detail) was observed for the first time: the server sends the notice/item. */
  onLeaseHoldObserved?: (row: import('./StoreTypes.js').HeldOperationRow) => Promise<void> | void;
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
      display: options.display, authorize: options.authorize, holdsLease: options.holdsLease, spoolEvidence: record => this.spool.putEvidence(record),
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
      browsers: [...this.browsers].map(([profileId, browser]) => ({ profileId, ...browser.executor.broker.readStatus() })),
      notices: this.options.alertDestinations().map(d => this.remoteNotices.get(d.id) ?? this.notifier.getState(d.id)) };
  }
  /** §4.2 — the in-memory held map is a CACHE of the store: durable held rows
   * (with their reason) are listed beside it, deduped on operation id. */
  async heldStatusWithDurable(): Promise<Array<Record<string, unknown>>> {
    const memory = this.service.heldStatus() as Array<Record<string, unknown> & { operationId: string }>;
    let durable: import('./StoreTypes.js').HeldOperationRow[] = [];
    try { durable = await this.store.listHeldOperations({ limit: 200 }); } catch { durable = []; }
    const seen = new Set(memory.map(row => row.operationId));
    const rows: Array<Record<string, unknown>> = memory.map(row => {
      const match = durable.find(d => d.operationId === row.operationId);
      return match ? { ...row, hold_reason: match.holdReason, durable: true, topicId: match.destination.topicId, holder: match.executionOwnerMachineId, deadlineAt: match.deadlineAt } : row;
    });
    for (const row of durable) {
      if (seen.has(row.operationId) || row.state !== 'held') continue;
      rows.push({ operationId: row.operationId, reason: row.holdReason, hold_reason: row.holdReason, since: row.preparedAt,
        payloadRetainedInMemory: false, durable: true, deadlineAt: row.deadlineAt, topicId: row.destination.topicId,
        holder: row.executionOwnerMachineId, recovery: row.recovery });
    }
    return rows;
  }
  #heldForward: { count: number; topics: string[]; oldestSince: number | null; observedAt: number | null; expiredUnreported: number } =
    { count: 0, topics: [], oldestSince: null, observedAt: null, expiredUnreported: 0 };
  #heldForwardRefreshedAt = 0;
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
    const held = rows.filter(row => row.state === 'held');
    const expired = rows.filter(row => row.state === 'expired' && row.expiryReportedAt === null);
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
    this.#heldForward = { count: held.length, topics: [...new Set(held.map(row => row.destination.topicId).filter((t): t is string => t !== null))],
      oldestSince: held.length ? Math.min(...held.map(row => row.preparedAt)) : null, observedAt: now, expiredUnreported: expired.length };
    for (const row of expired) {
      if (this.closed) return;
      try { await this.options.onHeldForwardExpired?.(row); }
      catch { continue; /* Not marked: reported again on the next refresh, never silently dropped. */ }
      try { await this.store.markHoldExpiryReported({ operationId: row.operationId, now }); } catch { /* re-reported next refresh */ }
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
          const outcome = await this.options.forwardRecovery(operation, row);
          if (outcome === 'sent' || outcome === 'resolved') recovered++;
        } catch (error) {
          console.warn('[telegram-origin] forward ladder retained operation', row.operationId, error instanceof Error ? error.name : 'unknown-error');
        }
      }
      if (processed) await this.refreshHeldForward({ force: true });
      return { processed, recovered };
    } finally { this.recovering = false; }
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
              recovery: audit.recovery ?? null, expiryReportedAt: null };
            if (!await this.store.reserveRecoveryAttempt({ operationId: operation.record.operationId })) continue;
            processed++;
            const outcome = await this.options.forwardRecovery(operation, row);
            if (outcome === 'sent' || outcome === 'resolved') recovered++;
          } catch (error) {
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
      await this.refreshHeldForward({ force: true });
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
