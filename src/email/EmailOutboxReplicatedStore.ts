/**
 * The `emailOutbox` replicated-store kind (docs/specs/backup-email-sending.md, A durable outbox, drained).
 *
 * Every outbox record (a row version, a tombstone, or a day's budget) travels whole inside `rec`; the outbox's own
 * fold (newest version of a key wins) decides on arrival. The holder is the only writer, so there is no conflict
 * to merge; a peer's copy is what a successor finishes from after a handoff.
 */
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from '../core/ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from '../core/HybridLogicalClock.js';
import { EMAIL_OUTBOX_RECORD_KIND, EMAIL_OUTBOX_STORE_KEY, validateOutboxRecord, type OutboxRecord } from './EmailOutbox.js';

const KNOWN = ['rec'] as const;

export const emailOutboxStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN as unknown as ReadonlyArray<string>,
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    const rec = validateOutboxRecord(raw.rec);
    return rec ? { rec } : null;
  },
};

export function buildEmailOutboxRecordData(rec: OutboxRecord) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => ({
    rec,
    recordKey: rec.recordKey,
    hlc, op: 'put' as ReplicatedOp, origin,
    ...(observed !== undefined ? { observed } : {}),
  });
}

export const EMAIL_OUTBOX_KIND_REGISTRATION = {
  kind: EMAIL_OUTBOX_RECORD_KIND,
  store: EMAIL_OUTBOX_STORE_KEY,
  schema: emailOutboxStoreSchema,
} as const;
