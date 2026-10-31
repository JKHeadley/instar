/** Advisory failed-file comparison. It never feeds Local Verify's merge index. */
import { createHash } from 'node:crypto';
import type { LocalVerifyRecord } from './record.js';
import { classifyTestPath } from './inventory.js';

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

/** Canonical paths only; aliases could make a peer test a different file. */
export function isBoundedFailedFileSet(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 3
    && value.every((f) => typeof f === 'string' && f.length <= 300
      && /^[A-Za-z0-9_./-]+\.test\.ts$/.test(f)
      && !f.split('/').some((part) => part === '' || part === '.' || part === '..')
      && classifyTestPath(f).kind === 'laned')
    && new Set(value).size === value.length
    && [...value].sort().every((f, i) => f === value[i]);
}

export function isDiagnosisIdentity(value: unknown): value is DiagnosisIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const i = value as DiagnosisIdentity;
  return typeof i.repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(i.repo)
    && Number.isSafeInteger(i.pr) && i.pr > 0
    && [i.headSha, i.baseSha].every((s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s))
    && typeof i.baseRefName === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(i.baseRefName)
    && typeof i.verifierVersion === 'string' && i.verifierVersion.length >= 1 && i.verifierVersion.length <= 200
    && typeof i.policyHash === 'string' && /^[0-9a-f]{64}$/.test(i.policyHash)
    && isBoundedFailedFileSet(i.failedFiles)
    && Object.keys(i).every((k) => ['repo', 'pr', 'headSha', 'baseSha', 'baseRefName', 'verifierVersion', 'policyHash', 'failedFiles'].includes(k));
}

/** Only a complete small test-file failure from an ordinary full PR verify qualifies. */
export function diagnosisCandidate(record: LocalVerifyRecord): DiagnosisIdentity | null {
  if (record.kind === 'main' || record.outcome !== 'failure' || record.harnessChanging || record.protectedPath
    || !isBoundedFailedFileSet(record.failedFiles) || !record.lanes.some((lane) => lane.failed > 0)) return null;
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
