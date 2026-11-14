/**
 * CMT-1610 — a script run cut off by a server restart (history `pending`,
 * process gone) is settled as a failed, interrupted run at the next start,
 * not turned into a permanent script-route hold. Real mismatches still hold.
 * A census hold whose cause is now settled is released with an audit row;
 * an explicit release is refused while the cause is unsettled.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createTempProject, createMockSessionManager, type TempProject } from '../../helpers/setup.js';
import { hashBody, hashFrontmatter, hashScriptBytes } from '../../../src/scheduler/AgentMdLockFile.js';
import type { JobSchedulerConfig } from '../../../src/core/types.js';

const lockState: { value: unknown } = { value: { state: 'absent' } };
vi.mock('../../../src/scheduler/AgentMdLockFile.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/scheduler/AgentMdLockFile.js')>();
  return { ...orig, readLockFile: () => lockState.value };
});
const { JobScheduler } = await import('../../../src/scheduler/JobScheduler.js');
type Scheduler = InstanceType<typeof JobScheduler>;

const SCRIPT = "console.log('JOB_RESULT ok done');";
const BODY = 'Do the job by hand: check the thing.\n';
function fmText(slug: string): string {
  return [`name: "${slug} job"`, `description: "${slug} desc"`, 'toolAllowlist: ["Read", "Bash"]',
    'runner: "script"', `script: "${slug}.mjs"`, 'scriptTimeoutMinutes: "1"', 'triageFields: ["outcome"]'].join('\n');
}
function addScriptJob(stateDir: string, slug: string): void {
  const jobs = path.join(stateDir, 'jobs');
  fs.mkdirSync(path.join(jobs, 'schedule'), { recursive: true });
  fs.mkdirSync(path.join(jobs, 'instar', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(jobs, 'schedule', `${slug}.json`), JSON.stringify({
    slug, origin: 'instar', schedule: '0 0 1 1 *', priority: 'medium', model: 'haiku',
    expectedDurationMinutes: 7, enabled: true, execute: { type: 'script', value: `${slug}.mjs` }, unrestrictedTools: false,
  }));
  fs.writeFileSync(path.join(jobs, 'instar', `${slug}.md`), `---\n${fmText(slug)}\n---\n${BODY}`);
  fs.writeFileSync(path.join(jobs, 'instar', 'scripts', `${slug}.mjs`), SCRIPT);
}
function trustLock(slug: string) {
  const fm = yaml.load(fmText(slug), { schema: yaml.FAILSAFE_SCHEMA }) as Record<string, unknown>;
  lockState.value = { state: 'present-trusted', lockFile: {}, bySlug: new Map([[slug,
    { slug, bodyHash: hashBody(BODY), frontmatterHash: hashFrontmatter(fm), scriptHash: hashScriptBytes(SCRIPT) }]]) };
}
function mkScheduler(p: TempProject) {
  const jobsFile = path.join(p.stateDir, 'jobs.json');
  fs.writeFileSync(jobsFile, '[]');
  const config: JobSchedulerConfig = {
    jobsFile, enabled: true, maxParallelJobs: 2,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    authToken: 'tok-123', projectName: 'agent-x', port: 4999,
  };
  const sm = createMockSessionManager();
  const s = new JobScheduler(config, sm as any, p.state, p.stateDir);
  s.setScriptStartOffsetEnabled(false);
  s.setConfigReader(() => ({ developmentAgent: true }));
  return { s, sm };
}
async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('waitFor timed out');
}

let project: TempProject | undefined;
let scheduler: Scheduler | undefined;
afterEach(() => {
  vi.useRealTimers();
  scheduler?.stop();
  project?.cleanup();
  scheduler = undefined;
  project = undefined;
  lockState.value = { state: 'absent' };
});

/** What a server that died mid-script leaves on disk: a pending history row and a pending attempt. */
function leaveInterruptedRun(s: Scheduler, slug: string, opts: { register?: boolean } = {}): string {
  const store = s.getJobSupervisionStore();
  const runId = s.getRunHistory().recordStart({ slug, sessionId: `script-${slug}-x`, trigger: 'scheduled', origin: 'instar', runner: 'script', tokens: 0 });
  if (opts.register !== false) {
    store.register({ runId, fireId: `local:${runId}`, slug, evidencePolicy: 'job-result-structured-v2' });
  }
  return runId;
}

function restart(p: TempProject, prior: Scheduler, opts: { laterMs?: number } = {}): Scheduler {
  prior.getJobSupervisionStore().close();
  prior.stop();
  // The restart happens well after the run's longest possible lifetime
  // unless a test asks for an overlapping restart.
  const later = opts.laterMs ?? 60 * 60_000;
  if (later > 0) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + later);
  }
  const next = mkScheduler(p).s;
  scheduler = next;
  next.start();
  return next;
}

describe('interrupted script runs (CMT-1610)', () => {
  it('settles a run cut off by a restart as failed and keeps the script route', async () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe');
    trustLock('probe');
    const first = mkScheduler(project).s;
    scheduler = first;
    const runId = leaveInterruptedRun(first, 'probe');

    const s = restart(project, first);
    expect(s.scriptRunnersActiveFor('probe')).toBe(true);
    const store = s.getJobSupervisionStore();
    expect(store.heldSlugs()).toEqual([]);
    expect(s.getRunHistory().findRun(runId)).toMatchObject({ result: 'failure', error: expect.stringMatching(/^interrupted/) });
    expect(store.findByRunId(runId)).toMatchObject({ result: 'failure', reason: 'interrupted', status: 'unchecked' });

    // The next fire really runs as a script and spawns no session.
    const sm = (s as any).sessionManager;
    expect(await s.triggerJob('probe', 'test')).toBe('triggered');
    await waitFor(() => s.getRunHistory().query({ slug: 'probe', limit: 1 }).runs[0]?.result === 'success');
    expect(s.getRunHistory().query({ slug: 'probe', limit: 1 }).runs[0].runner).toBe('script');
    expect(sm._spawnCount ?? 0).toBe(0);
  });

  it('settles a run that died before its supervision row was registered', () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe');
    const first = mkScheduler(project).s;
    scheduler = first;
    const runId = leaveInterruptedRun(first, 'probe', { register: false });
    const s = restart(project, first);
    expect(s.scriptRunnersActiveFor('probe')).toBe(true);
    expect(s.getJobSupervisionStore().findByRunId(runId)).toMatchObject({ reason: 'interrupted', result: 'failure' });
  });

  it('releases an existing census hold, with an audit row, once its interrupted run is settled', () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe');
    const first = mkScheduler(project).s;
    scheduler = first;
    const runId = leaveInterruptedRun(first, 'probe');
    // The pre-fix behavior: the run was marked outcome-unknown and the slug held.
    const prior = first.getJobSupervisionStore();
    prior.markUnchecked(prior.findByRunId(runId)!.attemptId, 'outcome-unknown');
    prior.holdSlug('probe', 'independent-history-mismatch');

    const s = restart(project, first);
    expect(s.scriptRunnersActiveFor('probe')).toBe(true);
    const store = s.getJobSupervisionStore();
    expect(store.isSlugHeld('probe')).toBe(false);
    expect(store.holdReleases('probe')).toEqual([expect.objectContaining({
      holdReason: 'independent-history-mismatch', releasedBy: 'census',
    })]);
  });

  it('keeps a hold for a real mismatch: the two ledgers disagree on a completed result', () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe');
    const first = mkScheduler(project).s;
    scheduler = first;
    const runId = leaveInterruptedRun(first, 'probe');
    const store0 = first.getJobSupervisionStore();
    store0.recordResult(store0.findByRunId(runId)!.attemptId, { result: 'success' });
    first.getRunHistory().recordCompletion({ runId, result: 'failure', error: 'boom' });

    const s = restart(project, first);
    expect(s.scriptRunnersActiveFor('probe')).toBe(false);
    expect(s.getJobSupervisionStore().heldSlugs()).toEqual([expect.objectContaining({ slug: 'probe', reason: 'independent-history-mismatch' })]);
    expect(s.releaseSupervisionHold('probe', { by: 'agent', reason: 'try' })).toEqual({ status: 'cause-unsettled', runIds: [runId] });
    expect(s.getJobSupervisionStore().isSlugHeld('probe')).toBe(true);
  });

  it('does not settle a pending run another machine recorded', () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe');
    const first = mkScheduler(project).s;
    scheduler = first;
    first.getJobSupervisionStore();
    const runId = 'probe-other-1';
    fs.appendFileSync(path.join(project.stateDir, 'ledger', 'job-runs.jsonl'), JSON.stringify({
      runId, slug: 'probe', sessionId: 'script-probe-o', trigger: 'scheduled', startedAt: new Date().toISOString(),
      result: 'pending', machineId: 'm_other', origin: 'instar', runner: 'script', tokens: 0,
    }) + '\n');
    const s = restart(project, first);
    s.setMachineIdentity('m_self', 'self');
    expect(s.scriptRunnersActiveFor('probe')).toBe(false);
    expect(s.getRunHistory().findRun(runId)?.result).toBe('pending');
  });

  it('never auto-releases a non-census hold; an explicit release is recorded and reopens the route', () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe');
    trustLock('probe');
    const first = mkScheduler(project).s;
    scheduler = first;
    first.getJobSupervisionStore().holdSlug('probe', 'write-failed:disk-full');
    const s = restart(project, first);
    expect(s.scriptRunnersActiveFor('probe')).toBe(false);
    expect(s.releaseSupervisionHold('other', { by: 'agent', reason: 'x' })).toEqual({ status: 'not-held' });
    const out = s.releaseSupervisionHold('probe', { by: 'agent', reason: 'disk repaired, ledger writable' });
    expect(out).toMatchObject({ status: 'released', hold: { slug: 'probe', reason: 'write-failed:disk-full' } });
    expect(s.scriptRunnersActiveFor('probe')).toBe(true);
    expect(s.getJobSupervisionStore().holdReleases('probe')[0]).toMatchObject({ releasedBy: 'agent', releaseReason: 'disk repaired, ledger writable' });
  });

  it('defers a run that may still be live in an overlapping server, then settles it after its lifetime', () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe');
    trustLock('probe');
    const first = mkScheduler(project).s;
    scheduler = first;
    const runId = leaveInterruptedRun(first, 'probe');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const s = restart(project, first, { laterMs: 0 });
    // Young run: neither settled nor durably held; the route waits.
    expect(s.scriptRunnersActiveFor('probe')).toBe(false);
    expect(s.getRunHistory().findRun(runId)?.result).toBe('pending');
    expect(s.getJobSupervisionStore().heldSlugs()).toEqual([]);
    // scriptTimeoutMinutes 1 → 20 s offset + 2 min kill bound + 1 min margin.
    vi.advanceTimersByTime(4 * 60_000);
    expect(s.getRunHistory().findRun(runId)).toMatchObject({ result: 'failure', error: expect.stringMatching(/^interrupted/) });
    expect(s.scriptRunnersActiveFor('probe')).toBe(true);
  });

  it('finishes a half-settled run: attempt closed as interrupted, history still pending', () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe');
    const first = mkScheduler(project).s;
    scheduler = first;
    const runId = leaveInterruptedRun(first, 'probe');
    first.getJobSupervisionStore().settleInterruptedRun({ runId, slug: 'probe', startedAt: new Date().toISOString() });
    expect(first.getRunHistory().findRun(runId)?.result).toBe('pending');
    const s = restart(project, first);
    expect(s.scriptRunnersActiveFor('probe')).toBe(true);
    expect(s.getRunHistory().findRun(runId)?.result).toBe('failure');
    expect(s.getJobSupervisionStore().heldSlugs()).toEqual([]);
  });
});
