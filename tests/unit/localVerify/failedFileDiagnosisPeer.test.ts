import { describe, expect, it } from 'vitest';
import { diagnosisImportRefusal, parseDiagnosisPeerRequest, type DiagnosisPeerAnswer } from '../../../src/localVerify/failedFileDiagnosisPeer.js';
import { diagnosisKey, type DiagnosisIdentity } from '../../../src/localVerify/failedFileDiagnosis.js';
import type { DiagnosisMarker } from '../../../src/localVerify/failedFileDiagnosisStore.js';

const identity: DiagnosisIdentity = { repo: 'JKHeadley/instar', pr: 9, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  baseRefName: 'main', verifierVersion: 'v1', policyHash: 'c'.repeat(64), failedFiles: ['tests/unit/a.test.ts'] };
const attemptId = '1'.repeat(32);
const req = { ...identity, attemptId, coordinatorMachineId: 'studio', leaseEpoch: 4 };
const marker: DiagnosisMarker = { key: diagnosisKey(identity), identity, attemptId, peerMachineId: 'm5', leaseEpoch: 4,
  state: 'running', createdAt: 100, updatedAt: 101 };
const ctx = { holdsLease: true, leaseEpoch: 4, coordinatorMachineId: 'studio', verifierVersion: 'v1', policyHash: 'c'.repeat(64) };
const answer: DiagnosisPeerAnswer = { attemptId, identity, peerMachineId: 'm5', coordinatorMachineId: 'studio', leaseEpoch: 4,
  classification: 'machine-or-flake', files: [{ file: identity.failedFiles[0], originalPr: 'assertion-fail', peerPr: 'pass', peerBase: 'pass' }], machineMinutes: 1 };

describe('advisory diagnosis peer protocol', () => {
  it('requires exact current identity and canonical failed-file paths', () => {
    expect(parseDiagnosisPeerRequest(req)).toEqual(req);
    expect(parseDiagnosisPeerRequest({ ...req, extra: true })).toBeNull();
    expect(parseDiagnosisPeerRequest({ ...req, headSha: 'z'.repeat(40) })).toBeNull();
    expect(parseDiagnosisPeerRequest({ ...req, failedFiles: ['tests/unit/../fixtures/a.test.ts'] })).toBeNull();
    expect(parseDiagnosisPeerRequest({ ...req, leaseEpoch: -1 })).toBeNull();
  });

  it('imports only the reserved peer, lease epoch, verifier and exact file observations', () => {
    expect(diagnosisImportRefusal(answer, marker, ctx)).toBeNull();
    expect(diagnosisImportRefusal({ ...answer, attemptId: '2'.repeat(32) }, marker, ctx)).toBe('attempt-mismatch');
    expect(diagnosisImportRefusal({ ...answer, peerMachineId: 'mini' }, marker, ctx)).toBe('peer-mismatch');
    expect(diagnosisImportRefusal(answer, marker, { ...ctx, holdsLease: false })).toBe('lease-mismatch');
    expect(diagnosisImportRefusal(answer, marker, { ...ctx, policyHash: 'd'.repeat(64) })).toBe('verifier-or-policy-mismatch');
    expect(diagnosisImportRefusal({ ...answer, files: [] }, marker, ctx)).toBe('invalid-classification');
    expect(diagnosisImportRefusal({ ...answer, machineMinutes: 16 }, marker, ctx)).toBe('invalid-time');
  });
});
