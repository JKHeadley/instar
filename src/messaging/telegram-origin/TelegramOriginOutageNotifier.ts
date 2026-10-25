// Governed by: Telegram Message Origin Is Mandatory; Its Display Is Optional
// (docs/STANDARDS-REGISTRY.md). Recording and presentation are independent.
/** The only consumer of pre-recorded, boot-bound recording-outage notices. */
import { randomUUID } from 'node:crypto';
import type { NoticeReservation, OriginAdmission } from './StoreTypes.js';
import { originDisplayVariant } from './OriginPresentation.js';
import type { OriginDisplaySettings, SealedBotRequest } from './types.js';
import { canonicalOrigin, wireDigest } from './CanonicalOrigin.js';
import { OriginCapacityUnavailable } from './OriginEgressCapacity.js';
import type { OriginCapacityAuthority } from './OriginEgressCapacity.js';

export const RECORDING_OUTAGE_TEXT = 'Messages are being held because their origin could not be safely recorded. Delivery is paused while recording is unavailable.';
export interface OutagePolicyProjection {
  alertDestinationId: string;
  destination: { accountId: string; chatId: string; topicId: string | null };
  authorized: boolean;
  ownershipValid: boolean;
  /** Telegram applies personal client preferences; these are not Bot API observations. */
  clientPreferences: 'telegram-managed';
  optedOut: boolean;
  observerHealthy: boolean;
  observedAt: number;
  validUntil: number;
  version: string;
  display: OriginDisplaySettings;
}
export type NoticeOutcome = 'reserved' | 'queued' | 'attempted' | 'accepted' | 'known-failed' | 'outcome-unknown' | 'unavailable' | 'suppressed';
export interface OutageNoticeState {
  alertDestinationId: string;
  notificationAttempted: boolean;
  notificationOutcome: NoticeOutcome;
  reason: string | null;
  generation: string | null;
  materializationId: string | null;
  updatedAt: number;
}
export interface ReservedNoticePreparation {
  admission: OriginAdmission;
  /** Index 0..7 is a presealed variant, never re-rendered during the outage. */
  variants: SealedBotRequest[];
}
export interface OutageNotifierDependencies {
  capacity?: OriginCapacityAuthority;
  ownerBootId: string;
  now?: () => number;
  getPolicy: (destinationId: string) => OutagePolicyProjection | null;
  prepareFixedNotice: (destinationId: string, text: typeof RECORDING_OUTAGE_TEXT) => Promise<ReservedNoticePreparation>;
  reserveNotice: (input: { admission: OriginAdmission; ownerBootId: string; generation: string; alertDestinationId: string }) => Promise<NoticeReservation>;
  persistOutcome: (reservation: NoticeReservation, outcome: OutageNoticeState, response?: string) => Promise<void>;
  /** Must call one-shot telegramFetch with the opaque capability, never adapter retry paths. */
  sendOnce: (request: Readonly<SealedBotRequest>, capability: object) => Promise<Response>;
  onState: (state: OutageNoticeState) => void;
  maxAttemptsPerSecond?: number;
}
interface ReadyNotice { reservation: NoticeReservation; variants: readonly Readonly<SealedBotRequest>[]; bytes: number; consumed: boolean; pending?: boolean; materializationId?: string; }
interface EgressPermit { requestJson: string; begin?: () => Promise<() => void>; }
class NoticeVariantChanged extends Error {}
const egressPermits = new WeakMap<object, EgressPermit>();

/** Egress validates exact immutable request bytes and consumes synchronously. No API can mint a permit. */
export async function consumeReservedOriginNotice(capability: object, request: SealedBotRequest): Promise<(() => void) | null> {
  const permit = egressPermits.get(capability);
  if (!permit) return null;
  egressPermits.delete(capability);
  if (permit.requestJson !== canonicalOrigin(request)) return null;
  return permit.begin ? permit.begin() : () => undefined;
}

export class TelegramOriginOutageNotifier {
  readonly #deps: OutageNotifierDependencies;
  readonly #ready = new Map<string, ReadyNotice>();
  readonly #states = new Map<string, OutageNoticeState>();
  readonly #queue: string[] = [];
  readonly #queued = new Set<string>();
  readonly #pendingPersistence: Array<{ ready: ReadyNotice; state: OutageNoticeState; response?: string }> = [];
  #bytes = 0;
  #generation: string | null = null;
  #recovered = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #nextAttemptAt = 0;
  #closed = false;
  #inFlight = 0;
  constructor(deps: OutageNotifierDependencies) {
    if (!deps.ownerBootId) throw new Error('origin-notice: boot owner required');
    this.#deps = deps;
  }
  #now(): number { return this.#deps.now?.() ?? Date.now(); }
  #state(id: string, outcome: NoticeOutcome, reason: string | null, attempted = false): OutageNoticeState {
    const state = { alertDestinationId: id, notificationAttempted: attempted,
      notificationOutcome: outcome, reason, generation: this.#ready.get(id)?.reservation.generation ?? this.#generation,
      materializationId: this.#ready.get(id)?.materializationId ?? null, updatedAt: this.#now() };
    this.#states.set(id, state); this.#deps.onState({ ...state }); return state;
  }
  getState(id: string): OutageNoticeState {
    return { ...(this.#states.get(id) ?? { alertDestinationId: id, notificationAttempted: false,
      notificationOutcome: 'unavailable', reason: 'no-current-boot-reservation', generation: null, materializationId: null, updatedAt: this.#now() }) };
  }
  #policy(id: string): OutagePolicyProjection | null {
    let p: OutagePolicyProjection | null;
    try { const current = this.#deps.getPolicy(id); p = current ? structuredClone(current) : null; } catch { return null; }
    const now = this.#now();
    if (!p || p.clientPreferences !== 'telegram-managed' || !['authorized', 'ownershipValid', 'optedOut', 'observerHealthy'].every(key =>
      typeof p![key as keyof OutagePolicyProjection] === 'boolean') || !Number.isSafeInteger(p.observedAt) ||
      !Number.isSafeInteger(p.validUntil) || p.alertDestinationId !== id || !p.observerHealthy || p.observedAt > now ||
      now - p.observedAt > 30_000 || p.validUntil <= now) return null;
    return p;
  }
  /** Called only following an independently successful store health transaction. */
  async recordingRecovered(authorizedAlertDestinations: readonly string[]): Promise<void> {
    if (this.#closed || this.#inFlight || this.#queue.length) return;
    for (const pending of [...this.#pendingPersistence]) {
      await this.#deps.persistOutcome(pending.ready.reservation, pending.state, pending.response);
      this.#pendingPersistence.splice(this.#pendingPersistence.indexOf(pending), 1);
    }
    if (!this.#recovered) {
      this.#generation = randomUUID(); this.#recovered = true;
      this.#ready.clear(); this.#bytes = 0;
    }
    const generation = this.#generation;
    if (generation === null) throw new Error('origin-notice: generation unavailable');
    for (const id of new Set(authorizedAlertDestinations)) {
      if (this.#closed || !this.#recovered || generation !== this.#generation) return;
      if (this.#ready.has(id)) continue;
      if (this.#ready.size >= 1000) { this.#state(id, 'unavailable', 'reservation-capacity'); continue; }
      const p = this.#policy(id);
      if (!p || !p.authorized || !p.ownershipValid || p.optedOut) {
        this.#state(id, 'unavailable', 'destination-policy'); continue;
      }
      const prepared = await this.#deps.prepareFixedNotice(id, RECORDING_OUTAGE_TEXT);
      if (prepared.variants.length !== 8 || prepared.admission.children.length !== 1) throw new Error('origin-notice: invalid finite plan');
      const bytes = prepared.variants.reduce((n, v) => n + Buffer.byteLength(canonicalOrigin(v)), 0);
      if (bytes > 8192 || this.#bytes + bytes > 8 * 1024 * 1024) { this.#state(id, 'unavailable', 'reservation-byte-capacity'); continue; }
      const materializations = prepared.admission.children[0].materializations;
      if (materializations.length !== 8 || prepared.variants.some((v, index) =>
        materializations[index].requestJson !== canonicalOrigin(v) || materializations[index].requestDigest !== wireDigest(canonicalOrigin(v)))) {
        throw new Error('origin-notice: unrecorded variant');
      }
      const reservation = await this.#deps.reserveNotice({ admission: prepared.admission,
        ownerBootId: this.#deps.ownerBootId, generation, alertDestinationId: id });
      if (reservation.ownerBootId !== this.#deps.ownerBootId || reservation.generation !== generation || reservation.alertDestinationId !== id) {
        throw new Error('origin-notice: mismatched reservation owner');
      }
      if (!this.#recovered || generation !== this.#generation || this.#closed) return;
      const variants = prepared.variants.map(v => Object.freeze(JSON.parse(canonicalOrigin(v)) as SealedBotRequest));
      this.#ready.set(id, { reservation, variants, bytes, consumed: false }); this.#bytes += bytes;
      this.#state(id, 'reserved', null);
    }
  }
  /** The sole narrow public outage trigger. No caller controls message bytes or metadata. */
  requestHoldNotice(operatorAlertDestinationId: string): OutageNoticeState {
    this.#recovered = false;
    if (this.#closed) return this.#state(operatorAlertDestinationId, 'unavailable', 'owner-closed');
    const ready = this.#ready.get(operatorAlertDestinationId);
    if (!ready) return this.#state(operatorAlertDestinationId, 'unavailable', 'no-current-boot-reservation');
    if (ready.consumed || ready.pending || this.#queued.has(operatorAlertDestinationId)) return this.getState(operatorAlertDestinationId);
    if (this.#queue.length >= 1000) return this.#state(operatorAlertDestinationId, 'unavailable', 'notice-queue-capacity');
    this.#queue.push(operatorAlertDestinationId); this.#queued.add(operatorAlertDestinationId);
    const state = this.#state(operatorAlertDestinationId, 'queued', null); this.#schedule(); return state;
  }
  #schedule(): void {
    if (this.#closed || this.#timer || !this.#queue.length) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const id = this.#queue.shift(); if (!id) return;
      this.#queued.delete(id);
      const rate = Math.max(0.1, Math.min(10, this.#deps.maxAttemptsPerSecond ?? 10));
      this.#nextAttemptAt = this.#now() + Math.ceil(1000 / rate);
      this.#inFlight++;
      void this.#fire(id).finally(() => { this.#inFlight--; this.#schedule(); });
      this.#schedule();
    }, Math.max(0, this.#nextAttemptAt - this.#now()));
    this.#timer.unref?.();
  }
  async #fire(id: string): Promise<void> {
    const ready = this.#ready.get(id);
    if (!ready || ready.consumed || ready.pending || this.#closed) return;
    ready.pending = true;
    try { await this.#fireReady(id, ready); } finally { ready.pending = false; }
  }
  async #fireReady(id: string, ready: ReadyNotice): Promise<void> {
    const requeue = (reason = 'credential-capacity-unavailable') => {
      if (this.#closed || ready.consumed || this.#queued.has(id)) return;
      this.#queue.push(id); this.#queued.add(id); this.#state(id, 'queued', reason);
    };
    let p = this.#policy(id);
    const suppress = (reason: string) => {
      ready.consumed = true;
      // No dispatch variant was consumed. Record the no-footer variant solely
      // as the required storage reference for this not-attempted outcome.
      ready.materializationId = ready.reservation.materializations[0].materializationId;
      const state = this.#state(id, 'suppressed', reason);
      this.#pendingPersistence.push({ ready, state });
    };
    if (!p) { suppress('state-unavailable'); return; }
    if (!p.authorized || !p.ownershipValid || p.optedOut) {
      suppress('destination-policy'); return;
    }
    // Standalone notifier tests can provide their own one-shot transport. The
    // production runtime always attaches its shared owner/client authority.
    let grant: Awaited<ReturnType<OriginCapacityAuthority['reserve']>> = null;
    if (this.#deps.capacity) {
      try { grant = await this.#deps.capacity.reserve(ready.variants[0].accountId); } catch { /* Hold without consuming the notice. */ }
      if (!grant) { requeue(); return; }
      p = this.#policy(id);
      if (!p) { suppress('state-unavailable'); return; }
      if (!p.authorized || !p.ownershipValid || p.optedOut) { suppress('destination-policy'); return; }
    }
    const selectedPolicy = p;
    const variant = originDisplayVariant(p.display);
    const request = ready.variants[variant];
    if (!p.destination || p.destination.accountId !== request.accountId ||
      p.destination.chatId !== request.destination.chatId || p.destination.topicId !== request.destination.topicId) {
      suppress('destination-authority-changed'); return;
    }
    ready.materializationId = ready.reservation.materializations[variant].materializationId;
    const capability = Object.freeze({});
    const begin = async () => {
      if (this.#closed || ready.consumed) throw new OriginCapacityUnavailable();
      if (grant && (!await this.#deps.capacity!.consume(grant) || Date.now() >= grant.expiresAt)) throw new OriginCapacityUnavailable();
      return () => {
        if (this.#closed || ready.consumed) throw new OriginCapacityUnavailable();
        const current = this.#policy(id);
        if (!current || !current.authorized || !current.ownershipValid || current.optedOut ||
          canonicalOrigin(current.destination) !== canonicalOrigin(selectedPolicy.destination)) {
          suppress('destination-policy'); throw new Error('notice-policy-changed');
        }
        if (originDisplayVariant(current.display) !== variant) throw new NoticeVariantChanged();
        if (grant && Date.now() >= grant.expiresAt) throw new OriginCapacityUnavailable();
        ready.consumed = true; this.#state(id, 'attempted', null, true);
      };
    };
    egressPermits.set(capability, { requestJson: canonicalOrigin(request), ...(this.#deps.capacity ? { begin } : {}) });
    if (!this.#deps.capacity) { ready.consumed = true; this.#state(id, 'attempted', null, true); }
    let state: OutageNoticeState; let responseBody: string | undefined;
    try {
      const response = await this.#deps.sendOnce(request, capability);
      responseBody = await response.text();
      const result = JSON.parse(responseBody) as { ok?: boolean; description?: string; result?: { message_id?: number; chat?: { id?: number | string }; message_thread_id?: number | string } };
      const correlated = String(result.result?.chat?.id) === request.destination.chatId &&
        (request.destination.topicId === null || String(result.result?.message_thread_id) === request.destination.topicId);
      if (response.ok && result.ok && Number.isSafeInteger(result.result?.message_id) && result.result!.message_id! > 0 && correlated) {
        state = this.#state(id, 'accepted', null, true);
      } else if (response.status >= 400 && response.status < 500 && result.ok === false) {
        const topicUnavailable = response.status === 400 && typeof result.description === 'string' &&
          /message thread not found|TOPIC_DELETED/i.test(result.description);
        state = this.#state(id, 'known-failed', topicUnavailable ? 'telegram-topic-unavailable' : `telegram-${response.status}`, true);
      } else state = this.#state(id, 'outcome-unknown', 'no-concrete-receipt', true);
    } catch (error) {
      if (!ready.consumed) { requeue(error instanceof NoticeVariantChanged ? 'notice-variant-changed' : undefined); return; }
      if (this.getState(id).notificationOutcome === 'suppressed') return;
      // A preclaimed notice is never retried after uncertain acceptance; recovery persists this state.
      state = this.#state(id, 'outcome-unknown', 'network-or-receipt-unavailable', true);
    } finally { egressPermits.delete(capability); }
    this.#pendingPersistence.push({ ready, state, response: responseBody });
  }
  close(): void {
    this.#closed = true; if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null; this.#queue.length = 0; this.#queued.clear(); this.#ready.clear();
  }
}
