import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTmp, proberContractCases, removeTmp, runRealProberReducedEnv, runScript, writeStubProber } from './harness.js';

const SLUG = 'doorway-scan';

/** A prober that does what a real one does: prints, and stamps the state file. */
function stateWritingProber(dir: string, stdout: string): string {
  const file = path.join(dir, 'p.mjs');
  fs.writeFileSync(file, [
    "import fs from 'node:fs';",
    "fs.mkdirSync('.instar/state', { recursive: true });",
    "fs.writeFileSync('.instar/state/doorway-scan.json', JSON.stringify({ lastScanAt: new Date().toISOString() }));",
    `process.stdout.write(${JSON.stringify(stdout)} + JSON.stringify(process.argv.slice(2)));`,
  ].join('\n'));
  return file;
}

async function withStub(p: Parameters<typeof writeStubProber>[2], prepare?: (dir: string) => void) {
  const dir = makeTmp('stub');
  try {
    prepare?.(dir);
    const file = writeStubProber(dir, 'p.mjs', p);
    return await runScript(SLUG, { args: ['--canary', '--prober', file], cwd: dir });
  } finally { removeTmp(dir); }
}

const SCOPE_LINE = 'doorway-scan: scope=free-probes scheduled=true stateFile=x\n';

describe('doorway-scan script', () => {
  proberContractCases(SLUG, SCOPE_LINE, {
    env: (dir) => ({ INSTAR_STATE_DIR: path.join(dir, 'instar') }),
    stubCode: "fs.mkdirSync(process.env.INSTAR_STATE_DIR + '/state', { recursive: true }); fs.writeFileSync(process.env.INSTAR_STATE_DIR + '/state/doorway-scan.json', JSON.stringify({ lastScanAt: new Date().toISOString() }));",
  });

  it('a fresh state file from this run → ok scanned, and only --scope free-probes is passed', async () => {
    const dir = makeTmp('fresh');
    try {
      const file = stateWritingProber(dir, 'doorway-scan: scope=x\n');
      const r = await runScript(SLUG, { args: ['--canary', '--prober', file], cwd: dir });
      expect(r.resultLine).toBe('JOB_RESULT ok scanned ["--scope","free-probes"]');
      expect(r.exitCode).toBe(0);
    } finally { removeTmp(dir); }
  });
  it('MUST-FAIL: exit 0 with its scope line but no state file → failed scan-state-missing', async () => {
    const r = await withStub({ stdout: SCOPE_LINE });
    expect(r.resultLine).toBe('JOB_RESULT failed scan-state-missing');
    expect(r.exitCode).toBe(1);
  });
  it('MUST-FAIL: a state file older than this run → failed scan-state-stale', async () => {
    const r = await withStub({ stdout: SCOPE_LINE }, (dir) => {
      fs.mkdirSync(path.join(dir, '.instar/state'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.instar/state/doorway-scan.json'), JSON.stringify({ lastScanAt: '2026-01-01T00:00:00.000Z' }));
    });
    expect(r.resultLine).toBe('JOB_RESULT failed scan-state-stale');
  });
  it('MUST-FAIL: an unparseable state file → failed scan-state-unreadable', async () => {
    const r = await withStub({ stdout: SCOPE_LINE }, (dir) => {
      fs.mkdirSync(path.join(dir, '.instar/state'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.instar/state/doorway-scan.json'), '{not json');
    });
    expect(r.resultLine).toBe('JOB_RESULT failed scan-state-unreadable');
  });
  it('the no-manifest silent no-op → skipped no-manifest', async () => {
    const r = await withStub({ stdout: 'doorway-scan: no canonical manifest present — nothing to scan (silent no-op).\n' });
    expect(r.resultLine).toBe('JOB_RESULT skipped no-manifest');
  });
  it('exit 0 without the scope line is a failed run', async () => {
    const r = await withStub({ stdout: '' });
    expect(r.resultLine).toBe('JOB_RESULT failed prober-output-malformed: no scope line');
    expect(r.exitCode).toBe(1);
  });
  it('runs the real prober under the reduced env', async () => {
    const r = await runRealProberReducedEnv(SLUG, ['doorway-scan.mjs']);
    expect(r.resultLine).toBe('JOB_RESULT skipped no-manifest');
    expect(r.exitCode).toBe(0);
  });
});
