import { sealOriginAdmission } from './OriginAdmissionSeal.js';
import { randomUUID } from 'node:crypto';
import { canonicalOrigin, originDigest, wireDigest } from './CanonicalOrigin.js';
import { attestOrigin } from './OriginAttestation.js';
import { planBotOrigin } from './OriginBotPlanner.js';
import { resolveOriginDisplay } from './OriginPresentation.js';
import { RECORDING_OUTAGE_TEXT } from './TelegramOriginOutageNotifier.js';
import type { ReservedNoticePreparation } from './TelegramOriginOutageNotifier.js';
import type { TelegramOriginService } from './TelegramOriginService.js';

/** Internal boot preparation. The only text admitted here is the fixed notice;
 * the public outage trigger never accepts text or a serialized request.
 */
export function prepareOriginOutageNotice(service: TelegramOriginService,
  destination: { accountId: string; chatId: string; topicId: string | null }): ReservedNoticePreparation {
  return service.runAsAutomation('telegram-server', () => {
    const producer = service.currentProducer();
    const params = { chat_id: destination.chatId, text: RECORDING_OUTAGE_TEXT,
      ...(destination.topicId === null ? {} : { message_thread_id: destination.topicId }) };
    const plans = Array.from({ length: 8 }, (_, bits) => planBotOrigin({
      method: 'sendMessage', accountId: destination.accountId, params, producer,
      display: resolveOriginDisplay({ enabled: bits !== 0, machine: Boolean(bits & 4), harness: Boolean(bits & 2), model: Boolean(bits & 1) }),
    }));
    const operation = service.prepareBot({ method: 'sendMessage', accountId: destination.accountId, params });
    const variants = plans.map(plan => plan.children[0].request);
    const materializations = variants.map(request => ({ materializationId: randomUUID(),
      requestJson: canonicalOrigin(request), requestDigest: wireDigest(canonicalOrigin(request)) }));
    const { attestation: _, ...unsigned } = operation.record;
    // All allowed cosmetic variants, and their immutable IDs, are signed once.
    unsigned.planDigest = originDigest(materializations);
    operation.record = { ...unsigned, attestation: attestOrigin(unsigned, service.options.signingKey, unsigned.createdAt) };
    const envelopeJson = canonicalOrigin(operation.record);
    operation.admission.record = { ...operation.admission.record, envelopeJson, envelopeDigest: wireDigest(envelopeJson) };
    operation.admission.children[0].materializations = materializations;
    operation.admission.payloadBytes = materializations.reduce((n, m) => n + Buffer.byteLength(m.requestJson), 0);
    sealOriginAdmission(operation, service.options.signingKey, unsigned.createdAt);
    return { admission: operation.admission, variants };
  });
}
