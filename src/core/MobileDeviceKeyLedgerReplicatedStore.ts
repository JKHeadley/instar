/**
 * MobileDeviceKeyLedgerReplicatedStore — the `mobileDeviceKeyLedger` replicated-store kind
 * (docs/specs/mobile-native-conversations.md §4.8; substrate:
 * docs/specs/multi-machine-replicated-store-foundation.md).
 *
 * A signed app message read on another machine cannot be checked without the ledger of paired
 * phone keys, so the ledger replicates to every machine whenever native conversations are on
 * (no separate switch; server.ts injects the store into the resolved stateSync flags). Rows are
 * immutable and machine-signed; one record per (type, keyHash, deviceId, writing machine), always `put`.
 *
 * The receiver re-validates the row's SHAPE here (the envelope schema) and its SIGNATURE in
 * MobileDeviceKeyLedger.ingestReplicated — a row lands only when it verifies under the pinned
 * identity key of the machine it names, so a peer cannot add a key on another machine's behalf.
 */
import crypto from 'node:crypto';
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { ImpactTier } from './UnionReader.js';
import { ledgerRowId, validateLedgerRow, type LedgerRow } from './MobileDeviceKeyLedger.js';

export const DEVICE_KEY_LEDGER_RECORD_KIND = 'mobile-device-key-ledger-row';
export const DEVICE_KEY_LEDGER_STORE_KEY = 'mobileDeviceKeyLedger';
export const DEVICE_KEY_LEDGER_IMPACT_TIER: ImpactTier = 'low';

const KNOWN = ['type', 'keyHash', 'publicKey', 'deviceId', 'host', 'approvedVia', 'activatedAt', 'revokedAt', 'machineId', 'signerKeyHash', 'sig'] as const;

export function deriveDeviceKeyLedgerRecordKey(row: Pick<LedgerRow, 'type' | 'keyHash' | 'deviceId' | 'machineId'>): string {
  return crypto.createHash('sha256').update(ledgerRowId(row)).digest('hex');
}

/** The row (shape-validated) from a replicated record's data, or null. */
export function ledgerRowFromReplicatedData(data: Readonly<Record<string, unknown>>): LedgerRow | null {
  const out: Record<string, unknown> = {};
  for (const k of KNOWN) if (data[k] !== undefined) out[k] = data[k];
  return validateLedgerRow(out);
}

export const deviceKeyLedgerRecordStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN as unknown as ReadonlyArray<string>,
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    const row = ledgerRowFromReplicatedData(raw);
    return row ? { ...row } : null;
  },
};

/** Build a put record's data for one row (the emitter supplies hlc/origin/observed). */
export function buildDeviceKeyLedgerRecordData(row: LedgerRow) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => ({
    ...row,
    recordKey: deriveDeviceKeyLedgerRecordKey(row),
    hlc, op: 'put' as ReplicatedOp, origin,
    ...(observed !== undefined ? { observed } : {}),
  });
}

export const DEVICE_KEY_LEDGER_KIND_REGISTRATION = {
  kind: DEVICE_KEY_LEDGER_RECORD_KIND,
  store: DEVICE_KEY_LEDGER_STORE_KEY,
  schema: deviceKeyLedgerRecordStoreSchema,
} as const;
