import { describe, expect, it } from 'vitest';
import { classifyComparisonSet, classifyFileComparison, diagnosisCandidate, diagnosisKey, type DiagnosisFileComparison } from '../../../src/localVerify/failedFileDiagnosis.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const F = 'tests/unit/a.test.ts';
const record = { repo: 'JKHeadley/instar', pr: 9, headSha: H, baseSha: B, baseRefName: 'main',
  verifierVersion: '1.3.1530', policyHash: 'c'.repeat(64), kind: undefined,
  outcome: 'failure', harnessChanging: false, protectedPath: false, failedFiles: [F],
  lanes: [{ name: 'unit', failed: 1 }],
} as LocalVerifyRecord;

describe('failed-file diagnosis decisions', () => {
  it('accepts only a full, small ordinary PR failure and binds every comparison input into its key', () => {
    const candidate = diagnosisCandidate(record)!;
    expect(candidate.failedFiles).toEqual([F]);
    for (const change of [{ headSha: B }, { baseSha: H }, { policyHash: 'd'.repeat(64) }, { failedFiles: ['tests/unit/b.test.ts'] }]) {
      expect(diagnosisKey({ ...candidate, ...change })).not.toBe(diagnosisKey(candidate));
    }
    expect(diagnosisCandidate({ ...record, harnessChanging: true })).toBeNull();
    expect(diagnosisCandidate({ ...record, protectedPath: true })).toBeNull();
    expect(diagnosisCandidate({ ...record, outcome: 'error' })).toBeNull();
    expect(diagnosisCandidate({ ...record, failedFiles: undefined })).toBeNull();
    expect(diagnosisCandidate({ ...record, lanes: [{ ...record.lanes[0], failed: 0 }] })).toBeNull();
  });

  it.each([
    ['assertion-fail', 'pass', 'pr-reproducible'],
    ['pass', 'pass', 'machine-or-flake'],
    ['assertion-fail', 'assertion-fail', 'base-or-shared'],
    ['unknown', 'pass', 'inconclusive'],
    ['pass', 'assertion-fail', 'inconclusive'],
  ] as const)('classifies peer PR %s and peer base %s as %s', (peerPr, peerBase, result) => {
    expect(classifyFileComparison({ file: F, originalPr: 'assertion-fail', peerPr, peerBase })).toBe(result);
  });

  it('refuses to summarize missing, duplicate or mixed file observations', () => {
    const p: DiagnosisFileComparison = { file: F, originalPr: 'assertion-fail', peerPr: 'assertion-fail', peerBase: 'pass' };
    const q: DiagnosisFileComparison = { ...p, file: 'tests/unit/b.test.ts' };
    expect(classifyComparisonSet([p, q], [p.file, q.file])).toBe('pr-reproducible');
    expect(classifyComparisonSet([p], [p.file, q.file])).toBe('inconclusive');
    expect(classifyComparisonSet([p, p], [p.file, q.file])).toBe('inconclusive');
    expect(classifyComparisonSet([p, { ...q, peerPr: 'pass' }], [p.file, q.file])).toBe('inconclusive');
  });
});
