import type { TelegramOriginService } from '../messaging/telegram-origin/TelegramOriginService.js';
import type { OriginAutomationAuthor } from '../messaging/telegram-origin/OriginAutomationAuthor.js';
import { unknownAutomationAuthor } from '../messaging/telegram-origin/OriginAutomationAuthor.js';

/** Bind an internal author's evidence to this exact surface, not to the last
 * model call in the process or a validator which happened to inspect it. */
export function withThreadlineTelegramAuthor<T>(service: TelegramOriginService | undefined,
  producerId: 'a2a-checkin' | 'threadline-peer-relay' | 'threadline-outbound-relay', topicId: number, text: string,
  author: OriginAutomationAuthor, send: () => Promise<T>): Promise<T> {
  if (!service) return send();
  service.registerAutomationProducer(producerId);
  const body = { text };
  const token = service.issueAutomationReply(producerId, topicId, body, author);
  return service.runWithAutomationReply(token, topicId, body, send);
}

export function withThreadlineForwardedAuthor<T>(service: TelegramOriginService | undefined,
  direction: 'inbound' | 'outbound', topicId: number, text: string, send: () => Promise<T>): Promise<T> {
  // An outbound mirror can still be inside the submitting session's private
  // scope. Inbound peer prose must never inherit that local model attribution.
  if (direction === 'outbound' && service?.hasProducerContext()) return send();
  return withThreadlineTelegramAuthor(service, direction === 'inbound' ? 'threadline-peer-relay' : 'threadline-outbound-relay',
    topicId, text, unknownAutomationAuthor(direction === 'inbound' ? 'forwarded-peer-author-unavailable' : 'forwarded-source-author-unavailable'), send);
}
