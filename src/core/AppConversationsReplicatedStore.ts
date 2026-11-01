/**
 * AppConversationsReplicatedStore — the `appConversations` replicated-store kind
 * (docs/specs/mobile-native-conversations.md §4.8; substrate:
 * docs/specs/multi-machine-replicated-store-foundation.md).
 *
 * For a native app conversation the conversation store is the agent's ONLY memory of it, so its
 * events replicate to every machine whenever native conversations are on (no separate switch —
 * the one switch is `mobilePairing.native.enabled`; server.ts injects the store into the resolved
 * stateSync flags). Events are IMMUTABLE and keyed by `eventId`, so the union has no conflicts:
 * one record per event (recordKey = a hash of the canonical conversation key and the eventId),
 * always `op: 'put'`; a deletion replicates as the conversation's own `tombstone` EVENT.
 *
 * Wire field renames: the envelope reserves `origin` (the emitting machine), so the message's
 * device-signed origin travels as `signedOrigin`, and the event kind as `eventKind`.
 * A received event is re-validated by the store's own validator before it lands.
 */
import crypto from 'node:crypto';
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { ImpactTier } from './UnionReader.js';
import { canonicalConversationKey } from './appConversationText.js';
import { validateAppEvent, type AppEvent } from './AppConversationStore.js';

export const APP_CONVERSATION_RECORD_KIND = 'app-conversation-event';
export const APP_CONVERSATIONS_STORE_KEY = 'appConversations';
export const APP_CONVERSATIONS_IMPACT_TIER: ImpactTier = 'low';

const KNOWN = ['eventId', 'eventKind', 'conversationKey', 'at', 'machineId', 'title', 'setAt', 'messageId', 'role', 'text', 'signedOrigin', 'receivedAt', 'receipt', 'state'] as const;

export function deriveAppConversationRecordKey(conversationKey: string, eventId: string): string {
  return crypto.createHash('sha256').update(`${canonicalConversationKey(conversationKey)}\u0000${eventId}`).digest('hex');
}

/** The event (as validated by the store) from a replicated record's data, or null. */
export function appEventFromReplicatedData(data: Readonly<Record<string, unknown>>): AppEvent | null {
  const { eventKind, signedOrigin, ...rest } = data as Record<string, unknown>;
  return validateAppEvent({ ...rest, kind: eventKind, ...(signedOrigin !== undefined ? { origin: signedOrigin } : {}) });
}

export const appConversationRecordStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN as unknown as ReadonlyArray<string>,
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    const ev = appEventFromReplicatedData(raw);
    return ev ? toWire(ev) : null;
  },
};

function toWire(ev: AppEvent): Record<string, unknown> {
  const { kind, ...rest } = ev as AppEvent & { origin?: unknown };
  const out: Record<string, unknown> = { ...rest, eventKind: kind };
  if ('origin' in out) { out.signedOrigin = out.origin; delete out.origin; }
  return out;
}

/** Build a put record's data for one event (the emitter supplies hlc/origin/observed). */
export function buildAppConversationRecordData(ev: AppEvent) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => ({
    ...toWire(ev),
    recordKey: deriveAppConversationRecordKey(ev.conversationKey, ev.eventId),
    hlc, op: 'put' as ReplicatedOp, origin,
    ...(observed !== undefined ? { observed } : {}),
  });
}

export const APP_CONVERSATIONS_KIND_REGISTRATION = {
  kind: APP_CONVERSATION_RECORD_KIND,
  store: APP_CONVERSATIONS_STORE_KEY,
  schema: appConversationRecordStoreSchema,
} as const;

export function appConversationsTierOf(_store: string): ImpactTier { return APP_CONVERSATIONS_IMPACT_TIER; }
