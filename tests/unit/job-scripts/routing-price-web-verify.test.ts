import { describe, expect, it } from 'vitest';
import { makeTmp, proberContractCases, removeTmp, runRealProberReducedEnv, runScript, writeStubProber } from './harness.js';

const SLUG = 'routing-price-web-verify';
const GOOD = JSON.stringify({ added: 1, totalObserved: 9, out: 'x', notes: ['openrouter-api: 3 tracked model price(s) probed', 'b'] }, null, 2) + '\n';

async function withStub(p: Parameters<typeof writeStubProber>[2]) {
  const dir = makeTmp('stub');
  try {
    const file = writeStubProber(dir, 'p.mjs', p);
    return await runScript(SLUG, { args: ['--canary', '--prober', file], cwd: dir });
  } finally { removeTmp(dir); }
}

describe('routing-price-web-verify script', () => {
  proberContractCases(SLUG, GOOD);

  it('exit 0 with a well-formed JSON result → ok', async () => {
    const r = await withStub({ stdout: GOOD });
    expect(r.resultLine).toBe('JOB_RESULT ok added=1 totalObserved=9 notes=2');
    expect(r.exitCode).toBe(0);
  });
  it('exit 0 without the JSON result → failed prober-output-malformed', async () => {
    for (const stdout of ['not json', JSON.stringify({ added: 'x', totalObserved: 1, notes: [] }), JSON.stringify({ dryRun: true, wouldAdd: [] })]) {
      const r = await withStub({ stdout });
      expect(r.resultLine).toBe('JOB_RESULT failed prober-output-malformed: expected added, totalObserved, notes');
      expect(r.exitCode).toBe(1);
    }
  });
  it('exit 2 (refused scope) → failed', async () => {
    const r = await withStub({ exitCode: 2, stderr: "[routing-price-refresh] scope 'x' requires a positive --budget-usd\n" });
    expect(r.resultLine).toMatch(/^JOB_RESULT failed prober-exit-2 /);
  });
  it('passes the fixed scope arguments to the prober', async () => {
    const dir = makeTmp('args');
    try {
      const fs = await import('node:fs');
      const file = `${dir}/p.mjs`;
      fs.writeFileSync(file, `process.stderr.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 9;`);
      const a = await runScript(SLUG, { args: ['--canary', '--prober', file], cwd: dir });
      expect(a.resultLine).toBe('JOB_RESULT failed prober-exit-9 ["--scope","+web-verify","--plausibility-baseline","scripts/routing-prices.manifest.json"]');
    } finally { removeTmp(dir); }
  });
  it('runs the real prober under the reduced env', async () => {
    const r = await runRealProberReducedEnv(SLUG, ['routing-price-refresh.mjs', 'routing-prices.manifest.json']);
    // The prober is fail-safe per door: an unreachable network is an honest note, still exit 0.
    expect(r.resultLine).toMatch(/^JOB_RESULT ok added=\d+ totalObserved=\d+ notes=\d+$/);
    expect(r.exitCode).toBe(0);
  }, 90_000);
});
