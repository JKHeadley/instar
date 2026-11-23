// Governed by: Telegram Message Origin Is Mandatory; Its Display Is Optional
// (docs/STANDARDS-REGISTRY.md). Recording and presentation are independent.
import { createHash } from 'node:crypto';
import { TelegramOriginHoldError } from './types.js';
import type { BotParameters, SealedBotRequest } from './types.js';
import type { TelegramOriginService } from './TelegramOriginService.js';
import type { OriginPreparedBotOperation } from './TelegramOriginService.js';
import { assertOutgoingPayloadVisible, BODY_CARRYING_TELEGRAM_METHODS } from '../invisible-payload.js';
import { consumeReservedOriginNotice } from './TelegramOriginOutageNotifier.js';
import { botDestination } from './OriginBotPlanner.js';
import { captureOriginAttachments, renderOriginMultipart } from './OriginMultipart.js';
import { OriginCapacityUnavailable } from './OriginEgressCapacity.js';
import type { OriginBotTransport } from './TelegramOriginService.js';

const MESSAGE_METHODS = new Set(['sendMessage', 'editMessageText', 'editMessageCaption',
  'sendPhoto', 'sendVideo', 'sendAudio', 'sendDocument', 'sendAnimation', 'sendVoice', 'sendVideoNote',
  'sendSticker', 'sendMediaGroup', 'forwardMessage', 'forwardMessages', 'copyMessage', 'copyMessages', 'editMessageMedia']);
interface RegisteredBot { accountId: string; service: TelegramOriginService; producerId: string; }
const owners = new Map<string, RegisteredBot>();
let active = false;
// Only this closure knows whether it reached the network callback. Error names
// or codes supplied by that callback are not proof that a send never started.
const localRefusals = new WeakMap<Error, Readonly<SealedBotRequest>>();
export function consumeOriginLocalRefusal(error: unknown, request: Readonly<SealedBotRequest>): boolean {
  if (!(error instanceof Error) || localRefusals.get(error) !== request) return false;
  localRefusals.delete(error);
  return true;
}
/** Installing the runtime closes the legacy bypass even on tokenless peers or
 * during failed credential enrollment. Closing a runtime never reopens it. */
export function requirePreparedOriginEgress(): void { active = true; }
function credentialKey(url: string): string | null {
  const pathname = decodeURIComponent(new URL(url).pathname);
  const token = /^\/bot([^/]+)\//i.exec(pathname)?.[1];
  return token ? createHash('sha256').update(token).digest('hex') : null;
}
export function isOriginMessageMethod(method: string): boolean {
  return MESSAGE_METHODS.has(method) || (BODY_CARRYING_TELEGRAM_METHODS.has(method) && !['createForumTopic', 'editForumTopic'].includes(method));
}
/** Production startup registers every enabled credential owner before activating writers. */
export function registerOriginBot(token: string, accountId: string, service: TelegramOriginService,
  producerId = 'telegram-server'): () => void {
  if (!token || !accountId) throw new Error('origin-egress: credential owner required');
  const key = createHash('sha256').update(token).digest('hex');
  const existing = owners.get(key);
  if (existing && existing.service !== service) throw new Error('origin-egress: competing credential owner');
  service.registerAutomationProducer(producerId);
  const entry = { accountId, service, producerId }; owners.set(key, entry); active = true;
  return () => { if (owners.get(key) === entry) owners.delete(key); };
}
export function originBotEgressStatus(): { active: boolean; registeredOwners: number } {
  return { active, registeredOwners: owners.size };
}
/** Retain an adapter's pre-format text for its protected send input. Use exactly
 * the registered producer fallback the egress door would use; never replace a
 * route's existing policy or claim an author from the message text. */
export function withOriginBotAuthoredText<T>(token: string, text: unknown, send: () => T): T {
  if (typeof text !== 'string') return send();
  const owner = owners.get(createHash('sha256').update(token).digest('hex'));
  if (!owner) return send();
  const capture = () => owner.service.runWithSendPolicyFallback(text, send);
  return owner.service.hasProducerContext() ? capture()
    : owner.service.runAsUnboundAutomation(owner.producerId, capture);
}
/** Called after the original payload visibility check, before the only network boundary. */
export async function dispatchOriginBotEgress(input: {
  method: string; url: string; init: RequestInit; params: Record<string, unknown>; noticeCapability?: object;
  preparedOperation?: OriginPreparedBotOperation;
}, network: (url: string, init: RequestInit) => Promise<Response>): Promise<Response | null> {
  if (!isOriginMessageMethod(input.method)) return null;
  const key = credentialKey(input.url); const owner = key ? owners.get(key) : undefined;
  if (!owner) {
    if (active || input.noticeCapability || input.preparedOperation) throw new TelegramOriginHoldError('unregistered-credential-owner');
    return null; // Library consumers before production activation retain their previous contract.
  }
  const params = input.params as BotParameters;
  const attachments = typeof FormData !== 'undefined' && input.init.body instanceof FormData &&
    [...input.init.body.values()].some(value => typeof value !== 'string') ? await captureOriginAttachments(input.init.body) : undefined;
  const prepareWire = async (request: Readonly<SealedBotRequest>): Promise<() => Promise<Response>> => {
    if (request.accountId !== owner.accountId || !isOriginMessageMethod(request.method)) throw new TelegramOriginHoldError('credential-request-mismatch');
    const url = new URL(input.url);
    url.search = ''; url.hash = '';
    // Disallow parameters in the root method position: the sealed method is the only dispatch choice.
    url.pathname = url.pathname.replace(/\/[^/]*\/?$/, `/${request.method}`);
    assertOutgoingPayloadVisible(request.method, JSON.parse(request.body));
    let body: string | Uint8Array = request.body, contentType: string = request.contentType;
    if (request.multipart) {
      const payloads = new Map<string, Uint8Array>();
      for (const ref of request.multipart.attachments) payloads.set(ref.payloadId, await owner.service.options.store.getPayload(ref.payloadId));
      body = renderOriginMultipart(JSON.parse(request.body), request.multipart.boundary, request.multipart.attachments, payloads);
      if (createHash('sha256').update(body).digest('hex') !== request.multipart.wireDigest) throw new TelegramOriginHoldError('attachment-wire-digest-mismatch');
      contentType = `multipart/form-data; boundary=${request.multipart.boundary}`;
    }
    return () => network(url.href, { ...input.init, method: 'POST', headers: { 'Content-Type': contentType }, body, redirect: 'error' });
  };
  const wire: OriginBotTransport = async request => (await prepareWire(request))();
  wire.prepare = async request => {
    const send = await prepareWire(request);
    const authority = owner.service.options.capacity;
    if (!authority) throw new OriginCapacityUnavailable();
    let available = true;
    const valid = () => available;
    return { valid, cancel: () => { available = false; }, send: async () => {
      if (!valid()) { available = false; throw new OriginCapacityUnavailable(); }
      // Latch before any await: even concurrent invocations get only one grant.
      available = false;
      // Durable claim/dispatch and policy checks have finished. Their latency
      // must not consume this short-lived permission to start network work.
      // Retain dispatch intent and the capacity debit, but prove a local refusal
      // so it need not spend the separate transport-attempt budget.
      try {
        // lease-freshness-lapse-retry — the cause travels with the refusal of the very evaluation that
        // refused; an authority that cannot explain (the IPC client) keeps the unexplained refusal.
        const decision = authority.reserveExplained
          ? await authority.reserveExplained(request.accountId)
          : { grant: await authority.reserve(request.accountId), refusal: null };
        if (!decision.grant) throw new OriginCapacityUnavailable(decision.refusal);
        const grant = decision.grant;
        if (Date.now() >= grant.expiresAt) throw new OriginCapacityUnavailable({ cause: 'grant-expired', leaseFreshness: null });
        if (!await authority.consume(grant)) throw new OriginCapacityUnavailable({ cause: 'consume-refused', leaseFreshness: null });
        if (Date.now() >= grant.expiresAt) throw new OriginCapacityUnavailable({ cause: 'grant-expired', leaseFreshness: null });
      } catch (error) {
        // The thrown refusal IS the request-bound proof, so its cause reaches the send site.
        const refusal = error instanceof OriginCapacityUnavailable ? error : new OriginCapacityUnavailable();
        localRefusals.set(refusal, request);
        throw refusal;
      }
      return send();
    } };
  };
  if (input.preparedOperation) {
    if (input.noticeCapability) throw new TelegramOriginHoldError('conflicting-egress-capabilities');
    return owner.service.executePreparedBot(input.preparedOperation, wire);
  }
  if (input.noticeCapability) {
    const request: SealedBotRequest = { method: input.method, accountId: owner.accountId,
      destination: botDestination(owner.accountId, params), contentType: 'application/json',
      body: typeof input.init.body === 'string' ? input.init.body : '' };
    // Permission is read independently of the failed origin worker at the final network boundary.
    if (!await owner.service.options.authorize(request)) throw new TelegramOriginHoldError('destination-not-authorized');
    const send = await prepareWire(request);
    const begin = await consumeReservedOriginNotice(input.noticeCapability, request);
    if (!begin) throw new TelegramOriginHoldError('invalid-outage-notice-capability');
    begin(); // Synchronous deadline/policy check immediately before network.
    return send();
  }
  const send = () => owner.service.sendBot({ method: input.method, accountId: owner.accountId, params, attachments }, wire);
  return owner.service.hasProducerContext() ? send() : owner.service.runAsUnboundAutomation(owner.producerId, send);
}
