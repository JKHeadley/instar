import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { runFocusedPreflight } from '../../../src/localVerify/runFocusedPreflight.js';
import type { OrchestratorSeams } from '../../../src/localVerify/orchestrator.js';

const root = '/tmp/lv-preflight-run';
const file = `${root}/tests/unit/example.test.ts`;
const goodList = JSON.stringify([{ file, name: 'works' }]);
const filesList = JSON.stringify([{ file }]);
const report = (status: 'passed' | 'failed') => JSON.stringify({ testResults: [{ name: file, status, assertionResults: [{ status }] }] });
const noErrors = JSON.stringify({ v: 1, unhandledErrors: 0, messages: [] });

function harness(runs: Array<{ status: number | null; json: string; errors?: string | null; quiescent?: boolean; deadlineKilled?: boolean; signal?: NodeJS.Signals | null; aborted?: boolean }>) {
  const files = new Map<string, string>();
  const calls: string[][] = [];
  let now = 0;
  const seams = {
    now: () => now,
    exec: async (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; isolatedGroup?: boolean; deadlineMs: number }) => {
      calls.push(args);
      expect(opts.isolatedGroup).toBe(true);
      expect(opts.deadlineMs).toBeLessThanOrEqual(80_000);
      const next = runs.shift()!;
      const output = args.find((a) => a.startsWith('--json=') || a.startsWith('--outputFile.json='))!.split('=')[1];
      files.set(output, next.json);
      if (opts.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE && next.errors !== null) files.set(opts.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE, next.errors ?? noErrors);
      now += 1000;
      return { status: next.status, signal: next.signal ?? null, aborted: next.aborted ?? false,
        stdout: '', stderr: '', deadlineKilled: next.deadlineKilled ?? false, pid: 12, quiescent: next.quiescent ?? true };
    },
    fs: {
      mkdtemp: (prefix: string) => `/tmp/${prefix}${Math.random()}`,
      readFile: (p: string) => files.get(p) ?? null,
      removeTree: async (p: string) => { files.delete(p); },
    },
  } as unknown as OrchestratorSeams;
  const run = (mode: 'observe' | 'enforce', startedAtMs?: number) => runFocusedPreflight({ seams, runDir: root, reportsDir: path.join(root, 'reports'), binDir: '/tmp/bin', baseEnv: {}, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mode, startedAtMs, changedFiles: 1, reporter: '/trusted/reporter.js', activeRemainingMs: () => 120_000, onPid: () => undefined });
  return { run, calls };
}

describe('focused verifier preflight', () => {
  it('records stable repeated red without granting green', async () => {
    const h = harness([{ status: 0, json: filesList }, { status: 0, json: goodList }, { status: 1, json: report('failed') }, { status: 1, json: report('failed') }]);
    const r = await h.run('enforce');
    expect(r).toMatchObject({ outcome: 'red', reason: 'preflight-red', repeatedFailedFile: 'tests/unit/example.test.ts', selectedCases: 1 });
    expect(h.calls).toHaveLength(4);
  });
  it('keeps an observed stable red diagnostic only', async () => {
    const h = harness([{ status: 0, json: filesList }, { status: 0, json: goodList }, { status: 1, json: report('failed') }, { status: 1, json: report('failed') }]);
    expect(await h.run('observe')).toMatchObject({ outcome: 'red', reason: 'observed-stable-red' });
  });
  it('cannot infer stable red when the trusted reporter is missing', async () => {
    const h = harness([{ status: 0, json: filesList }, { status: 0, json: goodList }, { status: 1, json: report('failed'), errors: null }]);
    expect(await h.run('enforce')).toMatchObject({ outcome: 'error', reason: 'first-unhandled-unknown-or-nonzero' });
    expect(h.calls).toHaveLength(3);
  });
  it('treats a failed first run followed by green as diagnostic pass', async () => {
    const h = harness([{ status: 0, json: filesList }, { status: 0, json: goodList }, { status: 1, json: report('failed') }, { status: 0, json: report('passed') }]);
    expect(await h.run('enforce')).toMatchObject({ outcome: 'pass', reason: 'retry-green' });
  });
  it('does not establish early red from a signaled first run or retry, even with complete reports', async () => {
    const first = harness([{ status: 0, json: filesList }, { status: 0, json: goodList },
      { status: null, signal: 'SIGTERM', json: report('failed') }]);
    expect(await first.run('enforce')).toMatchObject({ outcome: 'error', reason: 'first-run-interrupted' });
    const retry = harness([{ status: 0, json: filesList }, { status: 0, json: goodList },
      { status: 1, json: report('failed') }, { status: null, aborted: true, json: report('failed') }]);
    expect(await retry.run('enforce')).toMatchObject({ outcome: 'error', reason: 'retry-interrupted' });
  });
  it('skips on selected-file breadth before collecting cases or running tests', async () => {
    const wide = JSON.stringify(Array.from({ length: 6 }, (_, n) => ({ file: `${root}/tests/unit/f${n}.test.ts` })));
    const h = harness([{ status: 0, json: wide }]);
    expect(await h.run('enforce')).toMatchObject({ outcome: 'skip', reason: 'selected-files-cap' });
    expect(h.calls).toHaveLength(1);
  });
  it('treats an unhandled error, timed-out attempt, or unknown process cleanup as no early-red proof', async () => {
    const unhandled = harness([{ status: 0, json: filesList }, { status: 0, json: goodList },
      { status: 1, json: report('failed'), errors: JSON.stringify({ v: 1, unhandledErrors: 1, messages: [] }) }]);
    expect(await unhandled.run('enforce')).toMatchObject({ outcome: 'error', reason: 'first-unhandled-unknown-or-nonzero' });
    const timed = harness([{ status: 0, json: filesList }, { status: 0, json: goodList },
      { status: 1, json: report('failed'), deadlineKilled: true }]);
    expect(await timed.run('enforce')).toMatchObject({ outcome: 'timeout', reason: 'first-run-timeout' });
    const uncontained = harness([{ status: 0, json: filesList, quiescent: false }]);
    await expect(uncontained.run('enforce')).rejects.toThrow('process group did not exit');
  });
  it('charges exact-base selection time against the 90-second cap before starting Vitest', async () => {
    const h = harness([]);
    expect(await h.run('enforce', -90_001)).toMatchObject({ outcome: 'timeout', reason: 'aggregate-timeout', elapsedMs: 90_000 });
    expect(h.calls).toHaveLength(0);
  });
});
