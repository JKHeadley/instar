import { describe, expect, it } from 'vitest';
import { makeTmp, proberContractCases, removeTmp, runRealProberReducedEnv, runScript, writeStubProber } from './harness.js';

const SLUG = 'doorway-scan';

async function withStub(p: Parameters<typeof writeStubProber>[2]) {
  const dir = makeTmp('stub');
  try {
    const file = writeStubProber(dir, 'p.mjs', p);
    return await runScript(SLUG, { args: ['--canary', '--prober', file], cwd: dir });
  } finally { removeTmp(dir); }
}

describe('doorway-scan script', () => {
  proberContractCases(SLUG, 'doorway-scan: scope=free-probes scheduled=true stateFile=x\n');

  it('exit 0 → ok scanned (last stdout line)', async () => {
    const r = await withStub({ stdout: 'doorway-scan: scope=free-probes scheduled=true\ndoorway-scan: done\n' });
    expect(r.resultLine).toBe('JOB_RESULT ok scanned doorway-scan: done');
    expect(r.exitCode).toBe(0);
  });
  it('the no-manifest silent no-op → skipped no-manifest', async () => {
    const r = await withStub({ stdout: 'doorway-scan: no canonical manifest present — nothing to scan (silent no-op).\n' });
    expect(r.resultLine).toBe('JOB_RESULT skipped no-manifest');
  });
  it('a fatal (non-gating) exit 0 → skipped prober-fatal (the prober\'s own breaker escalates)', async () => {
    const r = await withStub({ stderr: 'doorway-scan: fatal (non-gating): ENOENT\n' });
    expect(r.resultLine).toBe('JOB_RESULT skipped prober-fatal doorway-scan: fatal (non-gating): ENOENT');
    expect(r.exitCode).toBe(0);
  });
  it('exit 0 without the scope line is a failed run; passes only --scope free-probes', async () => {
    const r = await withStub({ stdout: '' });
    expect(r.resultLine).toBe('JOB_RESULT failed prober-output-malformed: no scope line');
    expect(r.exitCode).toBe(1);
    const dir = makeTmp('args');
    try {
      const fs = await import('node:fs');
      const file = `${dir}/p.mjs`;
      fs.writeFileSync(file, 'process.stdout.write("doorway-scan: scope=x\\n" + JSON.stringify(process.argv.slice(2)))');
      const a = await runScript(SLUG, { args: ['--canary', '--prober', file], cwd: dir });
      expect(a.resultLine).toBe('JOB_RESULT ok scanned ["--scope","free-probes"]');
    } finally { removeTmp(dir); }
  });
  it('runs the real prober under the reduced env', async () => {
    const r = await runRealProberReducedEnv(SLUG, ['doorway-scan.mjs']);
    expect(r.resultLine).toBe('JOB_RESULT skipped no-manifest');
    expect(r.exitCode).toBe(0);
  });
});
