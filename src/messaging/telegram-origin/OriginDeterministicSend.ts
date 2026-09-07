import type { TelegramOriginService } from './TelegramOriginService.js';
import { originBotEgressStatus } from './OriginBotEgress.js';
import { TelegramOriginHoldError } from './types.js';

/** Internal composition only; neither request metadata nor message text can
 * enroll a transport or assert a deterministic author. */
export type DeterministicOriginProducer = 'auto-updater' | 'session-monitor' | 'session-lifecycle' |
  'cold-start-fallback' | 'respawn-collision' | 'owner-dark-ladder' |
  'telegram-lifeline';
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
  return withDeterministicOrigin(transports.get(transport), producerId, () => transport.sendToTopic(topicId, text));
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
  return withUnknownProducerOrigin(transports.get(transport), producerId, () => transport.sendToTopic(topicId, text));
}

export function bindUnknownProducerTelegramSender<T>(service: TelegramOriginService | undefined,
  producerId: 'reap-notice-drain', send: (topicId: number, text: string) => Promise<T>) {
  return (topicId: number, text: string): Promise<T> => withUnknownProducerOrigin(service, producerId, () => send(topicId, text));
}
