/** Exact, advisory-only peer protocol. A result cannot be imported as a verify record. */
import { ATTEMPT_ID_RE } from './record.js';
import { classifyComparisonSet, diagnosisKey, isDiagnosisIdentity, type DiagnosisIdentity } from './failedFileDiagnosis.js';
import type { DiagnosisMarker } from './failedFileDiagnosisStore.js';

export interface DiagnosisPeerRequest extends DiagnosisIdentity {
  attemptId: string;
  coordinatorMachineId: string;
  leaseEpoch: number | null;
}

export interface DiagnosisPeerAnswer {
  attemptId: string;
  identity: DiagnosisIdentity;
  peerMachineId: string;
  coordinatorMachineId: string;
  leaseEpoch: number | null;
  classification: NonNullable<DiagnosisMarker['result']>['classification'];
  files: NonNullable<DiagnosisMarker['result']>['files'];
  machineMinutes: number;
  reason?: string;
}

const IDENTITY_FIELDS = ['repo', 'pr', 'headSha', 'baseSha', 'baseRefName', 'verifierVersion', 'policyHash', 'failedFiles'] as const;
const REQUEST_FIELDS = [...IDENTITY_FIELDS, 'attemptId', 'coordinatorMachineId', 'leaseEpoch'];

export function parseDiagnosisPeerRequest(value: unknown): DiagnosisPeerRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = value as Record<string, unknown>;
  if (Object.keys(x).length !== REQUEST_FIELDS.length || !REQUEST_FIELDS.every((k) => k in x)
    || !Object.keys(x).every((k) => REQUEST_FIELDS.includes(k as typeof REQUEST_FIELDS[number]))) return null;
  const identity = Object.fromEntries(IDENTITY_FIELDS.map((k) => [k, x[k]]));
  if (!isDiagnosisIdentity(identity) || typeof x.attemptId !== 'string' || !ATTEMPT_ID_RE.test(x.attemptId)
    || typeof x.coordinatorMachineId !== 'string' || !x.coordinatorMachineId || x.coordinatorMachineId.length > 200
    || !(x.leaseEpoch === null || Number.isSafeInteger(x.leaseEpoch) && (x.leaseEpoch as number) >= 0)) return null;
  return x as unknown as DiagnosisPeerRequest;
}

/** Refuse anything mismatched before writing the coordinator's terminal observation. */
export function diagnosisImportRefusal(value: unknown, marker: DiagnosisMarker, ctx: {
  holdsLease: boolean; leaseEpoch: number | null; coordinatorMachineId: string; verifierVersion: string; policyHash: string;
}): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid-answer';
  const a = value as DiagnosisPeerAnswer;
  if (a.attemptId !== marker.attemptId) return 'attempt-mismatch';
  if (!isDiagnosisIdentity(a.identity) || diagnosisKey(a.identity) !== marker.key) return 'identity-mismatch';
  if (a.peerMachineId !== marker.peerMachineId) return 'peer-mismatch';
  if (a.coordinatorMachineId !== ctx.coordinatorMachineId) return 'coordinator-mismatch';
  if (!ctx.holdsLease || a.leaseEpoch !== marker.leaseEpoch || a.leaseEpoch !== ctx.leaseEpoch) return 'lease-mismatch';
  if (a.identity.verifierVersion !== ctx.verifierVersion || a.identity.policyHash !== ctx.policyHash) return 'verifier-or-policy-mismatch';
  if (!Array.isArray(a.files) || a.files.length > marker.identity.failedFiles.length
    || a.files.some((r) => !r || !marker.identity.failedFiles.includes(r.file) || r.originalPr !== 'assertion-fail'
      || !['pass', 'assertion-fail', 'unknown'].includes(r.peerPr)
      || !['pass', 'assertion-fail', 'unknown'].includes(r.peerBase))) return 'invalid-files';
  if (!['pr-reproducible', 'machine-or-flake', 'base-or-shared', 'inconclusive'].includes(a.classification)
    || a.classification !== 'inconclusive' && classifyComparisonSet(a.files, marker.identity.failedFiles) !== a.classification) return 'invalid-classification';
  if (typeof a.machineMinutes !== 'number' || !Number.isFinite(a.machineMinutes) || a.machineMinutes < 0 || a.machineMinutes > 15) return 'invalid-time';
  if (a.reason !== undefined && (typeof a.reason !== 'string' || a.reason.length > 160)) return 'invalid-reason';
  if (Object.keys(a).some((k) => !['attemptId', 'identity', 'peerMachineId', 'coordinatorMachineId', 'leaseEpoch', 'classification', 'files', 'machineMinutes', 'reason'].includes(k))) return 'extra-fields';
  return null;
}
