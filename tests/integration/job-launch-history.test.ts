/**
 * T9 (frozen acceptance list, step3/acceptance-tests.md): scheduler → GET /jobs/:slug/history
 * carries the launch record (spec job-launch-intent-record §3, §4, acceptance criterion 3, D5).
 *   - `thinkingMode: low` on claude-code shows `launch.applied`.
 *   - the same job on a (stubbed) gemini-cli agent shows `launch.dropped: not-supported`.
 *   - script, triage and spawn-error rows carry no `launch`.
 *   - unknown enum values inside `launch` are tolerated by the route.
 *   - feature evidence (dev-rung graduation input, read by T12): exactly one `jobs.launchIntent`
 *     `fired` row per main-path run, with or without the field, whose context.runId is that row's
 *     runId; none for script, triage or spawn-error rows. When the spawned session returns no
 *     `launch`, that run still gets its one `fired` row (every main-path run does) PLUS one `error`
 *     row, both carrying its runId.
 *   - D4 via JobModelRoute: an unusable job pin falls back to the default engine, and `launch`
 *     describes the engine that actually launched.
 * Red on main: no `launch` in the history.
 *
 * Harness: real SessionManager + JobScheduler + AgentServer (supertest). Only the tmux binary is
 * faked (execFileSync/execFile calls whose command is FAKE_TMUX); every other child_process call
 * is the real one, so script jobs really run and the version probe really fails (→ 'unknown').
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FAKE_TMUX = '/nonexistent/fake-tmux-for-job-launch-history';
const mockTmuxSessions = new Set<string>();
const newSessionCalls: string[][] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const fakeSync = (args: string[]): string => {
    if (args[0] === 'has-session') {
      const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
      if (!mockTmuxSessions.has(target)) throw new Error(`session not found: ${target}`);
      return '';
    }
    if (args[0] === 'new-session') {
      newSessionCalls.push([...args]);
      const name = args[args.indexOf('-s') + 1];
      if (name && name.includes('spawn-fail')) throw new Error('tmux new-session failed (test)');
      if (name) mockTmuxSessions.add(name);
      return '';
    }
    if (args[0] === 'kill-session') { mockTmuxSessions.delete(args[2]?.replace(/^=/, '').replace(/:$/, '')); return ''; }
    if (args[0] === 'display-message') return 'claude||claude';
    return '';
  };
  return {
    ...real,
    default: real,
    execFileSync: vi.fn((cmd: string, args?: readonly string[], opts?: unknown) =>
      cmd === FAKE_TMUX ? fakeSync([...(args ?? [])]) : (real.execFileSync as (...a: unknown[]) => unknown)(cmd, args, opts)),
    execFile: vi.fn((cmd: string, args: readonly string[], opts: unknown, cb?: (e: Error | null, out: unknown, err?: unknown) => void) => {
      if (cmd !== FAKE_TMUX) return (real.execFile as (...a: unknown[]) => unknown)(cmd, args, opts, cb);
      if (typeof opts === 'function') cb = opts as typeof cb;
      try { const out = fakeSync([...args]); cb?.(null, { stdout: out, stderr: '' }, ''); } catch (e) { cb?.(e as Error, { stdout: '', stderr: '' }, ''); }
      return undefined;
    }),
  };
});

import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeatureEvidenceLog, setFeatureEvidenceLog, FEATURE_EVIDENCE_FILE } from '../../src/monitoring/FeatureEvidenceLog.js';
import type { InstarConfig, JobDefinition } from '../../src/core/types.js';

const AUTH = 'job-launch-history-token';
type Launch = { cliVersion: string; requested: { thinkingMode?: string }; applied: Array<Record<string, unknown>>; dropped: Array<Record<string, unknown>>; omitted?: number };
type Run = { runId: string; slug: string; result: string; framework?: string; model?: string; origin?: string; trigger?: string; launch?: Launch };

const job = (slug: string, extra: Partial<JobDefinition> & Record<string, unknown> = {}): JobDefinition => ({
  slug, name: slug, description: `${slug} job`, schedule: '0 0 1 1 *', priority: 'high', expectedDurationMinutes: 1,
  model: 'opus', enabled: true, execute: { type: 'prompt', value: 'Look over the open bugs.' }, ...extra,
} as JobDefinition);

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await pred()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('waitFor: condition not met');
}

function makeHarness(framework: 'claude-code' | 'gemini-cli', jobs: JobDefinition[]) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `job-launch-history-${framework}-`));
  const stateDir = path.join(projectDir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs', 'ledger']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  const jobsFile = path.join(stateDir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
  const state = new StateManager(stateDir);
  for (const j of jobs) state.saveJobState({ slug: j.slug, lastRun: new Date().toISOString(), lastResult: 'success', runCount: 1, consecutiveFailures: 0 });
  // The engine binary does not exist: spawn goes through the fake tmux; the version probe fails → 'unknown'.
  const bin = path.join(projectDir, 'no-such-bin', framework === 'claude-code' ? 'claude' : 'gemini');
  const sessionsCfg = {
    tmuxPath: FAKE_TMUX, claudePath: bin, projectDir, maxSessions: 5, protectedSessions: [], completionPatterns: ['Session ended'],
    framework, frameworkBinaryPaths: { [framework]: bin },
  };
  const sessionManager = new SessionManager(sessionsCfg as never, state);
  // The process-wide feature-evidence log, wired the way server boot wires it.
  setFeatureEvidenceLog(new FeatureEvidenceLog({ projectDir, machine: 'test-machine', instarVersion: '0.0.0-test' }));
  const evidence = (): Array<{ featureId: string; kind: string; context?: Record<string, unknown> }> => {
    const f = path.join(projectDir, FEATURE_EVIDENCE_FILE);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const launchIntent = () => evidence().filter((e) => e.featureId === 'jobs.launchIntent');
  const schedCfg = { jobsFile, enabled: true, maxParallelJobs: 3, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } };
  const scheduler = new JobScheduler(schedCfg, sessionManager, state, stateDir);
  scheduler.start();
  const config = {
    projectName: 'job-launch-history', projectDir, stateDir, port: 0, authToken: AUTH, framework,
    sessions: sessionsCfg, scheduler: schedCfg, users: [], messaging: [],
    monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
  } as unknown as InstarConfig;
  const server = new AgentServer({ config, sessionManager, state, scheduler });
  const app = server.getApp();
  const history = async (slug: string): Promise<Run[]> => {
    const res = await request(app).get(`/jobs/${slug}/history`).set('Authorization', `Bearer ${AUTH}`).set('Connection', 'close');
    expect(res.status).toBe(200);
    return res.body.runs as Run[];
  };
  const trigger = async (slug: string) => {
    const res = await request(app).post(`/jobs/${slug}/trigger`).set('Authorization', `Bearer ${AUTH}`).set('Connection', 'close').send({ reason: 'job-launch-history-test' });
    expect(res.status).toBe(200);
  };
  const cleanup = async () => {
    scheduler.stop();
    sessionManager.stopMonitoring();
    setFeatureEvidenceLog(null);
    await server.stop();
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/job-launch-history.test.ts:cleanup' });
  };
  return { projectDir, stateDir, scheduler, sessionManager, history, trigger, cleanup, launchIntent };
}

describe('T9 launch record in GET /jobs/:slug/history', () => {
  let h: ReturnType<typeof makeHarness> | undefined;
  beforeEach(() => { mockTmuxSessions.clear(); newSessionCalls.length = 0; });
  afterEach(async () => { await h?.cleanup(); h = undefined; });

  it('claude-code + thinkingMode low → launch.applied (argv --effort low), cliVersion known or "unknown"', async () => {
    h = makeHarness('claude-code', [job('think-low', { thinkingMode: 'low' })]);
    await h.trigger('think-low');
    await waitFor(async () => (await h!.history('think-low')).length > 0);
    const [run] = await h.history('think-low');
    expect(run.framework).toBe('claude-code');
    expect(run.launch, 'history row has no launch record').toBeDefined();
    expect(run.launch!.requested).toEqual({ thinkingMode: 'low' });
    expect(run.launch!.applied).toEqual([{ feature: 'thinkingMode', requestedValue: 'low', value: 'low', channel: 'argv' }]);
    expect(run.launch!.dropped).toEqual([]);
    expect(typeof run.launch!.cliVersion).toBe('string');
    expect('framework' in run.launch!, 'launch must not duplicate the row framework (D5)').toBe(false);
    expect('model' in run.launch!, 'launch must not duplicate the row model (D5)').toBe(false);
    const args = newSessionCalls[newSessionCalls.length - 1];
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
  });

  it('claude-code with the field absent → launch present with empty applied/dropped', async () => {
    h = makeHarness('claude-code', [job('think-none')]);
    await h.trigger('think-none');
    await waitFor(async () => (await h!.history('think-none')).length > 0);
    const [run] = await h.history('think-none');
    expect(run.launch, 'history row has no launch record').toBeDefined();
    expect(run.launch!.requested).toEqual({});
    expect(run.launch!.applied).toEqual([]);
    expect(run.launch!.dropped).toEqual([]);
  });

  it('stubbed gemini-cli + thinkingMode low → launch.dropped not-supported, nothing applied', async () => {
    h = makeHarness('gemini-cli', [job('think-gemini', { thinkingMode: 'low' })]);
    await h.trigger('think-gemini');
    await waitFor(async () => (await h!.history('think-gemini')).length > 0);
    const [run] = await h.history('think-gemini');
    expect(run.framework).toBe('gemini-cli');
    expect(run.launch, 'history row has no launch record').toBeDefined();
    expect(run.launch!.applied).toEqual([]);
    expect(run.launch!.dropped).toEqual([{ feature: 'thinkingMode', requestedValue: 'low', reason: 'not-supported' }]);
  });

  it('script and spawn-error rows carry no launch; the main-path row in the same scheduler does', async () => {
    h = makeHarness('claude-code', [
      job('script-run', { execute: { type: 'script', value: 'true' }, thinkingMode: 'low' }),
      job('spawn-fail', { thinkingMode: 'low' }),
      job('main-path', { thinkingMode: 'low' }),
    ]);
    await h.trigger('script-run');
    await h.trigger('spawn-fail');
    await h.trigger('main-path');
    await waitFor(async () => (await h!.history('script-run')).some((r) => r.result !== 'pending'));
    await waitFor(async () => (await h!.history('spawn-fail')).length > 0);
    await waitFor(async () => (await h!.history('main-path')).length > 0);
    for (const r of await h.history('script-run')) expect(r.launch).toBeUndefined();
    const fail = await h.history('spawn-fail');
    expect(fail[0].result).not.toBe('success');
    for (const r of fail) expect(r.launch).toBeUndefined();
    expect((await h.history('main-path'))[0].launch, 'main-path row has no launch record').toBeDefined();
  });

  it('triage rows carry no launch', async () => {
    const j = job('triaged', { thinkingMode: 'low' });
    h = makeHarness('claude-code', [j]);
    const out = h.scheduler.spawnProjectedSession(j, { prompt: 'look at the failed run', slugTag: 'triage:triaged', origin: 'triage', trigger: 'triage:run-1', confinedTools: ['Read'] });
    expect(out).toHaveProperty('sessionName');
    await waitFor(() => h!.scheduler.getRunHistory().query({ slug: 'triaged' }).runs.length > 0);
    const rows = h.scheduler.getRunHistory().query({ slug: 'triaged' }).runs as unknown as Run[];
    expect(rows.every((r) => r.origin === 'triage')).toBe(true);
    for (const r of rows) expect(r.launch).toBeUndefined();
    // Positive control so this case cannot pass on a build that never writes launch at all.
    await h.trigger('triaged');
    await waitFor(async () => (await h!.history('triaged')).some((r) => r.origin !== 'triage'));
    const main = (await h.history('triaged')).find((r) => r.origin !== 'triage')!;
    expect(main.launch, 'main-path row has no launch record').toBeDefined();
  });

  it('unknown enum values inside launch are passed through by the route, not rejected', async () => {
    h = makeHarness('claude-code', [job('future-enum')]);
    const launch = {
      cliVersion: '9.9.9', requested: { thinkingMode: 'low' },
      applied: [{ feature: 'someFutureFeature', requestedValue: 'low', value: 'x', channel: 'socket' }],
      dropped: [{ feature: 'thinkingMode', requestedValue: 'low', reason: 'a-reason-from-the-future' }],
    };
    h.scheduler.getRunHistory().recordStart({ slug: 'future-enum', sessionId: 's-future', trigger: 'manual', launch } as never);
    const runs = await h.history('future-enum');
    expect(runs).toHaveLength(1);
    expect(runs[0].launch, 'history row has no launch record').toEqual(launch);
  });

  describe('jobs.launchIntent feature evidence', () => {
    const forRun = (rows: Array<{ kind: string; context?: Record<string, unknown> }>, runId: string, kind: string) =>
      rows.filter((e) => e.kind === kind && e.context?.runId === runId);

    it('one fired row per main-path run carrying that runId, with or without the field', async () => {
      h = makeHarness('claude-code', [job('ev-low', { thinkingMode: 'low' }), job('ev-none')]);
      await h.trigger('ev-low');
      await h.trigger('ev-none');
      await waitFor(async () => (await h!.history('ev-low')).length > 0 && (await h!.history('ev-none')).length > 0);
      const low = (await h.history('ev-low'))[0];
      const none = (await h.history('ev-none'))[0];
      await waitFor(() => h!.launchIntent().length >= 2, 2000).catch(() => { /* asserted below */ });
      const rows = h.launchIntent();
      expect(forRun(rows, low.runId, 'fired'), 'no fired row for the thinkingMode run').toHaveLength(1);
      expect(forRun(rows, none.runId, 'fired'), 'no fired row for the run without the field').toHaveLength(1);
      expect(rows, 'extra jobs.launchIntent rows beyond one per main-path run').toHaveLength(2);
      expect(rows.filter((e) => e.kind === 'error')).toEqual([]);
    });

    it('no evidence rows for script, triage or spawn-error runs (positive control: the main-path run has one)', async () => {
      const triaged = job('ev-triaged', { thinkingMode: 'low' });
      h = makeHarness('claude-code', [
        job('ev-script', { execute: { type: 'script', value: 'true' }, thinkingMode: 'low' }),
        job('spawn-fail-ev', { thinkingMode: 'low' }),
        job('ev-main', { thinkingMode: 'low' }),
        triaged,
      ]);
      await h.trigger('ev-script');
      await h.trigger('spawn-fail-ev');
      h.scheduler.spawnProjectedSession(triaged, { prompt: 'look at the failed run', slugTag: 'triage:ev-triaged', origin: 'triage', trigger: 'triage:run-1', confinedTools: ['Read'] });
      await h.trigger('ev-main');
      await waitFor(async () => (await h!.history('ev-script')).some((r) => r.result !== 'pending'));
      await waitFor(async () => (await h!.history('spawn-fail-ev')).length > 0);
      await waitFor(() => h!.scheduler.getRunHistory().query({ slug: 'ev-triaged' }).runs.length > 0);
      await waitFor(async () => (await h!.history('ev-main')).length > 0);
      const main = (await h.history('ev-main'))[0];
      await waitFor(() => h!.launchIntent().length >= 1, 2000).catch(() => { /* asserted below */ });
      const rows = h.launchIntent();
      expect(forRun(rows, main.runId, 'fired'), 'positive control: the main-path run has no fired row').toHaveLength(1);
      const sideRunIds = [
        ...(await h.history('ev-script')).map((r) => r.runId),
        ...(await h.history('spawn-fail-ev')).map((r) => r.runId),
        ...h.scheduler.getRunHistory().query({ slug: 'ev-triaged' }).runs.map((r) => r.runId),
      ];
      expect(sideRunIds.length).toBeGreaterThanOrEqual(3);
      for (const id of sideRunIds) expect(rows.filter((e) => e.context?.runId === id), `evidence written for side run ${id}`).toEqual([]);
      expect(rows, 'only the main-path run may write jobs.launchIntent evidence').toHaveLength(1);
    });

    it('a session that returns no launch: the run still gets its fired row, plus one error row, both with its runId', async () => {
      h = makeHarness('claude-code', [job('ev-broken', { thinkingMode: 'low' })]);
      const sm = h.sessionManager as unknown as { spawnSession: (o: unknown) => Promise<Record<string, unknown>> };
      const real = sm.spawnSession.bind(sm);
      sm.spawnSession = async (o: unknown) => { const s = await real(o); delete s.launch; return s; };
      await h.trigger('ev-broken');
      await waitFor(async () => (await h!.history('ev-broken')).length > 0);
      const run = (await h.history('ev-broken'))[0];
      expect(run.launch).toBeUndefined();
      await waitFor(() => h!.launchIntent().length >= 2, 2000).catch(() => { /* asserted below */ });
      const rows = h.launchIntent();
      expect(forRun(rows, run.runId, 'fired'), 'every main-path run gets a fired row, even without a launch record').toHaveLength(1);
      expect(forRun(rows, run.runId, 'error'), 'no error row for a run whose session returned no launch').toHaveLength(1);
      expect(rows, 'exactly one fired and one error row for this run').toHaveLength(2);
    });
  });

  it('D4 via JobModelRoute: an unusable pin falls back to the default engine and launch follows it', async () => {
    h = makeHarness('claude-code', [job('pinned-fallback', { thinkingMode: 'low', framework: 'codex-cli', frameworkModel: 'gpt-6-sol' })]);
    await h.trigger('pinned-fallback');
    await waitFor(async () => (await h!.history('pinned-fallback')).length > 0);
    const [run] = (await h.history('pinned-fallback')) as Array<Run & { routeBasis?: string; reason?: string }>;
    expect(run.routeBasis, 'the pin was not refused (this case would not test the fallback)').toBe('fallback');
    expect(run.framework).toBe('claude-code');
    expect(run.launch, 'history row has no launch record').toBeDefined();
    expect(run.launch!.applied).toEqual([{ feature: 'thinkingMode', requestedValue: 'low', value: 'low', channel: 'argv' }]);
    expect(run.launch!.dropped).toEqual([]);
    const args = newSessionCalls[newSessionCalls.length - 1];
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
    expect(args.some((a) => a.includes('model_reasoning_effort'))).toBe(false);
  });
});
