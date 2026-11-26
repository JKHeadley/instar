import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ScriptRolloutReport, shiftFlags, type CostComparison } from '../../src/scheduler/ScriptRolloutReport.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/ScriptRolloutReport.test.ts' }); });

const DAY = 86_400_000;
const period = (failures: number[], tokens = 1000) => ({ days: 7, runs: 100, weightedTokens: tokens, failuresPerDay: failures, anomaliesPerDay: [0, 0, 0, 0, 0, 0, 0] });

describe('shiftFlags', () => {
  it('flags a shift beyond 2x the baseline daily SD, both sides of the boundary', () => {
    expect(shiftFlags(period([1, 2, 1, 2, 1, 2, 1]), period([1, 2, 1, 2, 1, 2, 2]))).toEqual([]);
    expect(shiftFlags(period([1, 2, 1, 2, 1, 2, 1]), period([5, 5, 5, 5, 5, 5, 5]))[0]).toContain('worth a look');
  });
});

describe('ScriptRolloutReport', () => {
  it('sends once, 7 days after the first script run, with before/after and one raw run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-')); dirs.push(root);
    let now = Date.parse('2026-10-20T00:00:00Z');
    const posts: string[] = [];
    let failPost = false;
    const cmp: CostComparison = { before: period([0, 0, 0, 0, 0, 0, 0], 7_000_000), after: period([3, 3, 3, 3, 3, 3, 3], 7_000) };
    const r = new ScriptRolloutReport({
      listScriptJobs: () => [{ slug: 'health-check' }] as never,
      firstScriptRunAt: () => '2026-10-20T00:00:00Z',
      costReportFor: async () => cmp,
      getLocalRunsForSlug: () => [{ runId: 'hc-1', result: 'success', startedAt: '2026-10-26T00:00:00Z', outputSummary: 'JOB_RESULT ok all clear' }],
      postUpdate: async (t) => { if (failPost) throw new Error('telegram down'); posts.push(t); },
      machineId: 'm-1', stateDir: root, logsDir: path.join(root, 'logs'), now: () => now,
    });
    expect(await r.tick()).toEqual([]);
    now += 7 * DAY + 1;
    failPost = true;
    expect(await r.tick()).toEqual([]);
    failPost = false;
    expect(await r.tick()).toEqual(['health-check']);
    expect(posts[0]).toContain('before: 100 runs, about 1,000,000 weighted tokens a day');
    expect(posts[0]).toContain('not a verdict');
    expect(posts[0]).toContain('JOB_RESULT ok all clear');
    expect(await r.tick()).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'logs', 'script-rollout-report.jsonl'), 'utf-8')).toContain('health-check');
  });
});
