import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { FailedFileDiagnosisStore, DIAGNOSIS_LIMITS } from '../../../src/localVerify/failedFileDiagnosisStore.js';
import { diagnosisKey, type DiagnosisIdentity } from '../../../src/localVerify/failedFileDiagnosis.js';

const identity: DiagnosisIdentity = { repo: 'JKHeadley/instar', pr: 9, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  baseRefName: 'main', verifierVersion: 'v1', policyHash: 'c'.repeat(64), failedFiles: ['tests/unit/a.test.ts'] };
const A = '1'.repeat(32);
let root = '';
function store() { root = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-diagnosis-store-')); return new FailedFileDiagnosisStore(root); }
afterEach(() => { if (root) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/localVerify/failedFileDiagnosisStore.test.ts:cleanup' }); root = ''; });

describe('durable failed-file diagnosis attempt', () => {
  it('reserves before dispatch, survives restart, and never dispatches the exact key twice', () => {
    const s = store();
    const key = diagnosisKey(identity);
    expect(s.reserve(identity, A, 'm5', 3, 1000)?.state).toBe('reserved');
    expect(new FailedFileDiagnosisStore(root).get(key)?.attemptId).toBe(A);
    expect(s.reserve(identity, '2'.repeat(32), 'mini', 3, 1001)).toBeNull();
    expect(s.accepted(key, A, 1002)).toBe(true);
    expect(new FailedFileDiagnosisStore(root).get(key)?.state).toBe('running');
    const result = { classification: 'machine-or-flake' as const, files: [{ file: identity.failedFiles[0], originalPr: 'assertion-fail' as const,
      peerPr: 'pass' as const, peerBase: 'pass' as const }], machineMinutes: 1.5 };
    expect(s.finish(key, A, result, 2000)).toBe(true);
    expect(s.finish(key, A, result, 2001)).toBe(false);
    expect(new FailedFileDiagnosisStore(root).get(key)?.result?.classification).toBe('machine-or-flake');
    expect(s.reserve(identity, '2'.repeat(32), 'mini', 3, 2002)).toBeNull();
  });

  it('expires a peer attempt into one inconclusive result and refuses an inflated label', () => {
    const s = store();
    const key = diagnosisKey(identity);
    s.reserve(identity, A, 'm5', null, 1000);
    expect(() => s.finish(key, A, { classification: 'pr-reproducible', files: [], machineMinutes: 1 }, 1001)).toThrow();
    expect(s.get(key)?.state).toBe('reserved');
    expect(s.expire(1000 + DIAGNOSIS_LIMITS.maxRunMs + 1)).toBe(1);
    expect(s.get(key)?.result?.classification).toBe('inconclusive');
    expect(s.expire(1000 + DIAGNOSIS_LIMITS.maxRunMs + 2)).toBe(0);
  });

  it('fails closed on corrupt state instead of allowing a second dispatch', () => {
    const s = store();
    s.reserve(identity, A, 'm5', null, 1000);
    fs.writeFileSync(s.file, '{bad');
    expect(() => new FailedFileDiagnosisStore(root)).toThrow('unreadable');
  });
});
