import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Reporter, { PROGRESS_MAX_FILES, readProgress } from '../../../src/localVerify/unhandledErrorsReporter.js';

// Deadline forensics (throughput brainstorm 2026-11-12 E2): the lane reporter keeps a snapshot
// of the files still running, so a deadline kill can name them.
describe('lane reporter — in-flight progress snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-progress-'));
  let n = 0;
  let out = '';
  beforeEach(() => { out = path.join(dir, `integration-${++n}.progress.json`); });
  const prev = process.env.LOCAL_VERIFY_PROGRESS_FILE;
  afterEach(() => {
    if (prev === undefined) delete process.env.LOCAL_VERIFY_PROGRESS_FILE; else process.env.LOCAL_VERIFY_PROGRESS_FILE = prev;
  });
  const ctx = (tasks: Record<string, object>) => ({ state: { idMap: new Map(Object.entries(tasks)) } });

  it('lists a started file until its file task finishes, then counts it finished', () => {
    process.env.LOCAL_VERIFY_PROGRESS_FILE = out;
    const r = new Reporter();
    r.onInit(ctx({
      f1: { type: 'suite', filepath: '/run/tests/integration/slow.test.ts' },
      t1: { type: 'test', file: { filepath: '/run/tests/integration/slow.test.ts' } },
      f2: { type: 'suite', filepath: '/run/tests/integration/fast.test.ts' },
    }));
    r.onTaskUpdate([['t1', { state: 'run' }, {}], ['f2', { state: 'run' }, {}]]);
    let p = readProgress(fs.readFileSync(out, 'utf8'), '/run', Date.now());
    expect(p?.running.map((x) => x.file).sort()).toEqual(['tests/integration/fast.test.ts', 'tests/integration/slow.test.ts']);
    expect(p?.finishedFiles).toBe(0);
    // The fast file's file task passes; the snapshot is throttled, so force a later write.
    (r as unknown as { lastWrite: number }).lastWrite = 0;
    r.onTaskUpdate([['f2', { state: 'pass' }, {}]]);
    p = readProgress(fs.readFileSync(out, 'utf8'), '/run', Date.now());
    expect(p?.running.map((x) => x.file)).toEqual(['tests/integration/slow.test.ts']);
    expect(p?.finishedFiles).toBe(1);
  });

  it('writes nothing without the env variable, and never throws on unknown task ids', () => {
    delete process.env.LOCAL_VERIFY_PROGRESS_FILE;
    const r = new Reporter();
    r.onInit(ctx({}));
    expect(() => r.onTaskUpdate([['nope', { state: 'run' }, {}], 'garbage'])).not.toThrow();
    expect(fs.existsSync(out)).toBe(false);
  });

  it('readProgress: malformed is null (unknown), and the list is bounded', () => {
    expect(readProgress(null, '/run', 0)).toBeNull();
    expect(readProgress('{', '/run', 0)).toBeNull();
    expect(readProgress(JSON.stringify({ v: 2, running: [], finishedFiles: 0 }), '/run', 0)).toBeNull();
    const many = Array.from({ length: 30 }, (_, i) => ({ file: `/run/tests/x${i}.test.ts`, startedAt: 0 }));
    const p = readProgress(JSON.stringify({ v: 1, writtenAt: 0, finishedFiles: 3, running: many }), '/run', 61_000);
    expect(p?.running).toHaveLength(PROGRESS_MAX_FILES);
    expect(p?.running[0]).toEqual({ file: 'tests/x0.test.ts', seconds: 61 });
  });
});
