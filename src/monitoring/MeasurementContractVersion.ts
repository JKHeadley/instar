/** Closed, bounded definitions retained by the existing measurement owner. */
import crypto from 'node:crypto';
import { validMeasurementBinding, type GenericMeasurementContract } from './MeasurementSubject.js';
import type { MaturationEvaluationContract } from '../core/InitiativeTracker.js';
import { parseMaturationOutcome, validMaturationPolicy } from './MaturationOutcome.js';

export interface MeasurementContractVersion {
  hash: string; firstArchivedAtMs: number; lastSeenAtMs: number; contract: MaturationEvaluationContract;
}
const closed = (v: unknown, fields: string[]): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => fields.includes(k)));
export const measurementContractHash = (contract: MaturationEvaluationContract) => crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
export function validArchivedContract(raw: unknown): raw is MaturationEvaluationContract {
  if (!closed(raw, ['cadenceHours', 'evidenceMaxAgeHours', 'metrics', 'outcome', 'subject', 'adapter'])) return false;
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024 || !validMaturationPolicy(raw as unknown as MaturationEvaluationContract)) return false;
    const contract = raw as unknown as MaturationEvaluationContract;
    return contract.metrics.every(m => closed(m, ['id', 'source', 'sourceRef', 'direction', 'threshold', 'minSamples'])) &&
      (contract.outcome === undefined || parseMaturationOutcome(contract.outcome, contract.metrics.map(m => m.id)) !== null) && validMeasurementBinding(contract);
  } catch { /* @silent-fallback-ok — malformed definitions are explicit archive failures */ return false; }
}
export interface MeasurementContractVersions {
  available: boolean; requested: number; missing: string[]; omitted: string[]; unreadable: string[]; rows: MeasurementContractVersion[];
}

/** Closed peer archive projection, bound to precisely the requested history hashes. */
export function validMeasurementContractVersions(raw: unknown, hashes: string[], now: number, subjectId?:string): raw is MeasurementContractVersions {
  if (!closed(raw, ['available','requested','missing','omitted','unreadable','rows']) || typeof raw.available !== 'boolean' ||
      raw.requested !== new Set(hashes).size || !Array.isArray(raw.rows) || raw.rows.length > 129) return false;
  const allowed = new Set(hashes); const seen = new Set<string>();
  for (const kind of ['missing','omitted','unreadable'] as const) {
    const list = raw[kind]; if (!Array.isArray(list) || list.length > 129) return false;
    for (const hash of list) { if (typeof hash !== 'string' || !allowed.has(hash) || seen.has(hash)) return false; seen.add(hash); }
  }
  let bytes = 0;
  for (const row of raw.rows) {
    if (!closed(row, ['hash','firstArchivedAtMs','lastSeenAtMs','contract']) || typeof row.hash !== 'string' ||
        !allowed.has(row.hash) || seen.has(row.hash) || !validArchivedContract(row.contract) || ('subject' in row.contract && !validGenericMeasurement(row.contract,subjectId)) || measurementContractHash(row.contract) !== row.hash ||
        !Number.isSafeInteger(row.firstArchivedAtMs) || (row.firstArchivedAtMs as number) <= 0 || !Number.isSafeInteger(row.lastSeenAtMs) ||
        (row.lastSeenAtMs as number) < (row.firstArchivedAtMs as number) || (row.lastSeenAtMs as number) > now + 5000) return false;
    bytes += Buffer.byteLength(JSON.stringify(row)); seen.add(row.hash);
  }
  return bytes <= 32 * 1024 && (raw.available ? seen.size === allowed.size : seen.size === 0);
}

export function validGenericMeasurement(raw: unknown, initiativeId?: string): raw is GenericMeasurementContract {
  return validArchivedContract(raw) && validMeasurementBinding(raw, initiativeId) &&
    (raw as GenericMeasurementContract).subject !== undefined && raw.outcome !== undefined;
}
