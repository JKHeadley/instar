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
import { newCapacityEvidence, sanitizeCapacityEvidence } from './OriginCapacityEvidence.js';
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
    const evidence = newCapacityEvidence(authority.diagnosticTransport ?? (authority.reserveExplained ? 'direct' : 'legacy'));
    const valid = () => available;
    const note = (cause: import('./OriginEgressCapacity.js').OriginCapacityRefusalCause, explanation: 'complete' | 'legacy-unexplained' | 'invalid' = 'complete') => {
      evidence.cause = cause; evidence.explanation = explanation;
      evidence.ownerVerdict = cause.startsWith('ipc-') ? 'unknown' : 'refused';
    };
    const clock = (start: number, end: number, elapsed: number) => { if (Math.abs((end - start) - elapsed) > 1) evidence.clockUncertain = true; };
    return { valid, cancel: () => { available = false; }, capacityEvidence: () => Object.freeze(sanitizeCapacityEvidence(evidence)), send: async () => {
      if (!valid()) { available = false; throw new OriginCapacityUnavailable(); }
      available = false;
      try {
        evidence.reserveStartedAtMs = Date.now(); const reserveMono = performance.now();
        const decision = authority.reserveExplained
          ? await authority.reserveExplained(request.accountId)
          : { grant: await authority.reserve(request.accountId), refusal: null, explanation: 'legacy-unexplained' as const };
        if ('ownerDecidedAtMs' in decision && typeof decision.ownerDecidedAtMs === 'number') evidence.reserveOwnerDecidedAtMs = decision.ownerDecidedAtMs;
        evidence.reserveEndedAtMs = Date.now(); evidence.reserveDurationMs = performance.now() - reserveMono;
        clock(evidence.reserveStartedAtMs, evidence.reserveEndedAtMs, evidence.reserveDurationMs);
        evidence.explanation = decision.explanation ?? 'complete';
        if (!decision.grant) {
          note(decision.refusal?.cause ?? 'legacy-unexplained', decision.explanation ?? (decision.refusal ? 'complete' : 'legacy-unexplained'));
          // IPC used to return null without a refusal. New attribution must not change its retry classification.
          throw new OriginCapacityUnavailable(authority.diagnosticTransport === 'ipc' ? null : decision.refusal);
        }
        const grant = decision.grant;
        evidence.ownerVerdict = 'granted'; evidence.grantExpiresAtMs = grant.expiresAt;
        evidence.remainingAtReserveMs = grant.expiresAt - evidence.reserveEndedAtMs;
        evidence.stage = 'pre-network'; evidence.checkedAtMs = Date.now();
        if (evidence.checkedAtMs >= grant.expiresAt) { evidence.cause = 'grant-expired'; throw new OriginCapacityUnavailable({ cause: 'grant-expired', leaseFreshness: null }); }
        evidence.stage = 'consume'; evidence.consumeStartedAtMs = Date.now(); const consumeMono = performance.now();
        clock(evidence.reserveEndedAtMs, evidence.consumeStartedAtMs, consumeMono - reserveMono - evidence.reserveDurationMs);
        evidence.remainingAtConsumeMs = grant.expiresAt - evidence.consumeStartedAtMs;
        const consumed = authority.consumeExplained ? await authority.consumeExplained(grant)
          : { consumed: await authority.consume(grant), refusal: null, explanation: 'legacy-unexplained' as const };
        if ('ownerDecidedAtMs' in consumed && typeof consumed.ownerDecidedAtMs === 'number') evidence.consumeOwnerDecidedAtMs = consumed.ownerDecidedAtMs;
        evidence.consumeEndedAtMs = Date.now(); evidence.consumeDurationMs = performance.now() - consumeMono;
        clock(evidence.consumeStartedAtMs, evidence.consumeEndedAtMs, evidence.consumeDurationMs);
        evidence.explanation = consumed.explanation ?? 'complete';
        if (!consumed.consumed) {
          note(consumed.refusal?.cause ?? 'legacy-unexplained', consumed.explanation ?? (consumed.refusal ? 'complete' : 'legacy-unexplained'));
          if (consumed.observedOwnerVerdict === 'consumed') {
            evidence.ownerVerdict = 'consumed'; evidence.stage = 'pre-network'; evidence.explanation = 'invalid';
          }
          // consume() was a boolean; preserve its original generic scheduler reason even for an explained lease refusal.
          throw new OriginCapacityUnavailable({ cause: 'consume-refused', leaseFreshness: null });
        }
        evidence.ownerVerdict = 'consumed'; evidence.stage = 'pre-network'; evidence.checkedAtMs = Date.now();
        if (evidence.checkedAtMs >= grant.expiresAt) { evidence.cause = 'grant-expired'; throw new OriginCapacityUnavailable({ cause: 'grant-expired', leaseFreshness: null }); }
        evidence.stage = 'network-start'; evidence.cause = null;
      } catch (error) {
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
