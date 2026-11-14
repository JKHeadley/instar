import { describe, expect, it } from 'vitest';
import { makeTmp, proberContractCases, removeTmp, runRealProberReducedEnv, runScript, writeStubProber } from './harness.js';

const SLUG = 'stall-matrix-live-check';

async function withStub(p: Parameters<typeof writeStubProber>[2]) {
  const dir = makeTmp('stub');
  try {
    const file = writeStubProber(dir, 'p.mjs', p);
    return await runScript(SLUG, { args: ['--canary', '--prober', file], cwd: dir });
  } finally { removeTmp(dir); }
}

describe('stall-matrix-live-check script', () => {
  proberContractCases(SLUG, 'stall-matrix-live-check: matrices=2 findings=0 mints=0/0 warnings=0\n');

  it('exit 0 → ok with the checker summary', async () => {
    const r = await withStub({ stdout: 'stall-matrix-live-check: matrices=2 findings=1 mints=0/0 warnings=0\n' });
    expect(r.resultLine).toBe('JOB_RESULT ok matrices=2 findings=1 mints=0/0 warnings=0');
    expect(r.exitCode).toBe(0);
  });
  it('no docs/frameworks tree → skipped no-matrices', async () => {
    const r = await withStub({ stdout: 'stall-matrix-live-check: no docs/frameworks tree present — nothing to check (silent no-op).\n' });
    expect(r.resultLine).toBe('JOB_RESULT skipped no-matrices');
  });
  it('exit 2 ledger-unreachable → skipped ledger-unreachable', async () => {
    const r = await withStub({ exitCode: 2, stderr: 'stall-matrix-live-check: ledger-unreachable — the local server is not answering\n' });
    expect(r.resultLine).toBe('JOB_RESULT skipped ledger-unreachable');
    expect(r.exitCode).toBe(0);
  });
  it('exit 2 fatal (not ledger-unreachable) → failed', async () => {
    const r = await withStub({ exitCode: 2, stderr: 'stall-matrix-live-check: fatal: bad yaml\n' });
    expect(r.resultLine).toBe('JOB_RESULT failed prober-exit-2 stall-matrix-live-check: fatal: bad yaml');
    expect(r.exitCode).toBe(1);
  });
  it('exit 0 without the summary line → failed prober-output-malformed', async () => {
    const r = await withStub({ stdout: '' });
    expect(r.resultLine).toBe('JOB_RESULT failed prober-output-malformed: no summary line');
    expect(r.exitCode).toBe(1);
  });
  it('runs the real checker under the reduced env', async () => {
    const r = await runRealProberReducedEnv(SLUG, ['stall-matrix-live-check.mjs']);
    expect(r.resultLine).toBe('JOB_RESULT skipped no-matrices');
    expect(r.exitCode).toBe(0);
  });
});
