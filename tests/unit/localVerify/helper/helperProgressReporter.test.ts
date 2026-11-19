/**
 * Tier-1: the root-owned progress reporter of a slice
 * (src/templates/helper/instar-helper-progress-reporter.mjs; docs/specs/local-verify-borrowed-slices-count.md,
 * E "Progress"). Made-up vitest task trees: a file is reported once, when it has finished, as the
 * entry vitest's own JSON reporter will list for it, so the helper's per-file result from progress
 * equals the one from the final report.
 */
import { describe, expect, it } from 'vitest';
// The reporter is a plain module that runs inside the sandbox; it has no types of its own.
// @ts-expect-error: a shipped .mjs template, imported here as it is
import Reporter, { PROGRESS_LINE_MAX_BYTES, PROGRESS_PREFIX, fileEntry, fileSettled, testsOf } from '../../../../src/templates/helper/instar-helper-progress-reporter.mjs';
import { buildPerFile } from '../../../../src/localVerify/helper/HelperService.js';
import { parseProgressLine } from '../../../../src/localVerify/helper/sandboxDriver.js';
import { samePerFileResult } from '../../../../src/localVerify/helper/helperProtocol.js';
import { readHelperTemplate } from '../../../../src/localVerify/helper/runnerDriverBase.js';

const ROOT = '/srv/slice/0123456789abcdef';
const FILE = 'tests/integration/routes-alive.test.ts';

interface T { id: string; type: string; name: string; mode?: string; suite?: T; tasks?: T[]; filepath?: string; result?: { state?: string; startTime?: number; duration?: number } }

/** A file task with one top-level test, a suite holding a nested suite, a skipped and a to-do test. */
function fileTask(states: { top: string; inner: string; file: string }): T {
  const file: T = { id: 'f', type: 'suite', name: FILE, filepath: `${ROOT}/${FILE}`, tasks: [], result: { state: states.file } };
  const suite: T = { id: 's', type: 'suite', name: 'routes', tasks: [] };
  const nested: T = { id: 'n', type: 'suite', name: 'when alive', suite, tasks: [] };
  const top: T = { id: 't1', type: 'test', name: 'boots', mode: 'run', result: { state: states.top, startTime: 1_000, duration: 40 } };
  const inner: T = { id: 't2', type: 'test', name: 'answers 200', mode: 'run', suite: nested, result: { state: states.inner, startTime: 1_100, duration: 250 } };
  const skipped: T = { id: 't3', type: 'test', name: 'needs a browser', mode: 'skip', suite };
  const todo: T = { id: 't4', type: 'test', name: 'later', mode: 'todo', suite };
  nested.tasks = [inner];
  suite.tasks = [nested, skipped, todo];
  file.tasks = [top, suite];
  return file;
}

function reporterOn(file: T, unhandled: unknown[] = []) {
  const lines: string[] = [];
  const r = new Reporter({ write: (l: string) => lines.push(l) });
  const idMap = new Map<string, T>();
  const walk = (t: T): void => { idMap.set(t.id, t); for (const c of t.tasks ?? []) walk(c); };
  walk(file);
  r.onInit({ state: { idMap, getUnhandledErrors: () => unhandled, getFiles: () => [file] } });
  return { r, lines };
}

/** What vitest's JSON reporter writes for the same file (its own field list), for the final report. */
function finalReport(file: T): string {
  const e = fileEntry(file, 0);
  return JSON.stringify({ testResults: [{ ...e, assertionResults: e.assertionResults.map((a: Record<string, unknown>) => ({ ...a, duration: 1, failureMessages: a.status === 'failed' ? ['AssertionError: boom'] : [], location: undefined, meta: {} })) }] });
}

describe('the progress reporter', () => {
  it('builds a file\'s entry as vitest\'s JSON reporter does: every test in order, ancestor titles, full names, and the status table', () => {
    const e = fileEntry(fileTask({ top: 'pass', inner: 'fail', file: 'fail' }), 500);
    expect(e.name).toBe(`${ROOT}/${FILE}`);
    expect(e.status).toBe('failed');
    expect([e.startTime, e.endTime]).toEqual([1_000, 1_350]);
    expect(e.assertionResults).toEqual([
      { ancestorTitles: [], fullName: 'boots', status: 'passed', title: 'boots', failureMessages: [] },
      { ancestorTitles: ['routes', 'when alive'], fullName: 'routes when alive answers 200', status: 'failed', title: 'answers 200', failureMessages: [] },
      { ancestorTitles: ['routes'], fullName: 'routes needs a browser', status: 'skipped', title: 'needs a browser', failureMessages: [] },
      { ancestorTitles: ['routes'], fullName: 'routes later', status: 'todo', title: 'later', failureMessages: [] },
    ]);
    expect(testsOf(fileTask({ top: 'pass', inner: 'pass', file: 'pass' })).map((t: T) => t.name)).toEqual(['boots', 'answers 200', 'needs a browser', 'later']);
    // A file with no test that ran starts at the run's start.
    expect(fileEntry({ filepath: '/x', tasks: [], result: { state: 'pass' } }, 500)).toMatchObject({ startTime: 500, endTime: 500, status: 'passed', assertionResults: [] });
  });

  it('writes one line per finished file, with the prefix, the entry and the unhandled errors so far', () => {
    const file = fileTask({ top: 'pass', inner: 'pass', file: 'pass' });
    const { r, lines } = reporterOn(file, [new Error('one'), new Error('two')]);
    r.onTaskUpdate([['t1', { state: 'pass' }], ['f', { state: 'pass' }]]);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(`${PROGRESS_PREFIX} `)).toBe(true);
    expect(lines[0].endsWith('\n')).toBe(true);
    const parsed = parseProgressLine(lines[0].trimEnd())!;
    expect(parsed.unhandledErrors).toBe(2);
    // The same file again (another update, or the end of the run) is not written twice.
    r.onTaskUpdate([['f', { state: 'pass' }]]);
    r.onFinished([file]);
    expect(lines).toHaveLength(1);
  });

  it('a file is reported only when it has finished: not while a test still runs or waits, and not on a test\'s own update', () => {
    const running = fileTask({ top: 'pass', inner: 'run', file: 'run' });
    const { r, lines } = reporterOn(running);
    r.onTaskUpdate([['t1', { state: 'pass' }]]);
    r.onTaskUpdate([['f', { state: 'run' }]]);
    expect(lines).toEqual([]);
    expect(fileSettled(running)).toBe(false);
    // The file says it passed but one test has no result yet: still not finished.
    const waiting = fileTask({ top: 'pass', inner: 'pass', file: 'pass' });
    delete (waiting.tasks![1].tasks![0].tasks![0] as T).result;
    expect(fileSettled(waiting)).toBe(false);
    // Skipped and to-do tests never get a result; they do not hold the file back.
    expect(fileSettled(fileTask({ top: 'pass', inner: 'pass', file: 'pass' }))).toBe(true);
    expect(fileSettled(fileTask({ top: 'pass', inner: 'fail', file: 'fail' }))).toBe(true);
    // Now it finishes.
    running.tasks![1].tasks![0].tasks![0].result = { state: 'fail', startTime: 1_100, duration: 9 };
    running.result = { state: 'fail' };
    r.onTaskUpdate([['f', { state: 'fail' }]]);
    expect(lines).toHaveLength(1);
  });

  it('at the end of the run, a file that never reported is written then (a file that failed to load, for example)', () => {
    const broken: T = { id: 'b', type: 'suite', name: 'x', filepath: `${ROOT}/tests/unit/broken.test.ts`, tasks: [], result: { state: 'fail' } };
    const { r, lines } = reporterOn(broken);
    r.onFinished([broken]);
    expect(lines).toHaveLength(1);
    expect(parseProgressLine(lines[0].trimEnd())).not.toBeNull();
    // Without a list, it takes the run's files from vitest's own state.
    const again = reporterOn(broken);
    again.r.onFinished(undefined);
    expect(again.lines).toHaveLength(1);
  });

  it('the helper\'s per-file result from a progress line equals the one from the final report: counts, digest, failed names', () => {
    for (const states of [{ top: 'pass', inner: 'pass', file: 'pass' }, { top: 'pass', inner: 'fail', file: 'fail' }, { top: 'fail', inner: 'fail', file: 'fail' }]) {
      const file = fileTask(states);
      const { r, lines } = reporterOn(file);
      r.onTaskUpdate([['f', { state: states.file }]]);
      const p = parseProgressLine(lines[0].trimEnd())!;
      const fromProgress = buildPerFile([FILE], p.reportText, ROOT, { onlyReported: true }).files[0];
      const fromFinal = buildPerFile([FILE], finalReport(file), ROOT).files[0];
      expect(samePerFileResult(fromProgress, fromFinal), JSON.stringify(states)).toBe(true);
      expect(fromProgress.failedTests).toEqual(fromFinal.failedTests);
      expect(fromProgress).toMatchObject({ file: FILE, tests: 4, skipped: 1, todo: 1 });
    }
  });

  it('a line over the bound is not written at all (never cut); the final report still lists the file', () => {
    const big: T = { id: 'g', type: 'suite', name: 'x', filepath: `${ROOT}/tests/unit/many.test.ts`, tasks: [], result: { state: 'pass' } };
    big.tasks = Array.from({ length: 600 }, (_, i) => ({ id: `t${i}`, type: 'test', name: `case ${i} ${'n'.repeat(120)}`, mode: 'run', result: { state: 'pass', startTime: 1, duration: 1 } }));
    const { r, lines } = reporterOn(big);
    r.onFinished([big]);
    expect(lines).toEqual([]);
    expect(PROGRESS_LINE_MAX_BYTES).toBeLessThan(64 * 1024);
    // Just under it, the line is written and the host reads it.
    big.tasks = big.tasks.slice(0, 100);
    const small = reporterOn(big);
    small.r.onFinished([big]);
    expect(small.lines).toHaveLength(1);
    expect(Buffer.byteLength(small.lines[0])).toBeLessThan(PROGRESS_LINE_MAX_BYTES);
    expect(parseProgressLine(small.lines[0].trimEnd())).not.toBeNull();
  });

  it('writes to standard error and to no file, and loads nothing from the tree or from installed packages', () => {
    const src = readHelperTemplate('instar-helper-progress-reporter.mjs');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['node:fs']);
    expect(src).toContain('fs.writeSync(2, line)');
    expect(src).not.toMatch(/writeFile|appendFile|createWriteStream|renameSync|process\.env/);
  });
});
