// Governed by: Telegram Message Origin Is Mandatory; Its Display Is Optional
// (docs/STANDARDS-REGISTRY.md). Recording and presentation are independent.
import { sealOriginAdmission, validOriginAdmission } from './OriginAdmissionSeal.js';
import { OriginCapacityUnavailable } from './OriginEgressCapacity.js';
import { recordTelegramEditRejection } from '../TelegramEditRejection.js';
import type { OriginCapacityAuthority } from './OriginEgressCapacity.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { originSendPolicyInput, validOriginSendPolicyInput, OriginSendPolicyRefusal } from './OriginSendPolicy.js';
import type { OriginSendPolicyInput, OriginSendPolicyAuthority } from './OriginSendPolicy.js';
import { randomUUID, randomBytes, createHash, createPublicKey } from 'node:crypto';
import { unknownAutomationAuthor } from './OriginAutomationAuthor.js';
import { formatForTelegram } from '../TelegramMarkdownFormatter.js';
import { redact } from '../secret-patterns.js';
import type { OriginLegacySnapshot } from './OriginLegacy.js';
import type { OriginAutomationAuthor } from './OriginAutomationAuthor.js';
import { bindBotCompanion } from './OriginBotCompanion.js';
import { nextOriginKnownFailure } from './OriginRetry.js';
import { OriginTransportCancelledBeforeNetwork } from './OriginTransportCancellation.js';
import { correlateBotReceipt, correlatePartialBotReceipt, replayBotReceipt } from './OriginBotReceipt.js';
import type { OriginBotReceipt } from './OriginBotReceipt.js';
import type { DerivedMaterializationInput, StoredChild } from './StoreTypes.js';
import { canonicalOrigin, originDigest, parseOriginJson, wireDigest } from './CanonicalOrigin.js';
import { planBotOrigin } from './OriginBotPlanner.js';
import { resolveOriginDisplay } from './OriginPresentation.js';
import { attestOrigin, verifyOriginAttestation } from './OriginAttestation.js';
import { DEFAULT_ORIGIN_LIMITS, TelegramOriginHoldError } from './types.js';
import type { BotParameters, OriginDisplaySettings, OriginLimits, OriginPlatformReceipt, SealedBotRequest, TelegramOriginProducer, TelegramOriginRecord } from './types.js';
import type { OriginSessionRegistry } from './OriginSessionRegistry.js';
import type { RuntimeOriginObserver } from './RuntimeOriginObserver.js';
import type { AdmissionResult, ClaimInput, ClaimResult, ClaimFence, EvidenceReceipt, OriginAdmission, OutcomeInput, OutcomeWriteResult, StoredOriginInput, OriginAuditRecord, OriginListQuery, OriginListPage, OriginMetrics } from './StoreTypes.js';

export interface OriginServiceStore {
  getOperation?(operationId: string): Promise<OriginAuditRecord | null>;
  reserveDiagnostic(input: { originId: string; reason: string }): Promise<boolean>;
  completeDiagnostic(input: { originId: string; diagnosis?: string }): Promise<boolean>;
  getPayload(payloadId: string): Promise<Uint8Array>;
  getChild(childId: string): Promise<StoredChild | null>;
  addMaterialization(input: DerivedMaterializationInput): Promise<boolean>;
  putEvidence(record: StoredOriginInput): Promise<EvidenceReceipt>;
  putVerifiedEvidence(input: { record: StoredOriginInput; verification: import('./StoreTypes.js').OriginAcceptanceVerification }): Promise<EvidenceReceipt>;
  admit(input: OriginAdmission): Promise<AdmissionResult>;
  claim(input: ClaimInput): Promise<ClaimResult>;
  markDispatched(fence: ClaimFence): Promise<boolean>;
  releaseUndispatchedClaim?(fence: ClaimFence): Promise<boolean>;
  recordOutcome(input: OutcomeInput): Promise<OutcomeWriteResult>;
  recordOperationState(input: {operationId: string; state: 'held' | 'suppressed' | 'expired' | 'admitted'; now?: number}): Promise<boolean>;
  getOrigin(originId: string): Promise<OriginAuditRecord | null>;
  listOrigins(query?: OriginListQuery): Promise<OriginListPage>;
  getMetrics(): Promise<OriginMetrics>;
}
export interface OriginServiceOptions {
  capacity?: OriginCapacityAuthority;
  sendPolicy?: OriginSendPolicyAuthority;
  authorizeOrigin?: (record: TelegramOriginRecord) => boolean | Promise<boolean>;
  store: OriginServiceStore;
  sessions: OriginSessionRegistry;
  observer: RuntimeOriginObserver;
  identity: Pick<TelegramOriginProducer, 'agentId' | 'agentName' | 'originMachineId' | 'originMachineName'>;
  signingKey: { keyId: string; keyEpoch: number; privateKey: string };
  ownerBootId: string;
  display: (destination: { accountId: string; chatId: string | null; topicId: string | null }) => {
    agent?: Partial<OriginDisplaySettings>; conversation?: Partial<OriginDisplaySettings>;
  };
  authorize: (request: Readonly<SealedBotRequest>) => boolean | Promise<boolean>;
  reviewLegacyRecovery?: (text: string) => Promise<boolean>;
  spoolEvidence: (record: StoredOriginInput) => Promise<unknown>;
  peerEvidence?: (record: StoredOriginInput) => Promise<unknown>;
  onHold: (input: { operationId: string; reason: string; destination: { accountId: string; chatId: string | null; topicId: string | null } }) => void;
  diagnoseUnknown?: (originId: string, reason: string) => Promise<string | void>;
  diagnosticMode?: 'local' | 'delegate';
  limits?: Partial<OriginLimits>;
  now?: () => number;
}
interface OriginScope { producer: TelegramOriginProducer; operations: string[]; policy?: OriginSendPolicyInput; policyReviewed?: boolean;
  logicalSendKey?: string; logicalOrdinal?: number; }
export interface OriginPreparedBotOperation { record: TelegramOriginRecord; admission: OriginAdmission; }
export type OriginBotTransport = ((request: Readonly<SealedBotRequest>) => Promise<Response>) & {
  prepare?: (request: Readonly<SealedBotRequest>) => Promise<{ send: () => Promise<Response>; valid: () => boolean; cancel: () => void }>;
};
function normalizedModel(value: { value: string | null; status: 'observed' | 'configured' | 'unknown' | 'not-applicable'; sourceEventRef?: string | null; observedAt?: string | number | null; reason?: string | null }) {
  return { value: value.value, status: value.status, sourceEventRef: value.sourceEventRef ?? null,
    observedAt: typeof value.observedAt === 'number' ? value.observedAt : value.observedAt ? Date.parse(value.observedAt) : null, reason: value.reason ?? null };
}
const harnessNames: Record<string, string> = { 'codex-cli': 'Codex', 'claude-code': 'Claude Code', 'gemini-cli': 'Gemini', 'pi-cli': 'Pi', 'grok-build': 'Grok' };
async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('origin-stage-timeout')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
/** Preparation, recording and sole-outbox execution. Evidence copies never grant a claim. */
export class TelegramOriginService {
  readonly #scope = new AsyncLocalStorage<OriginScope>();
  readonly #producers = new Map<string, TelegramOriginProducer>();
  readonly #automationCredentials = new Map<string, { producer: TelegramOriginProducer; bodyDigest: string; topicId: number; expiresAt: number; logicalSendKey?: string }>();
  readonly #limits: OriginLimits;
  readonly #diagnosed = new Set<string>();
  readonly #held = new Map<string, { reason: string; since: number; operation: OriginPreparedBotOperation | null }>();
  readonly #expiredHolds = new Map<string, { reason: 'expired-unresolved'; since: number; expiredAt: number }>();
  #expiredHoldTotal = 0;
  #heldBytes = 0;
  #lastMetrics: OriginMetrics | null = null;
  constructor(readonly options: OriginServiceOptions) {
    this.#limits = { ...DEFAULT_ORIGIN_LIMITS, ...options.limits };
    for (const n of Object.values(this.#limits)) if (!Number.isSafeInteger(n) || n <= 0) throw new Error('origin: positive finite limits required');
    this.registerAutomationProducer('telegram-server');
  }
  #now(): number { return this.options.now?.() ?? Date.now(); }
  listAutomationProducerIds(): string[] { return [...this.#producers.keys()].sort(); }
  registerAutomationProducer(producerId: string): void {
    if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(producerId)) throw new Error('origin: invalid producer ID');
    const now = this.#now();
    const na = { value: null, status: 'not-applicable' as const, sourceEventRef: null, observedAt: null, reason: 'deterministic-automation' };
    this.#producers.set(producerId, { ...this.options.identity, sessionId: null, sessionIncarnation: null, turnId: null,
      producerKind: 'server-automation', producerId, harnessId: null, harnessName: null,
      machine: { value: this.options.identity.originMachineName, status: 'observed', sourceEventRef: 'machine-identity', observedAt: now, reason: null },
      harness: { ...na }, model: { ...na } });
  }
  runAsAutomation<T>(producerId: string, fn: () => T, model?: TelegramOriginProducer['model']): T {
    const registered = this.#producers.get(producerId);
    if (!registered) throw new TelegramOriginHoldError('unregistered-producer');
    return this.#scope.run({ producer: structuredClone({ ...registered, ...(model ? { model } : {}) }), operations: [] }, fn);
  }
  hasLogicalSendContext(): boolean { return !!this.#scope.getStore()?.logicalSendKey; }
  runAsUnboundAutomation<T>(producerId: string, fn: () => T): T {
    return this.runAsAuthoredAutomation(producerId, unknownAutomationAuthor(), fn);
  }
  runAsAuthoredAutomation<T>(producerId: string, author: OriginAutomationAuthor, fn: () => T): T {
    const registered = this.#producers.get(producerId);
    if (!registered) throw new TelegramOriginHoldError('unregistered-producer');
    const producer = structuredClone({ ...registered, ...author, harnessId: author.harness.value,
      harnessName: author.harness.value ? harnessNames[author.harness.value] ?? author.harness.value : null });
    return this.#scope.run({ producer, operations: [] }, fn);
  }
  /** Private in-process mint. HTTP callers cannot register producers or choose
   * author evidence. The one-use token binds the entire submitted request and
   * destination, expires in 30 seconds, and stores only its hash in memory. */
  issueAutomationReply(producerId: string, topicId: number, body: Record<string, unknown>,
    author: OriginAutomationAuthor = unknownAutomationAuthor(), logicalSendId?: string): string {
    if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new TelegramOriginHoldError('invalid-automation-destination');
    if (logicalSendId !== undefined && (!logicalSendId || logicalSendId.length > 256)) throw new TelegramOriginHoldError('invalid-logical-send-id');
    for (const [key, entry] of this.#automationCredentials) if (entry.expiresAt <= this.#now()) this.#automationCredentials.delete(key);
    if (this.#automationCredentials.size >= 1000) throw new TelegramOriginHoldError('automation-credential-capacity');
    const token = `ioa1_${randomBytes(32).toString('base64url')}`;
    const producer = this.runAsAuthoredAutomation(producerId, author, () => this.currentProducer());
    // Normalize exactly as JSON HTTP serialization (e.g. omitted undefined).
    const bodyDigest = originDigest(JSON.parse(JSON.stringify(body)));
    this.#automationCredentials.set(createHash('sha256').update(token).digest('hex'), {
      producer, bodyDigest, topicId, expiresAt: this.#now() + 30_000,
      ...(logicalSendId ? { logicalSendKey: originDigest({ producerId, topicId, logicalSendId,
        machineId: this.options.identity.originMachineId, agentId: this.options.identity.agentId }) } : {}) });
    return token;
  }
  runWithAutomationReply<T>(token: string, topicId: number, body: Record<string, unknown>, fn: () => T): T {
    const key = createHash('sha256').update(token).digest('hex');
    const entry = this.#automationCredentials.get(key);
    if (!entry || entry.expiresAt <= this.#now() || entry.topicId !== topicId || entry.bodyDigest !== originDigest(body)) {
      throw new TelegramOriginHoldError('invalid-automation-credential');
    }
    this.#automationCredentials.delete(key);
    return this.#scope.run({ producer: entry.producer, operations: [], logicalSendKey: entry.logicalSendKey, logicalOrdinal: 0 }, fn);
  }
  async runWithSessionToken<T>(token: string, fn: () => Promise<T>): Promise<T> {
    const verified = this.options.sessions.verify(token);
    if (!verified.ok) throw new TelegramOriginHoldError(verified.reason);
    const b = verified.binding;
    await this.options.observer.refresh(b.sessionId);
    const current = this.options.sessions.verify(token);
    if (!current.ok || current.binding.sessionIncarnation !== b.sessionIncarnation) {
      throw new TelegramOriginHoldError('session-no-longer-authorized');
    }
    const observation = this.options.observer.get(b.sessionId);
    if (!observation || observation.sessionIncarnation !== b.sessionIncarnation) throw new TelegramOriginHoldError('origin-observer-not-bound');
    const now = this.#now();
    const producer: TelegramOriginProducer = { ...this.options.identity, sessionId: b.sessionId,
      sessionIncarnation: b.sessionIncarnation, turnId: observation.turnId,
      producerKind: 'session', producerId: b.sessionId, harnessId: b.harnessId, harnessName: harnessNames[b.harnessId] ?? b.harnessId,
      machine: { value: this.options.identity.originMachineName, status: 'observed', sourceEventRef: 'machine-identity', observedAt: now, reason: null },
      harness: { value: b.harnessId, status: 'observed', sourceEventRef: `session:${b.sessionId}`, observedAt: now, reason: null },
      model: normalizedModel(observation.model) };
    return this.#scope.run({ producer, operations: [] }, fn);
  }
  hasProducerContext(): boolean { return this.#scope.getStore() !== undefined; }
  runWithSendPolicyInput<T>(text: string, metadata: unknown, fn: () => T): T {
    const scope = this.#scope.getStore();
    if (!scope) throw new TelegramOriginHoldError('producer-context-required');
    return this.#scope.run({ ...scope, policy: originSendPolicyInput(text, metadata), policyReviewed: false }, fn);
  }
  /** Only the existing route authority calls this after its real review passed. */
  markCurrentSendPolicyReviewed(): void {
    const scope = this.#scope.getStore();
    if (scope?.policy) scope.policyReviewed = true;
  }
  currentSendPolicyInput(text: string, metadata?: unknown): OriginSendPolicyInput {
    return structuredClone(this.#scope.getStore()?.policy ?? originSendPolicyInput(text, metadata));
  }
  private requiresSendPolicy(record: TelegramOriginRecord): boolean {
    return record.producerKind === 'session' || record.destination.transport !== 'bot-api' ||
      record.originMachineId !== this.options.identity.originMachineId;
  }
  authorizeSendPolicyDispatch(record: TelegramOriginRecord): void {
    if (!this.requiresSendPolicy(record)) return;
    if (!this.options.sendPolicy) throw new TelegramOriginHoldError('send-policy-unavailable', record.operationId);
    const decision = this.options.sendPolicy.authorizeDispatch(record);
    if (!decision.ok) throw new OriginSendPolicyRefusal(decision, record.operationId);
  }
  async authorizeOriginDispatch(record: TelegramOriginRecord): Promise<void> {
    const local = record.originMachineId === this.options.identity.originMachineId ||
      record.producerKind === 'imported-legacy' && record.importedByMachineId === this.options.identity.originMachineId;
    if (!this.options.authorizeOrigin) {
      if (!local) throw new TelegramOriginHoldError('origin-authority-unavailable', record.operationId);
      return;
    }
    if (!await this.options.authorizeOrigin(record)) throw new TelegramOriginHoldError('origin-authority-revoked', record.operationId);
  }
  async reviewPreparedSendPolicy(operation: OriginPreparedBotOperation): Promise<void> {
    if (!this.requiresSendPolicy(operation.record)) return;
    this.authorizeSendPolicyDispatch(operation.record);
    const first = parseOriginJson(operation.admission.children[0]?.materializations[0]?.requestJson ?? 'null') as unknown as { policy?: unknown };
    if (!validOriginSendPolicyInput(first?.policy)) throw new TelegramOriginHoldError('send-policy-input-unavailable', operation.record.operationId);
    const scope = this.#scope.getStore();
    const alreadyReviewed = scope?.policyReviewed && scope.producer.sessionId === operation.record.sessionId &&
      operation.record.originMachineId === this.options.identity.originMachineId &&
      canonicalOrigin(scope.policy) === canonicalOrigin(first.policy);
    if (!alreadyReviewed) {
      const decision = await this.options.sendPolicy!.review(operation.record, structuredClone(first.policy));
      if (!decision.ok) throw new OriginSendPolicyRefusal(decision, operation.record.operationId);
    }
    this.authorizeSendPolicyDispatch(operation.record);
  }
  async reservePreparedContent(operation: OriginPreparedBotOperation): Promise<void> {
    const authority = this.options.sendPolicy;
    if (!authority?.reserveContent || !authority.completeContent) {
      if (this.requiresSendPolicy(operation.record)) throw new TelegramOriginHoldError('content-dedup-unavailable', operation.record.operationId);
      return;
    }
    const first = parseOriginJson(operation.admission.children[0]?.materializations[0]?.requestJson ?? 'null') as unknown as { policy?: unknown };
    if (!validOriginSendPolicyInput(first?.policy)) {
      if (this.requiresSendPolicy(operation.record)) throw new TelegramOriginHoldError('send-policy-input-unavailable', operation.record.operationId);
      return;
    }
    const decision = await authority.reserveContent(operation.record, first.policy, operation.admission.deadlineAt);
    if (!decision.ok) {
      if (decision.reason === 'duplicate-content') {
        // A suppressed fresh operation must never become a delayed duplicate
        // when the content window expires. The outbox owns this terminal state.
        if (!await this.options.store.recordOperationState({ operationId: operation.record.operationId, state: 'suppressed' })) {
          throw new TelegramOriginHoldError('duplicate-suppression-unrecorded', operation.record.operationId);
        }
      }
      throw new OriginSendPolicyRefusal(decision, operation.record.operationId);
    }
  }
  async completePreparedContent(operation: OriginPreparedBotOperation): Promise<void> {
    const first = parseOriginJson(operation.admission.children[0]?.materializations[0]?.requestJson ?? 'null') as unknown as { policy?: unknown };
    if (validOriginSendPolicyInput(first?.policy)) await this.options.sendPolicy?.completeContent?.(operation.record, first.policy);
  }
  currentProducer(): TelegramOriginProducer {
    const p = this.#scope.getStore()?.producer;
    if (!p) throw new TelegramOriginHoldError('producer-context-required');
    return structuredClone(p);
  }
  currentOperationIds(): string[] { return [...(this.#scope.getStore()?.operations ?? [])]; }
  prepareImportedLegacy(snapshot: OriginLegacySnapshot, accountId: string, chatId: string): OriginPreparedBotOperation {
    const unknown = { value: null, status: 'unknown' as const, sourceEventRef: null, observedAt: null, reason: 'legacy-unattributed' };
    const producer: TelegramOriginProducer = { ...this.options.identity,
      originMachineId: 'legacy-unattributed', originMachineName: 'Unknown (legacy)',
      sessionId: null, sessionIncarnation: null, turnId: null, producerKind: 'imported-legacy',
      producerId: 'legacy-pending-relay', harnessId: null, harnessName: null,
      machine: { ...unknown }, harness: { ...unknown }, model: { ...unknown } };
    const safeText = redact(snapshot.text);
    const formatted = snapshot.format === 'HTML' ? { text: safeText, parseMode: 'HTML' }
      : formatForTelegram(safeText, snapshot.format === 'plain' ? 'plain' : 'markdown');
    const operation = this.#scope.run({ producer, operations: [] }, () => this.prepareBot({
      method: 'sendMessage', accountId, operationId: `legacy:${snapshot.deliveryId}`,
      params: { chat_id: chatId, message_thread_id: snapshot.topicId, text: formatted.text,
        ...(formatted.parseMode ? { parse_mode: formatted.parseMode } : {}) },
    }));
    operation.record.createdAt = snapshot.preparedAt;
    operation.record.deliveryId = snapshot.deliveryId;
    operation.record.importedByMachineId = this.options.identity.originMachineId;
    operation.record.legacySnapshotDigest = snapshot.snapshotDigest;
    const { attestation: _old, ...unsigned } = operation.record;
    operation.record.attestation = attestOrigin(unsigned, this.options.signingKey, this.#now());
    operation.admission.preparedAt = snapshot.preparedAt;
    operation.admission.deadlineAt = snapshot.preparedAt + this.#limits.deadlineMs;
    operation.admission.children[0].deliveryId = snapshot.deliveryId;
    const envelopeJson = canonicalOrigin(operation.record);
    operation.admission.record = { ...operation.admission.record, createdAt: snapshot.preparedAt,
      envelopeJson, envelopeDigest: wireDigest(envelopeJson) };
    sealOriginAdmission(operation, this.options.signingKey, this.#now());
    return operation;
  }
  prepareBot(input: { method: string; accountId: string; params: BotParameters; operationId?: string; executionOwnerMachineId?: string;
    attachments?: import('./OriginMultipart.js').PreparedOriginAttachments; policyInput?: OriginSendPolicyInput }): OriginPreparedBotOperation {
    const producer = this.currentProducer();
    const destination = { accountId: input.accountId, chatId: input.params.chat_id === undefined ? null : String(input.params.chat_id),
      topicId: input.params.message_thread_id === undefined ? null : String(input.params.message_thread_id) };
    const preferences = this.options.display(destination);
    const display = resolveOriginDisplay(preferences.agent, preferences.conversation);
    const plan = planBotOrigin({ ...input, producer, display, maxChildren: this.#limits.maxChildren });
    // Preserve authored text before footer/splitting. HTTP and relay ingress may
    // carry the original pre-formatter text through a private runtime scope.
    const texts = [input.params.text, input.params.caption].filter((value): value is string => typeof value === 'string');
    if (input.params.media) {
      const media = typeof input.params.media === 'string' ? parseOriginJson(input.params.media) : input.params.media;
      for (const item of Array.isArray(media) ? media : [media]) {
        if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.caption === 'string') texts.push(item.caption);
      }
    }
    const policy = input.policyInput ?? this.currentSendPolicyInput(texts.join('\n\n'));
    if (!validOriginSendPolicyInput(policy)) throw new TelegramOriginHoldError('invalid-send-policy-input');
    // One logical policy input, retained in the first protected materialization.
    plan.children[0].request.policy = structuredClone(policy);
    plan.children[0].requestDigest = wireDigest(canonicalOrigin(plan.children[0].request));
    const scope = this.#scope.getStore();
    const logicalOperationId = scope?.logicalSendKey ? originDigest({ key: scope.logicalSendKey, ordinal: scope.logicalOrdinal ?? 0 }) : undefined;
    if (scope?.logicalSendKey) scope.logicalOrdinal = (scope.logicalOrdinal ?? 0) + 1;
    const now = this.#now(), operationId = input.operationId ?? logicalOperationId ?? randomUUID(), originId = randomUUID();
    const unsigned = { ...producer, schemaVersion: 'instar-telegram-origin-v1' as const, originId, operationId,
      executionOwnerMachineId: input.executionOwnerMachineId ?? this.options.identity.originMachineId,
      childLinks: plan.children.map(child => ({ childId: child.childId, companionOf: child.request.companionOf ?? null })),
      ...(/^(forward|copy)Messages?$/.test(input.method) && input.params.from_chat_id !== undefined
        ? { forwardedFrom: { chatId: String(input.params.from_chat_id),
          messageIds: (Array.isArray(input.params.message_ids) ? input.params.message_ids : [input.params.message_id]).map(String) } } : {}),
      deliveryId: operationId, createdAt: now, operationKind: input.method, destination: plan.destination,
      contentDigest: plan.contentDigest, planDigest: originDigest(plan.children), display };
    const record: TelegramOriginRecord = { ...unsigned, attestation: attestOrigin(unsigned, this.options.signingKey, now) };
    const envelopeJson = canonicalOrigin(record);
    const stored: StoredOriginInput = { originId, machineId: producer.originMachineId, createdAt: now,
      envelopeJson, envelopeDigest: wireDigest(envelopeJson), harnessId: producer.harnessId ?? 'automation', evidenceStatus: producer.model.status };
    const admission: OriginAdmission = { record: stored, operationId, preparedAt: now, deadlineAt: now + this.#limits.deadlineMs,
      maxAttempts: this.#limits.maxAttempts, payloadBytes: plan.children.reduce((n, child) => n + Buffer.byteLength(canonicalOrigin(child.request)), 0)
        + (input.attachments?.payloads.reduce((n, payload) => n + payload.size, 0) ?? 0),
      ...(input.attachments ? { payloads: input.attachments.payloads } : {}),
      children: plan.children.map(child => ({ childId: child.childId, deliveryId: child.childId,
        ...(child.request.companionOf ? { allowedDerivations: ['companion-receipt' as const] } : {}),
        destinationJson: canonicalOrigin(child.request.destination), canonicalContentDigest: plan.contentDigest,
        materializations: [{ materializationId: child.materializationId, requestJson: canonicalOrigin(child.request), requestDigest: child.requestDigest }] })) };
    this.#scope.getStore()?.operations.push(operationId);
    const operation = { record, admission };
    sealOriginAdmission(operation, this.options.signingKey, now);
    return operation;
  }
  async #recordEvidence(record: StoredOriginInput): Promise<void> {
    try { await within(this.options.store.putEvidence(record), 250); return; } catch { /* Inert evidence only; a late commit cannot send. */ }
    try { await within(this.options.spoolEvidence(record), 500); return; } catch { /* Distinct local path can share the same physical disk. */ }
    if (this.options.peerEvidence) {
      try { await within(this.options.peerEvidence(record), 1250); return; } catch { /* Peer evidence is inert; all failures hold below. */ }
    }
    throw new TelegramOriginHoldError('all-durable-recording-sinks-unavailable');
  }
  #hold(operation: OriginPreparedBotOperation, reason: string): never {
    this.pruneExpiredHolds();
    const id = operation.record.operationId;
    if (!this.#held.has(id)) {
      if (this.#held.size >= this.#limits.maxActiveOperations || this.#heldBytes + operation.admission.payloadBytes > this.#limits.maxActivePayloadBytes) {
        this.options.onHold({ operationId: id, reason: 'held-payload-capacity-unavailable', destination: operation.record.destination });
        throw new TelegramOriginHoldError('held-payload-capacity-unavailable', id);
      }
      this.#heldBytes += operation.admission.payloadBytes;
      this.#held.set(id, { reason, since: this.#now(), operation: structuredClone(operation) });
    } else this.#held.get(id)!.reason = reason;
    this.options.onHold({ operationId: id, reason, destination: operation.record.destination });
    throw new TelegramOriginHoldError(reason, id);
  }
  /** Bounded recovery candidates. Unknown acceptance never enters this list.
   * During a total storage outage these bytes are memory-only; expose that
   * limitation rather than pretending a successful durable queue admission.
   */
  heldOperations(limit = 10): OriginPreparedBotOperation[] {
    this.pruneExpiredHolds();
    const result: OriginPreparedBotOperation[] = [];
    const selected: Array<[string, { reason: string; since: number; operation: OriginPreparedBotOperation | null }]> = [];
    for (const [id, held] of this.#held) {
      if (held.operation && ['all-durable-recording-sinks-unavailable', 'execution-admission-unavailable', 'destination-not-authorized'].includes(held.reason)) {
        result.push(structuredClone(held.operation));
        selected.push([id, held]);
        if (result.length >= Math.max(1, Math.min(100, limit))) break;
      }
    }
    // The same first ten unavailable payloads must not starve later work.
    for (const [id, held] of selected) { this.#held.delete(id); this.#held.set(id, held); }
    return result;
  }
  private pruneExpiredHolds(): void {
    for (const [id, held] of this.#held) {
      if (!held.operation || held.operation.admission.deadlineAt > this.#now()) continue;
      this.#heldBytes -= held.operation.admission.payloadBytes;
      this.#held.delete(id); this.#expiredHoldTotal++;
      this.#expiredHolds.set(id, { reason: 'expired-unresolved', since: held.since, expiredAt: held.operation.admission.deadlineAt });
      if (this.#expiredHolds.size > 1000) this.#expiredHolds.delete(this.#expiredHolds.keys().next().value!);
    }
  }
  expiredHeldStatus() {
    return { totalSinceBoot: this.#expiredHoldTotal, retained: [...this.#expiredHolds].map(([operationId, value]) => ({ operationId, ...value })),
      retention: 'last-1000-this-process' as const };
  }
  heldStatus() {
    return [...this.#held].map(([operationId, held]) => ({ operationId, reason: held.reason, since: held.since,
      payloadRetainedInMemory: held.operation !== null, deadlineAt: held.operation?.admission.deadlineAt ?? null }));
  }
  async admit(operation: OriginPreparedBotOperation): Promise<void> {
    if (!validOriginAdmission(operation)) throw new TelegramOriginHoldError('sealed-admission-mismatch', operation.record.operationId);
    await this.recordIntent(operation);
    try {
      const record = operation.record;
      const attestingMachine = record.producerKind === 'imported-legacy' ? record.importedByMachineId : record.originMachineId;
      if (attestingMachine === this.options.identity.originMachineId) {
        if (this.options.authorizeOrigin && !await this.options.authorizeOrigin(record)) return this.#hold(operation, 'origin-authority-unavailable');
        const key = { ...this.options.signingKey, machineId: attestingMachine, agentId: record.agentId,
          publicKey: createPublicKey(this.options.signingKey.privateKey).export({ type: 'spki', format: 'pem' }).toString(),
          validFrom: null, validUntil: null, revokedAt: null };
        const verified = verifyOriginAttestation(record, key, { machineId: attestingMachine, agentId: record.agentId }, this.#now());
        if (!verified.valid) return this.#hold(operation, verified.reason);
        await within(this.options.store.putVerifiedEvidence({ record: operation.admission.record,
          verification: { envelopeDigest: operation.admission.record.envelopeDigest, verifierMachineId: attestingMachine,
            keyId: key.keyId, keyEpoch: key.keyEpoch, keyFingerprint: wireDigest(key.publicKey), verifiedAt: verified.verifiedAt,
            keyStatusAtAcceptance: 'active' } }), 1000);
      }
      await within(this.options.store.admit(operation.admission), 1000);
    }
    catch { return this.#hold(operation, 'execution-admission-unavailable'); }
  }
  /** Tokenless origins retain evidence only. The authenticated destination
   * credential owner must independently admit the sealed plan to its outbox. */
  async recordIntent(operation: OriginPreparedBotOperation): Promise<void> {
    try { await this.#recordEvidence(operation.admission.record); }
    catch { return this.#hold(operation, 'all-durable-recording-sinks-unavailable'); }
  }
  async sendBot(input: { method: string; accountId: string; params: BotParameters; attachments?: import('./OriginMultipart.js').PreparedOriginAttachments },
    network: OriginBotTransport): Promise<Response> {
    const operation = this.prepareBot(input);
    try {
      if (this.#scope.getStore()?.logicalSendKey) {
        if (!this.options.store.getOperation) throw new TelegramOriginHoldError('logical-send-index-unavailable', operation.record.operationId);
        const existing = await this.options.store.getOperation(operation.record.operationId);
        if (existing) {
          const original = JSON.parse(existing.record.envelopeJson) as TelegramOriginRecord;
          if (original.originMachineId !== operation.record.originMachineId || original.agentId !== operation.record.agentId ||
            original.producerId !== operation.record.producerId || original.operationKind !== operation.record.operationKind ||
            original.contentDigest !== operation.record.contentDigest || canonicalOrigin(original.destination) !== canonicalOrigin(operation.record.destination)) {
            // The old operation's receipt must not resolve a different body.
            throw new TelegramOriginHoldError('logical-send-content-conflict');
          }
          if (existing.operation?.state === 'accepted' && existing.children.length > 0 && existing.children.every(child => child.state === 'accepted')) {
            const primary = existing.children.filter(child => !original.childLinks?.find(link => link.childId === child.childId)?.companionOf).at(-1);
            const receipt = primary && existing.attempts.find(attempt => attempt.childId === primary.childId && attempt.outcome === 'accepted')?.receiptJson;
            if (receipt && existing.children.every(child => existing.attempts.some(attempt => attempt.childId === child.childId && attempt.outcome === 'accepted' && attempt.receiptJson))) {
              const response = replayBotReceipt(JSON.parse(receipt) as OriginBotReceipt);
              response.headers.set('X-Instar-Origin-Id', original.originId);
              return response;
            }
          }
          throw new TelegramOriginHoldError('original-operation-unresolved', operation.record.operationId,
            existing.operation?.state === 'outcome-unknown' ? 'outcome-unknown' : 'held');
        }
      }
      await this.bindRevision(operation);
      await this.admit(operation);
      return await this.executePreparedBot(operation, network);
    } catch (error) {
      if (error instanceof TelegramOriginHoldError) throw error;
      return this.#hold(operation, 'origin-execution-state-unavailable');
    }
  }
  async bindRevision(operation: OriginPreparedBotOperation): Promise<void> {
    const destination = operation.record.destination;
    if (!destination.messageId || !operation.record.operationKind.toLowerCase().includes('edit')) return;
    let revisionOf: string | null = null;
    try {
      const page = await this.options.store.listOrigins({ limit: 1, transport: destination.transport,
        accountId: destination.accountId, chatId: destination.chatId ?? undefined,
        topicId: destination.topicId ?? undefined, messageId: destination.messageId });
      revisionOf = page.records[0]?.record.originId ?? null;
    } catch { /* An unavailable creator remains explicitly unknown; never invent or replace it. */ }
    const { attestation: _old, ...unsigned } = operation.record;
    operation.record = { ...unsigned, revisionOf, attestation: attestOrigin({ ...unsigned, revisionOf }, this.options.signingKey, this.#now()) };
    const envelopeJson = canonicalOrigin(operation.record);
    operation.admission.record.envelopeJson = envelopeJson;
    operation.admission.record.envelopeDigest = wireDigest(envelopeJson);
  }
  async executePreparedBot(operation: OriginPreparedBotOperation,
    network: OriginBotTransport): Promise<Response> {
    // Detach caller-owned input before any await. The stored claim below must
    // match this same snapshot, including every materialization's exact bytes.
    operation = structuredClone(operation);
    if (operation.record.executionOwnerMachineId !== this.options.identity.originMachineId) {
      throw new TelegramOriginHoldError('execution-owner-mismatch', operation.record.operationId);
    }
    const plannedChildren = operation.admission.children.map(child => ({ childId: child.childId,
      materializationId: child.materializations[0]?.materializationId,
      request: parseOriginJson(child.materializations[0]?.requestJson ?? 'null'),
      requestDigest: child.materializations[0]?.requestDigest }));
    if (originDigest(plannedChildren) !== operation.record.planDigest) return this.#hold(operation, 'sealed-plan-mismatch');
    const stored = await this.options.store.getOrigin(operation.record.originId);
    if (!stored || stored.record.envelopeJson !== canonicalOrigin(operation.record) ||
      stored.operation?.operationId !== operation.record.operationId) return this.#hold(operation, 'stored-origin-mismatch');
    if (stored.children.some(child => child.state !== 'accepted')) {
      await this.reviewPreparedSendPolicy(operation);
      await this.reservePreparedContent(operation);
    }
    let last: Response | null = null;
    for (const child of operation.admission.children) {
      let materialization = child.materializations[0];
      let request = parseOriginJson(materialization.requestJson) as unknown as SealedBotRequest;
      Object.freeze(request.destination);
      Object.freeze(request);
      if (wireDigest(materialization.requestJson) !== materialization.requestDigest || canonicalOrigin(request.destination) !== child.destinationJson ||
        request.accountId !== operation.record.destination.accountId) return this.#hold(operation, 'sealed-request-mismatch');
      const existing = stored.children.find(row => row.childId === child.childId);
      if (existing?.state === 'accepted') {
        const receiptJson = stored.attempts.find(a => a.childId === child.childId && a.outcome === 'accepted')?.receiptJson;
        if (!receiptJson) return this.#hold(operation, 'accepted-child-receipt-unavailable');
        if (!request.companionOf) last = replayBotReceipt(JSON.parse(receiptJson) as OriginBotReceipt);
        continue;
      }
      if (request.companionOf) {
        materialization = await bindBotCompanion(this.options.store, operation, child, request);
        request = parseOriginJson(materialization.requestJson) as unknown as SealedBotRequest;
        Object.freeze(request.destination); Object.freeze(request);
      }
      if (operation.record.producerKind === 'imported-legacy') {
        if (!this.options.reviewLegacyRecovery) return this.#hold(operation, 'legacy-review-unavailable');
        const body = JSON.parse(request.body);
        if (!await this.options.reviewLegacyRecovery(String(body.text ?? ''))) return this.#hold(operation, 'legacy-review-rejected');
      }
      if (!await this.options.authorize(request)) return this.#hold(operation, 'destination-not-authorized');
      await this.authorizeOriginDispatch(operation.record);
      this.authorizeSendPolicyDispatch(operation.record);
      let prepared: Awaited<ReturnType<NonNullable<OriginBotTransport['prepare']>>> | undefined;
      try { prepared = await network.prepare?.(request); }
      catch (error) { if (error instanceof OriginCapacityUnavailable) return this.#hold(operation, error.message); throw error; }
      const claim = await this.options.store.claim({ childId: child.childId, materializationId: materialization.materializationId,
        ownerBootId: this.options.ownerBootId, leaseMs: 60_000 });
      if (claim.status !== 'claimed') return this.#hold(operation, `outbox-${claim.reason}`);
      if (claim.child.originId !== operation.record.originId || claim.child.operationId !== operation.record.operationId || claim.child.materialization.requestJson !== materialization.requestJson) return this.#hold(operation, 'claim-request-mismatch');
      // Ownership may be revoked while the durable claim transaction runs.
      if (!await this.options.authorize(request)) return this.#hold(operation, 'destination-not-authorized');
      this.authorizeSendPolicyDispatch(operation.record);
      if (prepared && !prepared.valid()) {
        prepared.cancel();
        await this.options.store.releaseUndispatchedClaim?.(claim.child);
        return this.#hold(operation, 'credential-capacity-unavailable');
      }
      if (!await this.options.store.markDispatched(claim.child)) return this.#hold(operation, 'stale-dispatch-fence');
      await this.authorizeOriginDispatch(operation.record);
      this.authorizeSendPolicyDispatch(operation.record);
      let response: Response;
      try { response = prepared ? await prepared.send() : await network(Object.freeze(request)); }
      catch (error) {
        if (error instanceof OriginCapacityUnavailable || error instanceof OriginTransportCancelledBeforeNetwork) {
          // This in-process closure was invalidated before invoking network.
          // Retain the charged attempt once dispatch intent was durable. A
          // crash without this proof remains outcome-unknown on recovery.
          const nextAttemptAt = nextOriginKnownFailure({ attempt: claim.child.attemptNumber,
            maxAttempts: operation.admission.maxAttempts, deadlineAt: operation.admission.deadlineAt, now: this.#now() });
          await this.options.store.recordOutcome({ ...claim.child, outcome: 'known-failed', reason: error.message,
            ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }) });
          return this.#hold(operation, error.message);
        }
        await this.#outcomeUnknown(operation, claim.child, 'transport-acceptance-unknown');
        throw new TelegramOriginHoldError('transport-acceptance-unknown', operation.record.operationId, 'outcome-unknown');
      }
      type BotResponse = { ok?: boolean; result?: unknown; error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } };
      let parsed: BotResponse | null = null;
      try { parsed = JSON.parse(await response.clone().text()) as BotResponse; } catch { /* No concrete receipt; never infer success from HTTP alone. */ }
      const receipt = correlateBotReceipt(request, parsed?.result, this.#now());
      if (response.ok && parsed?.ok === true && receipt) {
        let saved: OutcomeWriteResult;
        try { saved = await this.options.store.recordOutcome({ ...claim.child, outcome: 'accepted', receiptJson: canonicalOrigin(receipt) }); }
        catch { throw new TelegramOriginHoldError('receipt-persistence-unavailable', operation.record.operationId, 'outcome-unknown'); }
        if (!saved.recorded) throw new TelegramOriginHoldError('receipt-persistence-unavailable', operation.record.operationId, 'outcome-unknown');
        if (!request.companionOf) last = response;
      } else if (response.status >= 400 && response.status < 500 && parsed?.ok === false) {
        const retryAfter = parsed.parameters?.retry_after;
        const nextAttemptAt = response.status === 429 ? nextOriginKnownFailure({ attempt: claim.child.attemptNumber,
          maxAttempts: operation.admission.maxAttempts, deadlineAt: operation.admission.deadlineAt, now: this.#now(),
          minimumDelayMs: Number.isSafeInteger(retryAfter) && Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 0 }) : undefined;
        const saved = await this.options.store.recordOutcome({ ...claim.child, outcome: 'known-failed', reason: `telegram-${response.status}`,
          ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }) });
        const error = new TelegramOriginHoldError(`telegram-${response.status}`, operation.record.operationId, 'known-failed');
        if (saved.recorded) recordTelegramEditRejection(error, response.status, parsed, {
          method: request.method, accountId: request.accountId, params: JSON.parse(request.body),
        });
        throw error;
      } else {
        const partial = response.ok && parsed?.ok === true ? correlatePartialBotReceipt(request, parsed.result, this.#now()) : null;
        const reason = partial ? 'partial-platform-receipt' : 'response-without-correlated-receipt';
        await this.#outcomeUnknown(operation, claim.child, reason, partial ?? undefined);
        throw new TelegramOriginHoldError(reason, operation.record.operationId, 'outcome-unknown');
      }
    }
    if (!last) return this.#hold(operation, 'empty-prepared-plan');
    await this.completePreparedContent(operation);
    const held = this.#held.get(operation.record.operationId);
    if (held?.operation) this.#heldBytes -= held.operation.admission.payloadBytes;
    this.#held.delete(operation.record.operationId);
    const headers = new Headers(last.headers); headers.set('X-Instar-Origin-Id', operation.record.originId);
    return new Response(last.body, { status: last.status, statusText: last.statusText, headers });
  }
  async recordSuppressed(input: { method: string; accountId: string; params: BotParameters }, reason: string): Promise<string> {
    const operation = this.prepareBot(input);
    await this.admit(operation);
    await this.options.store.recordOperationState({ operationId: operation.record.operationId, state: 'suppressed' });
    return operation.record.originId;
  }
  async #outcomeUnknown(operation: OriginPreparedBotOperation, fence: ClaimFence, reason: string, receipt?: OriginBotReceipt): Promise<void> {
    try { await this.options.store.recordOutcome({ ...fence, outcome: 'outcome-unknown', reason,
      ...(receipt ? { receiptJson: canonicalOrigin(receipt) } : {}) }); }
    catch {
      const previous = this.#held.get(operation.record.operationId);
      if (previous?.operation) this.#heldBytes -= previous.operation.admission.payloadBytes;
      if (previous || this.#held.size < this.#limits.maxActiveOperations) {
        this.#held.set(operation.record.operationId, { reason: 'receipt-store-unavailable', since: this.#now(), operation: null });
      }
    }
    this.requestDiagnosis(operation.record.originId, reason);
  }
  requestDiagnosis(originId: string, reason: string): void {
    if (this.options.diagnoseUnknown && !this.#diagnosed.has(originId) && this.#diagnosed.size < 32) {
      this.#diagnosed.add(originId);
      void (async () => {
        if (this.options.diagnosticMode === 'delegate') {
          await within(this.options.diagnoseUnknown!(originId, reason), 30_000);
          return; // The receiving supervisor owns the single durable consult.
        }
        if (!await this.options.store.reserveDiagnostic({ originId, reason })) return;
        let diagnosis: string | void;
        try { diagnosis = await within(this.options.diagnoseUnknown!(originId, reason), 30_000); }
        catch { diagnosis = undefined; }
        await this.options.store.completeDiagnostic({ originId,
          ...(typeof diagnosis === 'string' && Buffer.byteLength(diagnosis) <= 8192 ? { diagnosis } : {}) });
      })().catch(() => {
        console.warn('[telegram-origin] diagnostic unavailable; receipt remains unknown');
      }).finally(() => { this.#diagnosed.delete(originId); });
    }
  }
  async metrics(): Promise<OriginMetrics | { sampledAt: number | null; stale: true; coverage: 'unknown'; counts: Record<string, number> | null; liveHeld: number }> {
    try { this.#lastMetrics = await this.options.store.getMetrics(); return this.#lastMetrics; }
    catch { return { sampledAt: this.#lastMetrics?.sampledAt ?? null, stale: true, coverage: 'unknown',
      counts: this.#lastMetrics?.counts ?? null, liveHeld: this.#held.size }; }
  }
}
