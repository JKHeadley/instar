import { sealOriginAdmission } from './OriginAdmissionSeal.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { assertOutgoingPayloadVisible } from '../invisible-payload.js';
import { canonicalOrigin, originDigest, parseOriginJson, wireDigest } from './CanonicalOrigin.js';
import { attestOrigin } from './OriginAttestation.js';
import { originFooter, resolveOriginDisplay } from './OriginPresentation.js';
import { TelegramBrowserBroker } from './TelegramBrowserBroker.js';
import type { TelegramBrowserBrokerOptions } from './TelegramBrowserBroker.js';
import { browserOperationDigest } from './BrowserTypes.js';
import type { BrowserDestination, BrowserJson, BrowserReceipt, PreparedBrowserChild } from './BrowserTypes.js';
import type { TelegramOriginService, OriginPreparedBotOperation } from './TelegramOriginService.js';
import type { OriginStore } from './OriginStore.js';
import type { ClaimedChild } from './StoreTypes.js';
import { TelegramOriginHoldError } from './types.js';
import type { OriginDestination, TelegramOriginRecord } from './types.js';
import { materializeBrowserSignature } from './OriginBrowserRenewal.js';
import { nextOriginKnownFailure } from './OriginRetry.js';

type SealedBrowserRequest = Omit<PreparedBrowserChild, 'childId' | 'originId' | 'claimFence'> & {
  policy?: import('./OriginSendPolicy.js').OriginSendPolicyInput;
};
export interface OriginBrowserInput {
  destination: BrowserDestination;
  /** Resolved by the enrolled account's read-only peer authority, never a caller access hash. */
  peer: { [key: string]: BrowserJson };
  text: string;
  messageId?: number;
}
export interface OriginBrowserExecutorOptions extends Omit<TelegramBrowserBrokerOptions, 'authorizePreparedChild'> {
  service: TelegramOriginService;
  store: () => OriginStore;
  accountId: string;
  transport: 'telegram-web' | 'telegram-mtproto';
  /** Owning agent's ASP key capability. This is not a general sign-as endpoint. */
  signBody: (body: string, topicId: number, timestamp: number) => string;
  authorize: (destination: OriginDestination) => boolean | Promise<boolean>;
}

/** The typed browser path uses the SAME credential-owner outbox as Bot API.
 * Only this class converts a durable claim to the broker's private capability.
 */
export class OriginBrowserExecutor {
  readonly broker: TelegramBrowserBroker;
  private readonly claims = new Map<string, { claim: ClaimedChild; request: SealedBrowserRequest; destination: OriginDestination; record: TelegramOriginRecord }>();
  constructor(readonly options: OriginBrowserExecutorOptions) {
    this.broker = new TelegramBrowserBroker({ ...options,
      authorizePreparedChild: async child => {
        const active = this.claims.get(child.childId);
        if (!active || active.claim.claimToken !== child.claimFence || active.claim.originId !== child.originId) return false;
        const { childId: _child, originId: _origin, claimFence: _fence, ...request } = child;
        if (canonicalOrigin(request) !== canonicalOrigin(active.request) ||
          !await options.authorize(active.destination)) return false;
        await options.service.authorizeOriginDispatch(active.record);
        options.service.authorizeSendPolicyDispatch(active.record);
        // The broker has completed the read-only canary. Mark the attempt now,
        // immediately before invoking the sole private transport connection.
        const dispatched = await options.store().markDispatched(active.claim);
        await options.service.authorizeOriginDispatch(active.record);
        options.service.authorizeSendPolicyDispatch(active.record);
        return dispatched;
      },
    });
  }
  prepare(input: OriginBrowserInput): OriginPreparedBotOperation {
    const original = structuredClone(input);
    assertOutgoingPayloadVisible('sendMessage', { text: original.text });
    const service = this.options.service, producer = service.currentProducer();
    const now = this.options.now?.() ?? Date.now();
    const originId = randomUUID(), operationId = randomUUID();
    const topicId = original.destination.topicId ?? 0;
    const destination: OriginDestination = { version: 1, transport: this.options.transport,
      accountId: this.options.accountId, chatId: `${original.destination.kind}:${original.destination.id}`,
      topicId: original.destination.topicId === undefined ? null : String(topicId),
      messageId: original.messageId === undefined ? null : String(original.messageId),
      inlineMessageId: null, scheduledMessageId: null };
    const preferences = service.options.display(destination);
    const display = resolveOriginDisplay(preferences.agent, preferences.conversation);
    const footer = originFooter(producer, display);
    // ASP's exact overhead is measured using an empty body. Every actual chunk
    // is then independently signed, so neither splitting nor the footer can
    // mutate a signed body. Unicode scalar boundaries are preserved.
    const stamp = Math.floor(now / 1000);
    const overhead = this.options.signBody('', topicId, stamp).length;
    const capacity = 4096 - overhead - (footer ? footer.length + 2 : 0);
    if (capacity < 64) throw new TelegramOriginHoldError('origin-display-too-long');
    const chunks: string[] = []; let chunk = '';
    for (const scalar of original.text) {
      if (chunk.length + scalar.length > capacity) { chunks.push(chunk); chunk = ''; }
      chunk += scalar;
    }
    if (chunk) chunks.push(chunk);
    if (!chunks.length || chunks.length > 100 || (original.messageId !== undefined && chunks.length !== 1)) {
      throw new TelegramOriginHoldError('unsupported-browser-message-length');
    }
    const method = original.messageId === undefined ? 'messages.sendMessage' : 'messages.editMessage';
    const contentDigest = originDigest({ method, destination, text: original.text });
    const deadlineMs = stamp * 1000 + 780_000;
    const children = chunks.map(body => {
      const message = this.options.signBody(body + (footer ? `\n\n${footer}` : ''), topicId, stamp);
      if (message.length > 4096) throw new TelegramOriginHoldError('browser-signature-capacity');
      let randomId = randomBytes(8).readBigInt64BE().toString();
      if (randomId === '0') randomId = '1';
      const args: SealedBrowserRequest['args'] = { peer: original.peer, message,
        ...(original.messageId === undefined ? { random_id: randomId,
          ...(original.destination.topicId === undefined ? {} : { reply_to: {
            _: 'inputReplyToMessage', reply_to_msg_id: topicId, top_msg_id: topicId } }) } : { id: original.messageId }) };
      const request: SealedBrowserRequest = { method, args, digest: browserOperationDigest(method, args),
        accountId: this.options.accountId, destination: original.destination, deadlineMs,
        expectedAgentId: producer.agentId, expectedAspTopicId: topicId };
      return { childId: randomUUID(), materializationId: randomUUID(), request, requestDigest: wireDigest(canonicalOrigin(request)) };
    });
    children[0].request.policy = service.currentSendPolicyInput(original.text);
    children[0].requestDigest = wireDigest(canonicalOrigin(children[0].request));
    const unsigned = { ...producer, schemaVersion: 'instar-telegram-origin-v1' as const,
      executionOwnerMachineId: service.options.identity.originMachineId,
      originId, operationId, deliveryId: operationId, createdAt: now, operationKind: method,
      destination, contentDigest, planDigest: originDigest(children), display };
    const record: TelegramOriginRecord = { ...unsigned, attestation: attestOrigin(unsigned, service.options.signingKey, now) };
    const envelopeJson = canonicalOrigin(record);
    const operation: OriginPreparedBotOperation = { record, admission: { record: { originId, machineId: producer.originMachineId, createdAt: now,
      envelopeJson, envelopeDigest: wireDigest(envelopeJson), harnessId: producer.harnessId ?? 'automation', evidenceStatus: producer.model.status },
      operationId, preparedAt: now, deadlineAt: now + 6 * 60 * 60_000, maxAttempts: 9,
      payloadBytes: children.reduce((n, child) => n + Buffer.byteLength(canonicalOrigin(child.request)) + 1024, 0),
      children: children.map(child => ({ childId: child.childId, deliveryId: child.childId,
        allowedDerivations: ['signature-renewal'],
        destinationJson: canonicalOrigin(destination), canonicalContentDigest: contentDigest,
        materializations: [{ materializationId: child.materializationId, requestJson: canonicalOrigin(child.request),
          requestDigest: child.requestDigest, dispatchDeadline: deadlineMs }] })) } };
    sealOriginAdmission(operation, service.options.signingKey, now);
    return operation;
  }
  async send(input: OriginBrowserInput): Promise<{ originId: string; receipts: BrowserReceipt[] }> {
    const operation = this.prepare(input);
    await this.options.service.bindRevision(operation);
    await this.options.service.admit(operation);
    return this.execute(operation);
  }
  async execute(input: OriginPreparedBotOperation): Promise<{ originId: string; receipts: BrowserReceipt[] }> {
    const operation = structuredClone(input), store = this.options.store();
    if (operation.record.executionOwnerMachineId !== this.options.service.options.identity.originMachineId) {
      throw new TelegramOriginHoldError('execution-owner-mismatch', operation.record.operationId);
    }
    const planned = operation.admission.children.map(child => ({ childId: child.childId,
      materializationId: child.materializations[0]?.materializationId,
      request: parseOriginJson(child.materializations[0]?.requestJson ?? 'null'), requestDigest: child.materializations[0]?.requestDigest }));
    const stored = await store.getOrigin(operation.record.originId);
    if (originDigest(planned) !== operation.record.planDigest || stored?.record.envelopeJson !== canonicalOrigin(operation.record) ||
      stored.operation?.operationId !== operation.record.operationId || operation.record.destination.accountId !== this.options.accountId) {
      throw new TelegramOriginHoldError('sealed-browser-plan-mismatch', operation.record.operationId);
    }
    if (stored.children.some(child => child.state !== 'accepted')) {
      await this.options.service.reviewPreparedSendPolicy(operation);
      await this.options.service.reservePreparedContent(operation);
    }
    const receipts: BrowserReceipt[] = [];
    for (const child of operation.admission.children) {
      const accepted = stored.attempts.find(a => a.childId === child.childId && a.outcome === 'accepted');
      if (accepted?.receiptJson) { receipts.push(JSON.parse(accepted.receiptJson)); continue; }
      const materialization = await materializeBrowserSignature({ store, operation, child,
        resolveAgentPublicKey: this.options.resolveAgentPublicKey, signBody: this.options.signBody,
        now: this.options.now?.() ?? Date.now() });
      const request = parseOriginJson(materialization.requestJson) as unknown as SealedBrowserRequest;
      if (wireDigest(materialization.requestJson) !== materialization.requestDigest ||
        !await this.options.authorize(operation.record.destination)) throw new TelegramOriginHoldError('browser-not-authorized', operation.record.operationId);
      await this.options.service.authorizeOriginDispatch(operation.record);
      this.options.service.authorizeSendPolicyDispatch(operation.record);
      const claim = await store.claim({ childId: child.childId, materializationId: materialization.materializationId,
        ownerBootId: this.options.service.options.ownerBootId, leaseMs: 60_000 });
      if (claim.status !== 'claimed') throw new TelegramOriginHoldError(`outbox-${claim.reason}`, operation.record.operationId);
      if (claim.child.materialization.requestJson !== materialization.requestJson) throw new TelegramOriginHoldError('sealed-browser-request-mismatch', operation.record.operationId);
      this.claims.set(child.childId, { claim: claim.child, request, destination: operation.record.destination, record: operation.record });
      try {
        const outcome = await this.broker.executePreparedChild({ ...request, childId: child.childId,
          originId: operation.record.originId, claimFence: claim.child.claimToken });
        let saved;
        try {
          saved = await store.recordOutcome({ ...claim.child, outcome: outcome.state,
            ...(outcome.state === 'accepted' ? { receiptJson: canonicalOrigin(outcome.receipt) } : { reason: outcome.reason }),
            ...(outcome.state === 'known-failed' && ['unsupported-browser-build', 'browser-account-mismatch',
              'browser-transport-failed', 'browser-recovery-cooldown'].includes(outcome.reason) ? {
                nextAttemptAt: nextOriginKnownFailure({ attempt: claim.child.attemptNumber,
                  maxAttempts: operation.admission.maxAttempts, deadlineAt: operation.admission.deadlineAt,
                  now: this.options.now?.() ?? Date.now(), minimumDelayMs: 15 * 60_000 }),
              } : {}) });
        } catch {
          this.options.service.requestDiagnosis(operation.record.originId, 'browser-receipt-persistence-unavailable');
          throw new TelegramOriginHoldError('browser-outcome-unrecorded', operation.record.operationId, 'outcome-unknown');
        }
        if (!saved.recorded) throw new TelegramOriginHoldError('browser-outcome-unrecorded', operation.record.operationId, 'outcome-unknown');
        if (outcome.state !== 'accepted') {
          if (outcome.state === 'outcome-unknown') this.options.service.requestDiagnosis(operation.record.originId, outcome.reason);
          throw new TelegramOriginHoldError(outcome.reason, operation.record.operationId, outcome.state);
        }
        receipts.push(outcome.receipt);
      } finally { this.claims.delete(child.childId); }
    }
    await this.options.service.completePreparedContent(operation);
    return { originId: operation.record.originId, receipts };
  }
  close(): Promise<void> { return this.broker.close(); }
}
