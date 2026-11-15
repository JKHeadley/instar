import type { TelegramOriginService } from './TelegramOriginService.js';
import type { OriginAutomationAuthor } from './OriginAutomationAuthor.js';

/** Internal automation uses the ordinary reply pipeline, with an origin grant
 * bound to this exact request. Metadata supplied over HTTP grants no identity. */
export async function postOriginAutomationReply(input: {
  service?: TelegramOriginService; port: number; authToken: string;
  producerId: string; topicId: number; body: Record<string, unknown>; author?: OriginAutomationAuthor; logicalSendId?: string;
  /** Extra request headers (e.g. `X-Instar-System` for a reviewed system template) and an abort signal. */
  headers?: Record<string, string>; signal?: AbortSignal;
}): Promise<Response> {
  const headers: Record<string, string> = { ...(input.headers ?? {}), 'Content-Type': 'application/json', Authorization: `Bearer ${input.authToken}` };
  if (input.service) {
    input.service.registerAutomationProducer(input.producerId);
    headers['X-Instar-Origin-Automation'] = input.service.issueAutomationReply(input.producerId, input.topicId, input.body, input.author, input.logicalSendId);
  }
  return fetch(`http://localhost:${input.port}/telegram/reply/${input.topicId}`, {
    method: 'POST', headers, body: JSON.stringify(input.body), redirect: 'error', ...(input.signal ? { signal: input.signal } : {}),
  });
}
