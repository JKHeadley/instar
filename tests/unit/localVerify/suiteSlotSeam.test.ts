// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The real suite-slot seam (spec local-verify-merge-authority.md "Parallel lanes"):
 * the lane phase takes ONE full-suite slot of the host test-runner bound, and a lane
 * process started by this process sees itself nested under that slot, so its own
 * request does not queue behind its sibling lanes. Uses a temp rendezvous dir
 * (INSTAR_HOST_TEST_BASE_DIR, the bound's internal test seam), never the host's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

let base = '';
const savedBase = process.env.INSTAR_HOST_TEST_BASE_DIR;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-slot-'));
  process.env.INSTAR_HOST_TEST_BASE_DIR = base;
});
afterAll(() => {
  if (savedBase === undefined) delete process.env.INSTAR_HOST_TEST_BASE_DIR;
  else process.env.INSTAR_HOST_TEST_BASE_DIR = savedBase;
  SafeFsExecutor.safeRmSync(base, { recursive: true, force: true, operation: 'tests/unit/localVerify/suiteSlotSeam.test.ts:cleanup' });
});

describe('realSeams().holdSuiteSlot', () => {
  it('claims priority only while seeking the lane slot, then clears it on acquisition', async () => {
    const { realSeams } = await import('../../../src/localVerify/orchestratorSeams.js');
    const { getHostTestRunnerSemaphore } = await import('../../../src/core/hostTestRunnerSemaphore.js');
    const sem = getHostTestRunnerSemaphore();
    const ordinary = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(ordinary.kind).toBe('acquired');
    if (ordinary.kind !== 'acquired') return;
    const seams = realSeams(() => {}, path.join(base, 'verify'));
    const waiting = seams.holdSuiteSlot!();
    expect(sem.hasMergeGatePriority()).toBe(true);
    sem.release(ordinary.id);
    const release = await waiting;
    expect(typeof release).toBe('function');
    expect(sem.hasMergeGatePriority()).toBe(false);
    (release as () => void)();
  }, 15_000);

  it('holds one suite slot as this process; a child process is nested under it; release frees it', async () => {
    // Imported after the env is set: the bound's singleton reads its base dir once.
    const { realSeams } = await import('../../../src/localVerify/orchestratorSeams.js');
    const { getHostTestRunnerSemaphore } = await import('../../../src/core/hostTestRunnerSemaphore.js');
    const logs: Array<Record<string, unknown>> = [];
    const seams = realSeams((e) => { logs.push(e); }, path.join(base, 'verify'));
    const release = await seams.holdSuiteSlot!();
    expect(typeof release).toBe('function');
    expect(getHostTestRunnerSemaphore().paths.baseDir).toBe(base);
    const holders = getHostTestRunnerSemaphore().status().liveHolders;
    expect(holders.map((h) => h.pid)).toEqual([process.pid]);

    // A child of this process (as each lane's vitest is) finds itself nested: its
    // ancestry is [itself, this process, ...]. The ancestry walk itself is the bound's own
    // tested code; this pins that the row this seam writes is one it recognises.
    const { checkNestedUnderHolder } = await import('../../../src/core/testRunnerRunClassifier.js');
    const rows = JSON.parse(fs.readFileSync(getHostTestRunnerSemaphore().paths.holders, 'utf-8')).holders;
    expect(checkNestedUnderHolder(rows, 'suite', { ancestors: [999_999, process.pid, process.ppid] }))
      .toMatchObject({ nested: true, shelteringPid: process.pid });
    // An unrelated process is not nested.
    expect(checkNestedUnderHolder(rows, 'suite', { ancestors: [999_999, 1] }).nested).toBe(false);

    (release as () => void)();
    expect(getHostTestRunnerSemaphore().status().liveHolders).toEqual([]);
    expect(logs.some((l) => l.event === 'suite-slot' && l.outcome === 'acquired')).toBe(true);
  });
});
