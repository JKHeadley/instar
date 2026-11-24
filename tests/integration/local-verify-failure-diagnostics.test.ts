import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { verificationDiagnosticsFixture } from '../helpers/verificationDiagnosticsFixture.js';
import { FAILURE_EVIDENCE_BYTES, FAILURE_EVIDENCE_FILE } from '../../src/localVerify/failureEvidence.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'verify-diagnostics:integration-cleanup' }); });
const home = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-diagnostics-'))); dirs.push(dir); return dir; };

describe('verification failure diagnostics — real filesystem and owned child output', () => {
  it('retains native child failure and raw suite/reporter evidence after temporary reports are deleted', async () => {
    const fixture = verificationDiagnosticsFixture(home(), true);
    const result = await fixture.run();
    expect(result.kind === 'record' && result.record.outcome).toBe('failure');
    const file = path.join(fixture.paths.runDir, FAILURE_EVIDENCE_FILE);
    const text = fs.readFileSync(file, 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(FAILURE_EVIDENCE_BYTES);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const evidence = JSON.parse(text);
    expect(evidence.diagnostics).toContainEqual(expect.objectContaining({ kind: 'process', step: 'unit', stderr: expect.stringContaining('NativeFixtureError') }));
    expect(evidence.diagnostics).toContainEqual(expect.objectContaining({ kind: 'report', step: 'unit', text: expect.stringContaining('HookInitializationError') }));
    expect(evidence.diagnostics).toContainEqual(expect.objectContaining({ kind: 'reporter', step: 'unit', unhandledErrors: 1 }));
    expect(fs.existsSync(fixture.paths.reportsDir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(fixture.paths.keptListFile, 'utf8'))).toContain(fixture.paths.runDir);
    const allLogs = JSON.stringify(fixture.logs);
    expect(allLogs).not.toContain('NativeFixtureError');
    expect(allLogs).not.toContain('OwnedUnhandledError');
  });

  it('successful verification keeps no diagnostic capsule or temporary report tree', async () => {
    const fixture = verificationDiagnosticsFixture(home(), false);
    const result = await fixture.run();
    expect(result.kind === 'record' && result.record.outcome).toBe('success');
    expect(fs.existsSync(fixture.paths.runDir)).toBe(false);
    expect(fs.existsSync(fixture.paths.reportsDir)).toBe(false);
  });
});
