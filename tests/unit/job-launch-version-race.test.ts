/**
 * T5 (frozen acceptance list, step3/acceptance-tests.md): the version patch never clobbers a
 * completion, and recordStart never waits for the version (spec job-launch-intent-record §4
 * "Never waits"; step-2 round-3 defect).
 * Red on main: JobRunHistory has no recordLaunchVersion, and the scheduler neither carries
 * `launch` nor probes the version.
 *
 * Driven through JobScheduler — the real seam that calls recordStart after spawn — with a
 * stubbed SessionManager whose version probe is a deferred promise the test settles by hand.
 *
 * Contract fixed here:
 *   - SessionManager.probeLaunchVersion(session): Promise<string | 'unknown'> probes the binary that
 *     launched this session (the T4 reader). JobScheduler calls it after recordStart, never before,
 *     and on settle calls runHistory.recordLaunchVersion(runId, version).
 *   - recordLaunchVersion copies the LATEST row for the run and changes only launch.cliVersion;
 *     it appends nothing when the latest row has no `launch` (shed by the cap, or never set).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { JobDefinition } from '../../src/core/types.js';

type Launch = { cliVersion: string; requested: { thinkingMode?: string }; applied: Array<Record<string, unknown>>; dropped: unknown[] };
type Row = Record<string, unknown> & { runId: string; result: string; launch?: Launch; truncated?: boolean };

const LAUNCH: Launch = { cliVersion: 'unknown', requested: { thinkingMode: 'low' }, applied: [{ feature: 'thinkingMode', requestedValue: 'low', value: 'low', channel: 'argv' }], dropped: [] };
/** A launch that cannot fit the 2,048-byte row cap: the cap must shed it. */
const HUGE_LAUNCH: Launch = { ...LAUNCH, applied: Array.from({ length: 8 }, () => ({ feature: 'thinkingMode', requestedValue: 'low', value: 'v'.repeat(400), channel: 'argv' })) };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 30));

const JOB: JobDefinition = {
  slug: 'think-low', name: 'Think low', description: 'd', schedule: '0 0 1 1 *', priority: 'high',
  expectedDurationMinutes: 1, model: 'opus', enabled: true, execute: { type: 'prompt', value: 'Look over the open bugs.' },
  thinkingMode: 'low',
} as JobDefinition;

describe('T5 scheduler: recordStart does not wait; the probe patches only cliVersion', () => {
  let project: TempProject;
  let mockSM: MockSessionManager & { probeLaunchVersion?: (s: unknown) => Promise<string> };
  let scheduler: JobScheduler;
  let probe: ReturnType<typeof deferred<string>>;
  let launchForSpawn: Launch;
  let rowsAtProbeCall: number[];

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    probe = deferred<string>();
    launchForSpawn = LAUNCH;
    const realSpawn = mockSM.spawnSession;
    mockSM.spawnSession = async (opts) => {
      const s = await realSpawn(opts);
      (s as unknown as { launch: Launch; framework: string }).launch = structuredClone(launchForSpawn);
      (s as unknown as { framework: string }).framework = 'claude-code';
      return s;
    };
    rowsAtProbeCall = [];
    mockSM.probeLaunchVersion = vi.fn(() => {
      // How many run rows existed at the moment the probe was asked for: the start row must already be there.
      rowsAtProbeCall.push(scheduler.getRunHistory().query({ slug: JOB.slug }).runs.length);
      return probe.promise;
    });
    const jobsFile = path.join(project.stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify([JOB], null, 2));
    project.state.saveJobState({ slug: JOB.slug, lastRun: new Date().toISOString(), lastResult: 'success', runCount: 1, consecutiveFailures: 0 });
    scheduler = new JobScheduler(
      { jobsFile, enabled: true, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      mockSM as never, project.state, project.stateDir,
    );
    scheduler.start();
  });
  afterEach(() => { scheduler?.stop(); project.cleanup(); vi.restoreAllMocks(); });

  const rows = () => scheduler.getRunHistory().query({ slug: JOB.slug }).runs as unknown as Row[];
  async function startRun() {
    await scheduler.triggerJob(JOB.slug, 'test');
    await flush();
    expect(rows(), 'no run row after the spawn resolved').toHaveLength(1);
    return mockSM._sessions[mockSM._sessions.length - 1];
  }
  async function complete(session: ReturnType<typeof mockSM._sessions.at> & object) {
    session.status = 'completed';
    project.state.saveSession(session);
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);
  }

  it('the start row lands with cliVersion unknown while the probe is still pending', async () => {
    await startRun();
    expect(mockSM.probeLaunchVersion, 'the scheduler never asked for the launched version').toHaveBeenCalledTimes(1);
    expect(rowsAtProbeCall, 'the probe was requested before recordStart wrote the start row').toEqual([1]);
    const [row] = rows();
    expect(row.result).toBe('pending');
    expect(row.launch, 'the start row has no launch record').toEqual(LAUNCH);
  });

  it('completion lands BEFORE the probe settles; afterwards the whole row is the completed row with only cliVersion changed', async () => {
    const session = await startRun();
    await complete(session!);
    const [completed] = rows();
    expect(completed.result, 'the completion did not land while the probe was pending').toBe('success');
    expect(completed.launch?.cliVersion).toBe('unknown');

    probe.resolve('2.1.322');
    await flush();
    const [latest] = rows();
    expect(latest).toEqual({ ...completed, launch: { ...completed.launch!, cliVersion: '2.1.322' } });
  });

  it('probe settles first, then completion: the completion keeps the patched version', async () => {
    const session = await startRun();
    const [started] = rows();
    probe.resolve('2.1.322');
    await flush();
    const [patched] = rows();
    expect(patched).toEqual({ ...started, launch: { ...started.launch!, cliVersion: '2.1.322' } });
    await complete(session!);
    const [done] = rows();
    expect(done.result).toBe('success');
    expect(done.launch).toEqual({ ...LAUNCH, cliVersion: '2.1.322' });
  });

  it('a cap-shed launch: the row is truncated with no launch, and the settled probe is a no-op', async () => {
    launchForSpawn = HUGE_LAUNCH;
    const session = await startRun();
    const [started] = rows();
    expect(started.truncated, 'the oversized launch did not trigger the row cap').toBe(true);
    expect(started.launch).toBeUndefined();
    await complete(session!);
    const [completed] = rows();
    const linesBefore = fs.readFileSync(path.join(project.stateDir, 'ledger', 'job-runs.jsonl'), 'utf-8').split('\n').filter(Boolean).length;
    probe.resolve('2.1.322');
    await flush();
    const [latest] = rows();
    expect(latest).toEqual(completed);
    expect(latest.launch).toBeUndefined();
    const linesAfter = fs.readFileSync(path.join(project.stateDir, 'ledger', 'job-runs.jsonl'), 'utf-8').split('\n').filter(Boolean).length;
    expect(linesAfter, 'the no-op patch appended a row').toBe(linesBefore);
  });
});

describe('T5 JobRunHistory.recordLaunchVersion', () => {
  let dir: string;
  let h: JobRunHistory;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-launch-race-'));
    fs.mkdirSync(path.join(dir, 'ledger'), { recursive: true });
    h = new JobRunHistory(dir);
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-launch-version-race.test.ts:cleanup' }));
  const patch = (id: string, v: string) => (h as unknown as { recordLaunchVersion(id: string, v: string): void }).recordLaunchVersion(id, v);

  it('copies the latest row whole (completion and reflection kept) and changes only cliVersion', () => {
    const runId = h.recordStart({ slug: 'j', sessionId: 's', trigger: 'scheduled', launch: LAUNCH } as never);
    h.recordCompletion({ runId, result: 'success', outputSummary: 'done' });
    h.recordReflection(runId, { summary: 'ok', strengths: [], improvements: [], deviationAnalysis: null, purposeDrift: null, suggestedChanges: [] });
    const before = h.findRun(runId) as unknown as Row;
    expect(before.launch, 'recordStart dropped launch').toEqual(LAUNCH);
    patch(runId, '2.1.322');
    expect(h.findRun(runId)).toEqual({ ...before, launch: { ...LAUNCH, cliVersion: '2.1.322' } });
  });

  it('no launch on the row: the patch is a no-op (never invents a record)', () => {
    const runId = h.recordStart({ slug: 'j', sessionId: 's', trigger: 'scheduled' });
    const before = h.findRun(runId);
    patch(runId, '2.1.322');
    expect(h.findRun(runId)).toEqual(before);
  });
});
