import { applyTelegramFormatter } from '../TelegramAdapter.js';
import type { FormatMode } from '../TelegramMarkdownFormatter.js';
import type { BotParameters } from './types.js';
import { TelegramOriginHoldError } from './types.js';
import { ORIGIN_MESH_PROTOCOL } from './OriginMesh.js';
import type { OriginMeshCommand } from './OriginMesh.js';
import type { TelegramOriginRuntime } from './TelegramOriginRuntime.js';
import type { OriginPreparedBotOperation } from './TelegramOriginService.js';
import { submitOriginToHolder } from './OriginForwardToHolder.js';
import { OriginSendPolicyRefusal } from './OriginSendPolicy.js';

export async function relayOriginBot(input: {
  runtime: TelegramOriginRuntime; topicId: number; chatId: string; text: string; silent?: boolean;
  formatMode?: FormatMode;
  kindMetadata?: Record<string, unknown>;
  send: (command: OriginMeshCommand) => Promise<{ ok: boolean; result?: unknown }>;
  /** §4.1 — pin the execution owner to a resolved holder (defaults to whatever answers `capabilities`). */
  executionOwnerMachineId?: string;
  /** Reuse an operation id across holders (the holder dedupes on it). */
  operationId?: string;
  onPrepared?: (operation: OriginPreparedBotOperation) => void;
}): Promise<{ messageId: number; topicId: number; destinationStoreConfirmed: true; operationId: string }> {
  const base = { type: 'telegram-origin', protocol: ORIGIN_MESH_PROTOCOL } as const;
  let capabilities;
  try { capabilities = await input.send({ ...base, action: 'capabilities' }); }
  catch { throw new TelegramOriginHoldError('origin-peer-unreachable'); }
  const cap = capabilities.result as { ok?: boolean; protocol?: string; credentialOwner?: boolean; accountId?: string; executionOwnerMachineId?: string } | undefined;
  if (!capabilities.ok || !cap?.ok || cap.protocol !== ORIGIN_MESH_PROTOCOL || !cap.credentialOwner || typeof cap.accountId !== 'string' ||
    typeof cap.executionOwnerMachineId !== 'string' || !cap.executionOwnerMachineId || cap.executionOwnerMachineId.length > 128) {
    throw new TelegramOriginHoldError('origin-peer-protocol-unavailable');
  }
  const params = applyTelegramFormatter('sendMessage', { chat_id: input.chatId, text: input.text, parse_mode: 'Markdown',
    ...(input.topicId > 1 ? { message_thread_id: input.topicId } : {}), ...(input.silent ? { disable_notification: true } : {}) }, input.formatMode).outgoingParams as BotParameters;
  const service = input.runtime.service;
  if (input.executionOwnerMachineId !== undefined && cap.executionOwnerMachineId !== input.executionOwnerMachineId) {
    throw new TelegramOriginHoldError('execution-owner-mismatch');
  }
  const prepare = () => service.prepareBot({ method: 'sendMessage', accountId: cap.accountId!, params,
    executionOwnerMachineId: cap.executionOwnerMachineId, ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    policyInput: service.currentSendPolicyInput(input.text, input.kindMetadata) });
  const operation = service.hasProducerContext() ? prepare() : service.runAsUnboundAutomation('telegram-server', prepare);
  if (service.hasLogicalSendContext()) {
    if (!service.options.store.getOperation) throw new TelegramOriginHoldError('logical-send-index-unavailable', operation.record.operationId);
    const existing = await service.options.store.getOperation(operation.record.operationId);
    if (existing) {
      const original = JSON.parse(existing.record.envelopeJson) as typeof operation.record;
      if (original.originMachineId !== operation.record.originMachineId || original.agentId !== operation.record.agentId ||
        original.producerId !== operation.record.producerId || original.contentDigest !== operation.record.contentDigest) {
        throw new TelegramOriginHoldError('logical-send-content-conflict');
      }
      throw new TelegramOriginHoldError('original-relay-operation-unresolved', operation.record.operationId);
    }
  }
  service.authorizeSendPolicyDispatch(operation.record);
  await service.recordIntent(operation);
  service.authorizeSendPolicyDispatch(operation.record);
  input.onPrepared?.(operation);
  // One holder transport for the request-time relay and the §4.2 recovery
  // re-forward (OriginForwardToHolder.ts), so a refusal means one thing.
  const submitted = await submitOriginToHolder({ operation, send: input.send, expectedOwner: cap.executionOwnerMachineId });
  if (!submitted.ok) {
    if (submitted.policyRefusal) throw new OriginSendPolicyRefusal(submitted.policyRefusal, operation.record.operationId);
    throw new TelegramOriginHoldError(submitted.reason, operation.record.operationId, submitted.outcome);
  }
  const response = { messageId: submitted.messageId };
  // The credential owner's origin outbox has committed a correlated receipt.
  return { messageId: response.messageId, topicId: input.topicId, destinationStoreConfirmed: true, operationId: operation.record.operationId };
}
