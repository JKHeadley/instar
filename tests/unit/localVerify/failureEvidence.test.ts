// safe-fs-allow: test fixture cleanup through SafeFsExecutor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { realSeams } from '../../../src/localVerify/orchestratorSeams.js';
import { describe, it, expect, vi } from 'vitest';
import * as credentials from '../../../src/messaging/outbound-credential-guard.js';
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

describe('retained verification diagnostics', () => {
  it('masks recognized credentials across assertion, process, suite and reporter evidence', () => {
    const token = 'ghp_' + 'A'.repeat(36);
    const evidence = new FailureEvidence();
    evidence.capture('unit', report('assertion ' + token));
    evidence.captureProcess('unit', { status: 1, stdout: '', stderr: 'process ' + token, deadlineKilled: false });
    evidence.captureReport('unit', JSON.stringify({ testResults: [{ status: 'failed', failureMessage: 'suite ' + token }] }));
    evidence.captureReporter('unit', JSON.stringify({ messages: ['reporter ' + token] }), 1, true);
    const stored = evidence.serialize();
    for (const marker of ['assertion ', 'process ', 'suite ', 'reporter ']) expect(stored).toContain(marker);
    expect(stored).not.toContain(token);
  });

  it('masks before taking a diagnostic tail and omits oversized input', () => {
    const token = 'ghp_' + 'A'.repeat(36);
    const evidence = new FailureEvidence();
    evidence.captureProcess('unit', {
      status: 1, deadlineKilled: false,
      stdout: 'start ' + token + ' ' + 'x'.repeat(2020),
      stderr: 'oversized canary' + 'x'.repeat(1_000_000),
    });
    const stored = JSON.parse(evidence.serialize());
    expect(stored.diagnostics[0].stdout).not.toContain('A'.repeat(16));
    expect(stored.diagnostics[0].stdout).toContain('x'.repeat(100));
    expect(stored.diagnostics[0].stderr).toMatch(/omitted/);
    expect(stored.diagnosticsTruncated).toBe(true);
  });

  it('omits raw text if credential masking throws', () => {
    const mask = vi.spyOn(credentials, 'maskCredentials').mockImplementation(() => { throw new Error('mask failed'); });
    try {
      const evidence = new FailureEvidence();
      evidence.captureReporter('unit', 'sensitive canary', 1, true);
      const stored = evidence.serialize();
      expect(stored).not.toContain('sensitive canary');
      expect(stored).toContain('Diagnostic text omitted');
    } finally { mask.mockRestore(); }
  });

  it('preserves process failure tails and an exact zero reporter count', () => {
    const evidence = new FailureEvidence();
    evidence.captureProcess('unit', { status: 1, signal: null, stdout: 'native setup began', stderr: 'NativeSetupError: model load stalled', deadlineKilled: false });
    evidence.captureReporter('unit', '{"v":1,"unhandledErrors":0,"messages":[]}', 0, true);
    const stored = JSON.parse(evidence.serialize());
    expect(stored.diagnostics).toContainEqual(expect.objectContaining({ kind: 'process', step: 'unit', status: 1, stderr: 'NativeSetupError: model load stalled' }));
    expect(stored.diagnostics).toContainEqual(expect.objectContaining({ kind: 'reporter', state: 'present', unhandledErrors: 0 }));
  });

  it.each([
    [null, null, false, 'unavailable'],
    [null, null, true, 'missing'],
    ['malformed-json', null, true, 'malformed'],
    ['{"v":1,"unhandledErrors":0,"messages":[]}', 0, true, 'present'],
    ['{"v":1,"unhandledErrors":2,"messages":["panic"]}', 2, true, 'present'],
  ])('keeps reporter state distinct: %s', (text, count, available, state) => {
    const evidence = new FailureEvidence();
    evidence.captureReporter('unit', text as string | null, count as number | null, available as boolean);
    expect(JSON.parse(evidence.serialize()).diagnostics[0]).toMatchObject({ kind: 'reporter', state, unhandledErrors: count });
  });

  it('retains raw failed-suite context without retaining an unrelated passed suite', () => {
    const evidence = new FailureEvidence();
    evidence.captureReport('e2e', JSON.stringify({ testResults: [
      { name: 'passed.ts', status: 'passed', message: 'private passing output should not be copied' },
      { name: 'failed.ts', status: 'failed', message: '', failureMessage: 'beforeAll native session did not initialize', assertionResults: [] },
    ] }));
    const stored = evidence.serialize();
    expect(stored).toContain('beforeAll native session did not initialize');
    expect(stored).not.toContain('private passing output should not be copied');
  });

  it('never copies successful process output', () => {
    const evidence = new FailureEvidence();
    evidence.captureProcess('unit', { status: 0, stdout: 'do not retain successful process output', stderr: '', deadlineKilled: false });
    expect(evidence.serialize()).not.toContain('do not retain successful process output');
  });

  it('keeps the original summary allowance independently of diagnostics and bounds escaped UTF-8 JSON', () => {
    const evidence = new FailureEvidence();
    for (let i = 0; i < 100; i++) {
      evidence.capture('unit', report(`AssertionError ${i}: ` + '🚀'.repeat(4000)));
      evidence.captureProcess(`unit-${i}`, { status: 1, stdout: '\u0000\\"🚀'.repeat(4000), stderr: 'NativeError: ' + 'x'.repeat(9000), deadlineKilled: false });
    }
    const text = evidence.serialize();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(FAILURE_EVIDENCE_BYTES);
    const stored = JSON.parse(text);
    expect(stored.truncated).toBe(true);
    expect(stored.diagnosticsTruncated).toBe(true);
    expect(stored.failures.length).toBeGreaterThan(0);
    expect(stored.diagnostics.length).toBeGreaterThan(0);
    expect(stored.diagnostics.length).toBeLessThanOrEqual(64);
    expect(stored.diagnostics.at(-1).step).toBe('unit-99');
  });
});
