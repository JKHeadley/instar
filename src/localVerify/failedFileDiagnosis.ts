/** Advisory failed-file comparison. It never feeds Local Verify's merge index. */
import { createHash } from 'node:crypto';
import type { LocalVerifyRecord } from './record.js';

export type DiagnosisMode = 'off' | 'observe' | 'auto';
export type FileObservation = 'pass' | 'assertion-fail' | 'unknown';
export type DiagnosisClass = 'pr-reproducible' | 'machine-or-flake' | 'base-or-shared' | 'inconclusive';

export interface DiagnosisFileComparison {
  file: string;
  originalPr: 'assertion-fail';
  peerPr: FileObservation;
  peerBase: FileObservation;
  /** Optional matching evidence; absence or mismatch never claims assertion agreement. */
  sameAssertion?: boolean;
  latestMainOnOrigin?: FileObservation;
}

export interface DiagnosisIdentity {
  repo: string;
  pr: number;
  headSha: string;
  baseSha: string;
  baseRefName: string;
  verifierVersion: string;
  policyHash: string;
  failedFiles: string[];
}

/** Only a complete small test-file failure from an ordinary full PR verify qualifies. */
export function diagnosisCandidate(record: LocalVerifyRecord): DiagnosisIdentity | null {
  if (record.kind === 'main' || record.outcome !== 'failure' || record.harnessChanging || record.protectedPath
    || !record.failedFiles?.length || record.failedFiles.length > 3 || !record.lanes.some((lane) => lane.failed > 0)) return null;
  return {
    repo: record.repo, pr: record.pr, headSha: record.headSha, baseSha: record.baseSha,
    baseRefName: record.baseRefName, verifierVersion: record.verifierVersion,
    policyHash: record.policyHash, failedFiles: [...record.failedFiles],
  };
}

/** An exact immutable key; SHA-256 keeps filenames out of filenames and URLs. */
export function diagnosisKey(identity: DiagnosisIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    identity.repo, identity.pr, identity.headSha, identity.baseSha, identity.baseRefName,
    identity.verifierVersion, identity.policyHash, [...identity.failedFiles].sort(),
  ])).digest('hex');
}

export function classifyFileComparison(row: DiagnosisFileComparison): DiagnosisClass {
  if (row.peerPr === 'unknown' || row.peerBase === 'unknown') return 'inconclusive';
  if (row.peerPr === 'assertion-fail' && row.peerBase === 'pass') return 'pr-reproducible';
  if (row.peerPr === 'pass' && row.peerBase === 'pass') return 'machine-or-flake';
  if (row.peerPr === 'assertion-fail' && row.peerBase === 'assertion-fail') return 'base-or-shared';
  return 'inconclusive';
}

/** A mixed file set gets no single causal label; callers expose each row too. */
export function classifyComparisonSet(rows: readonly DiagnosisFileComparison[], expected: readonly string[]): DiagnosisClass {
  if (rows.length !== expected.length || new Set(rows.map((r) => r.file)).size !== rows.length
    || rows.some((r) => !expected.includes(r.file))) return 'inconclusive';
  const classes = rows.map(classifyFileComparison);
  return classes.length > 0 && classes.every((c) => c === classes[0]) ? classes[0] : 'inconclusive';
}
