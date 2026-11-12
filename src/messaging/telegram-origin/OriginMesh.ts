import { QuietRecordedError } from '../NotificationSelectivityGate.js';
import { validOriginAdmission } from './OriginAdmissionSeal.js';
import { canonicalOrigin, wireDigest } from './CanonicalOrigin.js';
import { verifyOriginAttestation } from './OriginAttestation.js';
import type { OriginVerificationKey } from './OriginAttestation.js';
import type { TelegramOriginRuntime } from './TelegramOriginRuntime.js';
import type { OriginPreparedBotOperation } from './TelegramOriginService.js';
import type { StoredOriginInput, OriginListQuery } from './StoreTypes.js';
import { TelegramOriginHoldError } from './types.js';
import { classifyOperationOutcome, unrecordedAcceptanceCovers } from './OriginOperationOutcome.js';
import type { TelegramOriginRecord } from './types.js';
import { telegramFetch } from '../telegram-egress.js';
import { verify as verifySignature } from 'node:crypto';
import { verifyPoolLinkAssertion, type PoolLinkAssertion } from '../../core/PoolLinkAssertion.js';
import { OriginSendPolicyRefusal } from './OriginSendPolicy.js';
import { originAuditDeliveryConfirmed } from './OriginDeliveryResolution.js';
import { sanitizeForwardContext } from './TokenlessForwardEvidence.js';
import type { HolderEvidenceRecorder } from './TokenlessForwardEvidence.js';
import { sanitizeHoldNotice, sanitizeOutcomes } from './TokenlessHeldDebt.js';
import type { PeerHeldDebtStore } from './TokenlessHeldDebt.js';

export const ORIGIN_MESH_PROTOCOL = 'instar-telegram-origin-v1';
export type OriginMeshCommand = { type: 'telegram-origin'; protocol: typeof ORIGIN_MESH_PROTOCOL } & (
  { action: 'capabilities'; forwardContext?: unknown } | { action: 'receipt'; operationId: string } | { action: 'evidence'; record: StoredOriginInput; tokenlessHold?: unknown } |
  { action: 'submit'; operation: OriginPreparedBotOperation; forwardContext?: unknown } | { action: 'audit'; query: OriginListQuery; operatorAssertion?: PoolLinkAssertion }
  | { action: 'metrics'; operatorAssertion?: PoolLinkAssertion });
export const ORIGIN_METRICS_AUDIENCE = 'telegram-origin-metrics:v1';

export function originAuditAudience(query: OriginListQuery): string {
  return `telegram-origin-audit:${wireDigest(canonicalOrigin(Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined))))}`;
}

/** Called only AFTER the recipient-bound mesh envelope and replay nonce pass.
 * Neither body-supplied session metadata nor the fleet bearer token is a peer
 * identity. The same-agent machine attestation is checked independently here.
 */
export async function handleOriginMesh(options: {
  runtime: TelegramOriginRuntime;
  command: OriginMeshCommand;
  authenticatedSender: string;
  resolveKey: (machineId: string) => OriginVerificationKey | null;
  /** standby-durable-forward-without-token §10: records a token-less standby's evidence (signal only). */
  evidence?: HolderEvidenceRecorder;
  /** §9: open debt entries for another machine's token-less holds (metadata only). */
  heldDebt?: PeerHeldDebtStore;
}): Promise<unknown> {
  const { runtime, command } = options;
  // A command-level `forwardContext` never changes how the command is handled.
  const forwardContext = (command.action === 'capabilities' || command.action === 'submit') ? sanitizeForwardContext(command.forwardContext) : null;
  const observe = (delivered?: { operationId: string }): string[] => {
    if (!forwardContext || !options.evidence) return [];
    try { return options.evidence.observe(options.authenticatedSender, forwardContext, delivered); } catch { return []; } // @silent-fallback-ok — evidence is a signal; an unwritable log only delays the ack, never the command
  };
  if (command.protocol !== ORIGIN_MESH_PROTOCOL) return { ok: false, reason: 'origin-protocol-unsupported' };
  if (!options.resolveKey(options.authenticatedSender)) return { ok: false, reason: 'origin-peer-unavailable' };
  if (command.action === 'receipt') {
    const activeKey = () => {
      const key = options.resolveKey(options.authenticatedSender), now = Date.now();
      return key && key.machineId === options.authenticatedSender && key.agentId === runtime.options.identity.agentId &&
        (key.validFrom === null || key.validFrom <= now) && (key.validUntil === null || key.validUntil > now) &&
        (key.revokedAt === null || key.revokedAt > now) ? key : null;
    };
    const authorized = activeKey();
    if (!authorized) return { ok: false, reason: 'origin-peer-unavailable' };
    if (typeof command.operationId !== 'string' || !command.operationId || command.operationId.length > 256) return { ok: false, reason: 'origin-receipt-unavailable' };
    try {
      const audit = await runtime.store.getOperation(command.operationId);
      const live = activeKey();
      if (!live || live.publicKey !== authorized.publicKey || live.keyEpoch !== authorized.keyEpoch) return { ok: false, reason: 'origin-peer-unavailable' };
      // A verified peer asking about an id this machine never saw gets a
      // DISTINCT answer from a store failure: `no-record` is a definite
      // non-admission (a forwarding standby may re-forward); `origin-receipt-
      // unavailable` is an unknown (it must keep waiting).
      if (!audit) return { ok: true, operationId: command.operationId, state: 'no-record', originReceiptConfirmed: false,
        executionOwnerMachineId: runtime.options.identity.originMachineId };
      const record = JSON.parse(audit.record.envelopeJson) as TelegramOriginRecord;
      if (record.originMachineId !== options.authenticatedSender || record.agentId !== runtime.options.identity.agentId ||
        record.operationId !== command.operationId || record.originId !== audit.record.originId ||
        record.executionOwnerMachineId !== runtime.options.identity.originMachineId || wireDigest(audit.record.envelopeJson) !== audit.record.envelopeDigest) {
        return { ok: false, reason: 'origin-receipt-unavailable' };
      }
      const fallback = !originAuditDeliveryConfirmed(audit) && unrecordedAcceptanceCovers(runtime, audit);
      const verdict = classifyOperationOutcome(command.operationId, audit, runtime.unrecordedReceipts?.forOperation(command.operationId) ?? []);
      return { ok: true, operationId: command.operationId, originId: record.originId, envelopeDigest: audit.record.envelopeDigest,
        executionOwnerMachineId: runtime.options.identity.originMachineId, state: fallback ? 'accepted' : audit.operation?.state ?? 'not-admitted',
        originReceiptConfirmed: (fallback || originAuditDeliveryConfirmed(audit)) && verdict.outcome === 'delivered',
        messageIds: verdict.messageIds };
    } catch { return { ok: false, reason: 'origin-receipt-unavailable' }; }
  }
  if (command.action === 'capabilities') {
    const evidenceAck = observe();
    // §9: the origin machine reports how its holds ended; only it can close its entries.
    let outcomesAck: string[] = [];
    const outcomes = sanitizeOutcomes((command.forwardContext as { outcomes?: unknown } | undefined)?.outcomes);
    if (outcomes.length && options.heldDebt) { try { options.heldDebt.close(options.authenticatedSender, outcomes); outcomesAck = outcomes.map(o => o.rootOperationId); } catch { /* @silent-fallback-ok — unacked outcomes are resent */ } }
    return { ok: true, protocol: ORIGIN_MESH_PROTOCOL,
      executionOwnerMachineId: runtime.options.identity.originMachineId,
      credentialOwner: !!runtime.options.bot.token, accountId: runtime.options.bot.token ? runtime.options.bot.accountId : null,
      ...(evidenceAck.length ? { evidenceAck } : {}), ...(outcomesAck.length ? { outcomesAck } : {}) };
  }
  if (command.action === 'audit' || command.action === 'metrics') {
    const assertion = command.operatorAssertion;
    if (!assertion || assertion.userAuth !== 'pin-session') return { ok: false, reason: 'operator-audit-scope-required' };
    const authorizedKey = options.resolveKey(options.authenticatedSender);
    const verified = verifyPoolLinkAssertion(assertion, { viewId: command.action === 'audit' ? originAuditAudience(command.query) : ORIGIN_METRICS_AUDIENCE, method: 'GET' }, {
      selfFingerprint: runtime.options.identity.originMachineId, expectedIssuer: options.authenticatedSender,
      resolveIssuerPublicKeyPem: machine => {
        const key = options.resolveKey(machine), now = Date.now();
        return !key || (key.validFrom !== null && key.validFrom > now) || (key.validUntil !== null && key.validUntil <= now) ||
          (key.revokedAt !== null && key.revokedAt <= now) ? null : key.publicKey;
      },
      verify: (canonical, signature, key) => verifySignature(null, Buffer.from(canonical), key, Buffer.from(signature, 'base64')),
      seenJti: () => false, now: Date.now, maxTtlMs: 10_000,
    });
    if (!verified.ok || !await runtime.store.consumeAuditAssertion({ jti: assertion.jti, expiresAt: assertion.exp })) {
      return { ok: false, reason: 'operator-audit-assertion-invalid' };
    }
    const liveKey = options.resolveKey(options.authenticatedSender);
    const now = Date.now();
    if (!liveKey || liveKey.publicKey !== authorizedKey?.publicKey || (liveKey.validFrom !== null && liveKey.validFrom > now) ||
      liveKey.validUntil !== null && liveKey.validUntil <= now || liveKey.revokedAt !== null && liveKey.revokedAt <= now ||
      assertion.exp <= now) return { ok: false, reason: 'origin-peer-unavailable' };
    return command.action === 'audit' ? { ok: true, page: await runtime.store.listOrigins(command.query) }
      : { ok: true, metrics: await runtime.store.getFederatedMetrics(runtime.options.identity.originMachineId) };
  }
  const stored = command.action === 'evidence' ? command.record : command.action === 'submit' ? command.operation?.admission?.record : null;
  if (!stored || typeof stored.envelopeJson !== 'string' || Buffer.byteLength(stored.envelopeJson) > 128 * 1024 ||
    wireDigest(stored.envelopeJson) !== stored.envelopeDigest) return { ok: false, reason: 'origin-envelope-invalid' };
  let record: TelegramOriginRecord;
  try { record = JSON.parse(stored.envelopeJson); }
  catch { return { ok: false, reason: 'origin-envelope-invalid' }; }
  const key = options.resolveKey(options.authenticatedSender);
  if (!key) return { ok: false, reason: 'origin-peer-unavailable' };
  if (record.schemaVersion !== ORIGIN_MESH_PROTOCOL || record.originId !== stored.originId ||
    record.originMachineId !== stored.machineId || record.agentId !== runtime.options.identity.agentId ||
    canonicalOrigin(record) !== stored.envelopeJson) return { ok: false, reason: 'origin-envelope-invalid' };
  const verified = verifyOriginAttestation(record, key, { machineId: options.authenticatedSender, agentId: runtime.options.identity.agentId });
  if (!verified.valid) return { ok: false, reason: verified.reason };
  const verification = { envelopeDigest: stored.envelopeDigest, verifierMachineId: runtime.options.identity.originMachineId,
    keyId: key.keyId, keyEpoch: key.keyEpoch, keyFingerprint: wireDigest(key.publicKey), verifiedAt: verified.verifiedAt,
    keyStatusAtAcceptance: 'active' as const };
  if (command.action === 'evidence') {
    const receipt = await runtime.store.putVerifiedEvidence({ record: stored, verification });
    const notice = sanitizeHoldNotice(command.tokenlessHold);
    if (notice && options.heldDebt && stored.machineId === options.authenticatedSender) {
      try { options.heldDebt.add(options.authenticatedSender, notice); } catch { /* @silent-fallback-ok — the debt note is best effort; the evidence receipt stands */ }
    }
    return { ok: true, receipt };
  }
  if (command.action !== 'submit' || !runtime.options.bot.token) return { ok: false, reason: 'origin-credential-owner-required' };
  if (record.executionOwnerMachineId !== runtime.options.identity.originMachineId) {
    return { ok: false, reason: 'execution-owner-mismatch', outcome: 'held' };
  }
  // a2a-single-agent-identity §4.1 — the holder-side submit runs the SAME lease
  // check the direct path runs (it used to execute unchecked). A typed,
  // retryable refusal lets the forwarding standby re-resolve the holder.
  if (runtime.options.holdsLease && !runtime.options.holdsLease()) {
    // No `operationId` here on purpose: a refusal naming the operation id means
    // this machine took custody of it; this one never did.
    return { ok: false, reason: 'not-lease-holder', outcome: 'held', retryable: true,
      executionOwnerMachineId: runtime.options.identity.originMachineId };
  }
  const operation = command.operation;
  if (!validOriginAdmission(operation) || canonicalOrigin(operation.record) !== stored.envelopeJson || operation.admission.operationId !== record.operationId ||
    record.destination.transport !== 'bot-api' || record.destination.accountId !== runtime.options.bot.accountId) {
    return { ok: false, reason: 'origin-plan-invalid' };
  }
  try {
    await runtime.store.putVerifiedEvidence({ record: stored, verification });
    const response = await runtime.service.runFirstSend(record.operationId, async () => {
      await runtime.service.admit(operation);
      const request = JSON.parse(operation.admission.children[0].materializations[0].requestJson);
      return telegramFetch(`https://api.telegram.org/bot${runtime.options.bot.token}/${request.method}`,
        { method: 'POST', headers: { 'Content-Type': request.contentType }, body: request.body,
          networkTimeoutMs: 10_000 }, undefined, operation);
    });
    const body = await response.json() as { result?: { message_id?: number } };
    const evidenceAck = observe({ operationId: record.operationId });
    return { ok: true, originId: record.originId, messageId: body.result?.message_id, originReceiptConfirmed: true,
      deliveryMachineId: runtime.options.identity.originMachineId, forwardedFromMachine: record.originMachineId,
      ...(evidenceAck.length ? { evidenceAck } : {}) };
  } catch (error) {
    if (error instanceof QuietRecordedError) return { ok: true, originId: record.originId, ...error.receipt, deliveryMachineId: runtime.options.identity.originMachineId };
    if (error instanceof OriginSendPolicyRefusal) return { ok: false, reason: error.reason, outcome: 'held',
      operationId: record.operationId, policyRefusal: error.decision };
    // Telegram accepted it; only the receipt write failed. Answering a refusal
    // here would let the forwarding standby re-forward a delivered message.
    if (error instanceof TelegramOriginHoldError && error.outcome === 'accepted-unrecorded' && error.delivered?.messageId && /^\d+$/.test(error.delivered.messageId)) {
      return { ok: true, originId: record.originId, messageId: Number(error.delivered.messageId), originReceiptConfirmed: true,
        deliveryMachineId: runtime.options.identity.originMachineId, forwardedFromMachine: record.originMachineId, receiptRecorded: false };
    }
    if (error instanceof TelegramOriginHoldError) return { ok: false, reason: error.reason, outcome: error.outcome, operationId: error.operationId };
    // After admission a worker failure can mean a dispatched request; an RPC
    // error must never invite a new logical submission with replacement IDs.
    return { ok: false, reason: 'origin-relay-state-unavailable', outcome: 'outcome-unknown', operationId: record.operationId };
  }
}
