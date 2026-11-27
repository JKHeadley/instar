/**
 * The `recommendedServices` replicated-store kind (docs/specs/recommended-services.md,
 * Multi-machine posture). Rows are immutable and keyed by eventId, so the union has no
 * conflicts. The ledger verifies each row's signature before it lands.
 */
import crypto from 'node:crypto';
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from '../core/ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from '../core/HybridLogicalClock.js';
import { validateRow, type LedgerRow } from './RecommendedServicesLedger.js';

export const RECOMMENDED_SERVICE_RECORD_KIND = 'recommended-service-record';
export const RECOMMENDED_SERVICES_STORE_KEY = 'recommendedServices';

const KNOWN = ['row'] as const;

export function deriveRecommendedServiceRecordKey(eventId: string): string {
  return crypto.createHash('sha256').update(`recommended-services\u0000${eventId}`).digest('hex');
}

export const recommendedServiceStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN as unknown as ReadonlyArray<string>,
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    const row = validateRow(raw.row);
    return row ? { row } : null;
  },
};

export function buildRecommendedServiceRecordData(row: LedgerRow) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => ({
    row,
    recordKey: deriveRecommendedServiceRecordKey(row.eventId),
    hlc, op: 'put' as ReplicatedOp, origin,
    ...(observed !== undefined ? { observed } : {}),
  });
}

export const RECOMMENDED_SERVICES_KIND_REGISTRATION = {
  kind: RECOMMENDED_SERVICE_RECORD_KIND,
  store: RECOMMENDED_SERVICES_STORE_KEY,
  schema: recommendedServiceStoreSchema,
} as const;
