import { categoryForProducer } from '../notificationCategories.js';
import { notificationContext } from '../NotificationSelectivityGate.js';
import { notificationStamper, withNotificationEnvelope } from '../notificationStampers.js';
const stampNotification = notificationStamper('src/messaging/telegram-origin/OriginDeterministicSend.ts');
import type { TelegramOriginService } from './TelegramOriginService.js';
import { originBotEgressStatus } from './OriginBotEgress.js';
import { TelegramOriginHoldError } from './types.js';

/** Internal composition only; neither request metadata nor message text can
 * enroll a transport or assert a deterministic author. */
export type DeterministicOriginProducer = 'auto-updater' | 'session-monitor' | 'session-lifecycle' |
  'cold-start-fallback' | 'respawn-collision' | 'owner-dark-ladder' |
  'telegram-lifeline' | 'topic-profile-creation-seed' | 'never-silent' | 'telegram-inbound-status';
const transports = new WeakMap<object, TelegramOriginService>();
export function bindOriginAutomationTransport(transport: object, service: TelegramOriginService): void {
  transports.set(transport, service);
}
export async function withDeterministicOrigin<T>(service: TelegramOriginService | undefined,
  producerId: DeterministicOriginProducer, send: () => Promise<T>): Promise<T> {
  if (!service) {
    if (originBotEgressStatus().active) throw new TelegramOriginHoldError('deterministic-producer-transport-unbound');
    return send();
  }
  service.registerAutomationProducer(producerId);
  return service.runAsAutomation(producerId, send);
}
export function sendDeterministicTelegramNotice<T>(transport: { sendToTopic(topicId: number, text: string): Promise<T> },
  producerId: DeterministicOriginProducer, topicId: number, text: string): Promise<T> {
  const inbound = notificationContext.getStore();
  const floorCategory = producerId === 'cold-start-fallback' ? 'cold-start-fallback' as const
    : producerId === 'session-monitor' && (inbound?.category === 'message-loss-notice' || inbound?.category === 'presence-standby') ? inbound.category : undefined;
  const envelope = floorCategory && inbound?.inboundMessageId
    ? { origin: 'automated' as const, category: floorCategory, sourceContext: producerId, inboundMessageId: inbound.inboundMessageId }
    : { origin: 'automated' as const, category: categoryForProducer(producerId), sourceContext: producerId };
  return withDeterministicOrigin(transports.get(transport), producerId, () => withNotificationEnvelope(envelope, async () => transport.sendToTopic(topicId, text)));
}
/**
 * Never-Silent Conversation notice (docs/specs/never-silent-conversation.md §3.4): Instar's own
 * deterministic voice, naming the waiting inbound message so the selectivity gate's
 * `never-silent-floor` always delivers it. Optional one row of buttons (the one-tap ask).
 */
export function sendNeverSilentTelegramNotice<T>(
  transport: { sendToTopic(topicId: number, text: string, options?: { inlineButtons?: Array<{ text: string; data: string }>; provenance?: 'automation' }): Promise<T> },
  topicId: number, text: string, inboundMessageId: string, buttons?: Array<{ text: string; data: string }>,
): Promise<T> {
  const envelope = { origin: 'automated' as const, category: categoryForProducer('never-silent'), sourceContext: 'never-silent', inboundMessageId };
  return withDeterministicOrigin(transports.get(transport), 'never-silent', () => withNotificationEnvelope(envelope,
    async () => transport.sendToTopic(topicId, text, { provenance: 'automation', ...(buttons?.length ? { inlineButtons: buttons } : {}) })));
}

/** An exact Telegram custody event is system status, never a substantive reply. */
export function sendTelegramInboundStatusNotice<T>(
  transport: { sendToTopic(topicId: number, text: string, options?: { skipStallClear?: boolean; provenance?: 'automation' }): Promise<T> },
  topicId: number, text: string, inboundMessageId: string,
): Promise<T> {
  const producer = 'telegram-inbound-status';
  const envelope = { origin: 'automated' as const, category: categoryForProducer(producer),
    sourceContext: producer, inboundMessageId };
  return withDeterministicOrigin(transports.get(transport), producer, () => withNotificationEnvelope(envelope,
    async () => transport.sendToTopic(topicId, text, { skipStallClear: true, provenance: 'automation' })));
}

/** These producers include copied prose without a native author observation. */
export async function withUnknownProducerOrigin<T>(service: TelegramOriginService | undefined,
  producerId: 'auto-dispatcher' | 'growth-digest' | 'reap-notice-drain', send: () => Promise<T>): Promise<T> {
  if (!service) {
    if (originBotEgressStatus().active) throw new TelegramOriginHoldError('automation-producer-transport-unbound');
    return send();
  }
  service.registerAutomationProducer(producerId);
  return service.runAsUnboundAutomation(producerId, send);
}
export function sendUnknownProducerTelegramNotice<T>(transport: { sendToTopic(topicId: number, text: string): Promise<T> },
  producerId: 'auto-dispatcher', topicId: number, text: string): Promise<T> {
  return withUnknownProducerOrigin(transports.get(transport), producerId, () => withNotificationEnvelope(stampNotification(), async () => (transport)!.sendToTopic(topicId, text)));
}

export function bindUnknownProducerTelegramSender<T>(service: TelegramOriginService | undefined,
  producerId: 'reap-notice-drain', send: (topicId: number, text: string) => Promise<T>) {
  return (topicId: number, text: string): Promise<T> => withUnknownProducerOrigin(service, producerId, () => send(topicId, text));
}
