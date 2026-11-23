// safe-fs-allow: test fixture cleanup through SafeFsExecutor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { realSeams } from '../../../src/localVerify/orchestratorSeams.js';
import { describe, it, expect } from 'vitest';
import { FailureEvidence, FAILURE_EVIDENCE_BYTES } from '../../../src/localVerify/failureEvidence.js';
import { parseVitestJson } from '../../../src/localVerify/laneReport.js';

function report(message: string, collection = false) {
  return parseVitestJson(JSON.stringify({ testResults: [{
    name: '/run/tests/e2e/job-launch.test.ts', status: 'failed',
    message: collection ? message : '',
    assertionResults: collection ? [] : [{ status: 'failed', fullName: 'waits for complete argv', failureMessages: [message] }],
  }] }), '/run');
}

describe('bounded failed verification evidence', () => {
  it('discloses a failed assertion whose name exceeded the parser limit', () => {
    const parsed = parseVitestJson(JSON.stringify({ testResults: [{ name: '/run/tests/unit/a.test.ts', status: 'failed', message: '', assertionResults: [
      { status: 'failed', fullName: 'known test', failureMessages: ['expected false'] },
      { status: 'failed', fullName: 'x'.repeat(301), failureMessages: ['omitted name'] },
    ] }] }), '/run');
    const evidence = new FailureEvidence();
    evidence.capture('unit', parsed);
    const result = JSON.parse(evidence.serialize());
    expect(result.truncated).toBe(true);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].test).toBe('known test');
  });

  it('writes a private artifact and refuses an existing symlink through the real filesystem seam', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-evidence-'));
    try {
      const seam = realSeams(() => {}, dir).fs;
      const target = path.join(dir, 'diagnostic.json');
      seam.writeFile(target, '{}', { mode: 0o600, flag: 'wx' });
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      const link = path.join(dir, 'link.json');
      fs.symlinkSync(target, link);
      expect(() => seam.writeFile(link, 'changed', { mode: 0o600, flag: 'wx' })).toThrow();
      expect(fs.readFileSync(target, 'utf8')).toBe('{}');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'failureEvidence.test.ts' });
    }
  });

  it('retains the actual assertion even after the parsed report is later changed', () => {
    const evidence = new FailureEvidence();
    const parsed = report('AssertionError: expected argv to contain --model');
    evidence.capture('e2e', parsed);
    parsed.files.clear();
    expect(JSON.parse(evidence.serialize())).toMatchObject({ truncated: false, failures: [{
      lane: 'e2e', file: 'tests/e2e/job-launch.test.ts', test: 'waits for complete argv',
      message: 'AssertionError: expected argv to contain --model',
    }] });
  });

  it('keeps collection errors that have no named failed assertion', () => {
    const evidence = new FailureEvidence();
    evidence.capture('integration', report('Error: import failed', true));
    expect(JSON.parse(evidence.serialize()).failures[0].message).toContain('import failed');
  });

  it('bounds the complete UTF-8 JSON and discloses omitted evidence', () => {
    const evidence = new FailureEvidence();
    for (let i = 0; i < 100; i++) evidence.capture('unit', report('🚀'.repeat(4000)));
    const text = evidence.serialize();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(FAILURE_EVIDENCE_BYTES);
    const result = JSON.parse(text);
    expect(result.truncated).toBe(true);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('does not retain successful test output', () => {
    const evidence = new FailureEvidence();
    evidence.capture('unit', parseVitestJson(JSON.stringify({ testResults: [{
      name: '/run/tests/unit/pass.test.ts', status: 'passed', message: '',
      assertionResults: [{ status: 'passed', fullName: 'passes' }],
    }] }), '/run'));
    expect(JSON.parse(evidence.serialize()).failures).toEqual([]);
  });
});
