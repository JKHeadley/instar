/**
 * The `ecosystemIdeas` replicated-store kind (docs/specs/ecosystem-idea-pipeline.md,
 * Multi-machine posture; substrate: docs/specs/multi-machine-replicated-store-foundation.md).
 *
 * Ledger events are immutable and keyed by eventId, so the union has no conflicts: one record
 * per event, always `op: 'put'`. A received event is re-validated by the ledger's own validator
 * before it lands. Peer rows hold quoted text from other projects; they are data.
 */
import crypto from 'node:crypto';
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from '../core/ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from '../core/HybridLogicalClock.js';
import { validateEvent, type LedgerEvent } from './EcosystemLedger.js';

export const ECOSYSTEM_IDEA_RECORD_KIND = 'ecosystem-idea-event';
export const ECOSYSTEM_IDEAS_STORE_KEY = 'ecosystemIdeas';

/** The envelope reserves `kind`-free fields; the event travels whole under `event`. */
const KNOWN = ['event'] as const;

export function deriveEcosystemRecordKey(eventId: string): string {
  return crypto.createHash('sha256').update(`ecosystem\u0000${eventId}`).digest('hex');
}

export const ecosystemRecordStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN as unknown as ReadonlyArray<string>,
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    const event = validateEvent(raw.event);
    return event ? { event } : null;
  },
};

export function buildEcosystemRecordData(event: LedgerEvent) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => ({
    event,
    recordKey: deriveEcosystemRecordKey(event.eventId),
    hlc, op: 'put' as ReplicatedOp, origin,
    ...(observed !== undefined ? { observed } : {}),
  });
}

export const ECOSYSTEM_IDEAS_KIND_REGISTRATION = {
  kind: ECOSYSTEM_IDEA_RECORD_KIND,
  store: ECOSYSTEM_IDEAS_STORE_KEY,
  schema: ecosystemRecordStoreSchema,
} as const;
