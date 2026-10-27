/**
 * job-cost-reduction §5.1 / §5.2 / §8.4 / F8 / F13 — the scheduler's script
 * runner: execFile(node) with no shell and a reduced env, result mapping incl.
 * `skipped`, trust refusal + re-hash before execution, overlap / cap / offset,
 * the rollback projection (template allowlist, expectedDurationMinutes — never
 * `legacy`), and the triage projection (JobState untouched).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createTempProject, createMockSessionManager, type TempProject } from '../../helpers/setup.js';
import { hashBody, hashFrontmatter, hashScriptBytes } from '../../../src/scheduler/AgentMdLockFile.js';
import type { JobSchedulerConfig } from '../../../src/core/types.js';
import type { ScriptRunContext } from '../../../src/scheduler/scriptRunObservers.js';

const lockState: { value: unknown } = { value: { state: 'absent' } };
vi.mock('../../../src/scheduler/AgentMdLockFile.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/scheduler/AgentMdLockFile.js')>();
  return { ...orig, readLockFile: () => lockState.value };
});
const { JobScheduler } = await import('../../../src/scheduler/JobScheduler.js');
type Scheduler = InstanceType<typeof JobScheduler>;

const ALLOWED_ENV = new Set([
  'PATH', 'HOME', 'INSTAR_AUTH_TOKEN', 'INSTAR_AGENT_ID', 'INSTAR_PORT', 'INSTAR_JOB_SLUG',
  'INSTAR_MESSAGE_KIND', 'INSTAR_SENDER_CLASS',
]);

function fmText(slug: string): string {
  return [
    `name: "${slug} job"`,
    `description: "${slug} desc"`,
    'toolAllowlist: ["Read", "Bash"]',
    'runner: "script"',
    `script: "${slug}.mjs"`,
    'scriptTimeoutMinutes: "1"',
    'anomalies:',
    '  - kind: "disk-low"',
    '    class: "critical"',
    'triageFields: ["outcome"]',
  ].join('\n');
}

const BODY = 'Do the job by hand: check the thing.\n';

let project: TempProject | undefined;
let scheduler: Scheduler | undefined;
afterEach(() => {
  scheduler?.stop();
  project?.cleanup();
  scheduler = undefined;
  project = undefined;
  lockState.value = { state: 'absent' };
  delete process.env.JCR_SECRET_TEST;
});

function addScriptJob(stateDir: string, slug: string, script: string, opts: { expectedDurationMinutes?: number } = {}): void {
  const jobs = path.join(stateDir, 'jobs');
  fs.mkdirSync(path.join(jobs, 'schedule'), { recursive: true });
  fs.mkdirSync(path.join(jobs, 'instar', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(jobs, 'schedule', `${slug}.json`), JSON.stringify({
    slug, origin: 'instar', schedule: '0 0 1 1 *', priority: 'medium', model: 'haiku',
    expectedDurationMinutes: opts.expectedDurationMinutes ?? 7, enabled: true,
    execute: { type: 'script', value: `${slug}.mjs` }, unrestrictedTools: false,
  }));
  fs.writeFileSync(path.join(jobs, 'instar', `${slug}.md`), `---\n${fmText(slug)}\n---\n${BODY}`);
  fs.writeFileSync(path.join(jobs, 'instar', 'scripts', `${slug}.mjs`), script);
}

function trustedLockFor(slugs: Array<{ slug: string; script: string }>) {
  const bySlug = new Map<string, Record<string, string>>();
  for (const { slug, script } of slugs) {
    const fm = yaml.load(fmText(slug), { schema: yaml.FAILSAFE_SCHEMA }) as Record<string, unknown>;
    bySlug.set(slug, { slug, bodyHash: hashBody(BODY), frontmatterHash: hashFrontmatter(fm), scriptHash: hashScriptBytes(script) });
  }
  return { state: 'present-trusted', lockFile: {}, bySlug };
}

function mkScheduler(p: TempProject, cfg: Record<string, unknown> = { developmentAgent: true }) {
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
  let current = cfg;
  s.setConfigReader(() => current);
  return { s, sm, setCfg: (c: Record<string, unknown>) => { current = c; } };
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

const lastRun = (s: Scheduler, slug: string) => s.getRunHistory().query({ slug, limit: 1 }).runs[0];

const ENV_SCRIPT = `
import fs from 'node:fs';
fs.writeFileSync('env.json', JSON.stringify({ keys: Object.keys(process.env), ppid: process.ppid, cwd: process.cwd(), env: process.env }));
console.log('JOB_FIELD outcome fine');
console.log('JOB_ANOMALY disk-low 3 only 4% free');
console.log('JOB_ANOMALY undeclared 1 x');
console.log('JOB_RESULT ok checked');
`;

describe('script runner execution', () => {
  it('runs node directly (no shell) with the reduced env, records success, spawns no session', async () => {
    project = createTempProject();
    process.env.JCR_SECRET_TEST = 'leak-me';
    addScriptJob(project.stateDir, 'probe', ENV_SCRIPT);
    const { s, sm } = mkScheduler(project);
    scheduler = s;
    const seen: ScriptRunContext[] = [];
    s.addScriptRunObserver({ onScriptRunCompleted: (c) => { seen.push(c); } });
    s.start();

    expect(await s.triggerJob('probe', 'test')).toBe('triggered');
    await waitFor(() => project!.state.getJobState('probe')?.lastResult === 'success');
    expect(sm._spawnCount).toBe(0);

    const envDump = JSON.parse(fs.readFileSync(path.join(project.dir, 'env.json'), 'utf-8'));
    expect(envDump.ppid).toBe(process.pid); // direct child of the server: no shell in between
    expect(fs.realpathSync(envDump.cwd)).toBe(fs.realpathSync(project.dir));
    for (const k of envDump.keys) expect(ALLOWED_ENV.has(k) || k === '__CF_USER_TEXT_ENCODING').toBe(true);
    expect(envDump.env).toMatchObject({
      INSTAR_AUTH_TOKEN: 'tok-123', INSTAR_AGENT_ID: 'agent-x', INSTAR_PORT: '4999',
      INSTAR_JOB_SLUG: 'probe', INSTAR_MESSAGE_KIND: 'automated', INSTAR_SENDER_CLASS: 'script',
    });
    expect(envDump.env.JCR_SECRET_TEST).toBeUndefined();

    const run = lastRun(s, 'probe');
    expect(run).toMatchObject({ result: 'success', runner: 'script', tokens: 0, origin: 'instar' });
    await waitFor(() => seen.length === 1);
    expect(seen[0].canary).toBe(false);
    expect(seen[0].parsed.fields).toEqual({ outcome: 'fine' });
    expect(seen[0].parsed.anomalies).toEqual([{ kind: 'disk-low', severity: 3, evidence: 'only 4% free', class: 'critical' }]);
    expect(seen[0].parsed.ignoredAnomalies).toBe(1);
  });

  it('skipped: consecutiveFailures neither raised nor reset, no retry, stats exclude it', async () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe', "console.log('JOB_RESULT skipped feature-dark 503')\n");
    const { s } = mkScheduler(project);
    scheduler = s;
    project.state.saveJobState({ slug: 'probe', consecutiveFailures: 2, lastResult: 'failure', lastError: 'boom' });
    s.start();
    await s.triggerJob('probe', 'test');
    await waitFor(() => project!.state.getJobState('probe')?.lastResult === 'skipped');
    const st = project.state.getJobState('probe')!;
    expect(st.consecutiveFailures).toBe(2);
    expect(lastRun(s, 'probe')).toMatchObject({ result: 'skipped', error: 'feature-dark 503' });
    expect(s.getRunHistory().stats('probe').totalRuns).toBe(0);
    expect((s as any).retryState.has('probe')).toBe(false);
  });

  it('missing result line → failure; consecutiveFailures +1', async () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe', "console.log('hello')\n");
    const { s } = mkScheduler(project);
    scheduler = s;
    s.start();
    await s.triggerJob('probe', 'test');
    await waitFor(() => project!.state.getJobState('probe')?.lastResult === 'failure');
    expect(project.state.getJobState('probe')!.consecutiveFailures).toBe(1);
    expect(lastRun(s, 'probe')).toMatchObject({ result: 'failure', error: 'missing-result-line' });
  });

  it('a secret printed by the script is scrubbed before it is stored', async () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe', "console.log('key sk-ant-api03-' + 'a'.repeat(90)); console.log('JOB_RESULT ok done')\n");
    const { s } = mkScheduler(project);
    scheduler = s;
    s.start();
    await s.triggerJob('probe', 'test');
    await waitFor(() => project!.state.getJobState('probe')?.lastResult === 'success');
    expect(lastRun(s, 'probe').outputSummary).not.toContain('aaaaaaaaaaaaaaaaaaaa');
    expect(lastRun(s, 'probe').outputSummary).toContain('[REDACTED');
  });
});

describe('trust at execution time', () => {
  it('a script-hash mismatch is not run, starts no session, records failed script-untrusted', async () => {
    project = createTempProject();
    const script = "import fs from 'node:fs'; fs.writeFileSync('ran.txt','x'); console.log('JOB_RESULT ok')\n";
    addScriptJob(project.stateDir, 'probe', script);
    lockState.value = trustedLockFor([{ slug: 'probe', script: 'other bytes' }]);
    const { s, sm } = mkScheduler(project);
    scheduler = s;
    s.start();
    await s.triggerJob('probe', 'test');
    await waitFor(() => project!.state.getJobState('probe')?.lastResult === 'failure');
    expect(fs.existsSync(path.join(project.dir, 'ran.txt'))).toBe(false);
    expect(sm._spawnCount).toBe(0);
    expect(lastRun(s, 'probe').error).toMatch(/^script-untrusted/);
    expect((s as any).retryState.has('probe')).toBe(false);
  });

  it('re-hashes immediately before execution: a file changed after load never runs', async () => {
    project = createTempProject();
    const script = "import fs from 'node:fs'; fs.writeFileSync('ran.txt','x'); console.log('JOB_RESULT ok')\n";
    addScriptJob(project.stateDir, 'probe', script);
    lockState.value = trustedLockFor([{ slug: 'probe', script }]);
    const { s } = mkScheduler(project);
    scheduler = s;
    s.start();
    expect(s.getJobs().find((j) => j.slug === 'probe')!.lockTrust).toBe('trusted');
    // Tamper after load (same refreshJobs signature input is the manifest).
    fs.appendFileSync(path.join(project.stateDir, 'jobs', 'instar', 'scripts', 'probe.mjs'), '// tampered\n');
    const loaded = s.getJobs().find((j) => j.slug === 'probe')!;
    (s as any).runScriptRunnerJob(loaded, 'test');
    await waitFor(() => project!.state.getJobState('probe')?.lastResult === 'failure');
    expect(fs.existsSync(path.join(project.dir, 'ran.txt'))).toBe(false);
  });

  it('trusted + matching hash runs', async () => {
    project = createTempProject();
    const script = "console.log('JOB_RESULT ok fine')\n";
    addScriptJob(project.stateDir, 'probe', script);
    lockState.value = trustedLockFor([{ slug: 'probe', script }]);
    const { s } = mkScheduler(project);
    scheduler = s;
    s.start();
    await s.triggerJob('probe', 'test');
    await waitFor(() => project!.state.getJobState('probe')?.lastResult === 'success');
    expect(lastRun(s, 'probe').lockTrust).toBe('trusted');
  });
});

describe('overlap, cap, offset (F8)', () => {
  const SLOW = "await new Promise((r) => setTimeout(r, 800)); console.log('JOB_RESULT ok slow')\n";

  it('a second trigger while the slug is in flight is skipped already-running', async () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe', SLOW);
    const { s } = mkScheduler(project);
    scheduler = s;
    s.start();
    expect(await s.triggerJob('probe', 'test')).toBe('triggered');
    expect(await s.triggerJob('probe', 'test')).toBe('skipped');
    await waitFor(() => project!.state.getJobState('probe')?.lastResult === 'success');
  });

  it('a fourth concurrent script is skipped script-cap and scheduled for retry', async () => {
    project = createTempProject();
    for (const slug of ['a1', 'a2', 'a3', 'a4']) addScriptJob(project.stateDir, slug, SLOW);
    const { s } = mkScheduler(project);
    scheduler = s;
    s.start();
    for (const slug of ['a1', 'a2', 'a3']) expect(await s.triggerJob(slug, 'test')).toBe('triggered');
    expect(await s.triggerJob('a4', 'test')).toBe('skipped');
    expect((s as any).retryState.has('a4')).toBe(true);
    await waitFor(() => ['a1', 'a2', 'a3'].every((x) => project!.state.getJobState(x)?.lastResult === 'success'));
  });

  it('the start offset is fixed per slug and within 0–20 s', () => {
    const a = JobScheduler.scriptStartOffsetMs('health-check');
    expect(a).toBe(JobScheduler.scriptStartOffsetMs('health-check'));
    for (const slug of ['health-check', 'doorway-scan', 'feedback-factory-triage', 'x']) {
      const o = JobScheduler.scriptStartOffsetMs(slug);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(20_000);
    }
    expect(new Set(['a', 'b', 'c', 'd', 'e'].map((x) => JobScheduler.scriptStartOffsetMs(x))).size).toBeGreaterThan(1);
  });

  it('a script runner runs when every session slot is full (above the capacity check)', async () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe', "console.log('JOB_RESULT ok')\n");
    const { s, sm } = mkScheduler(project);
    scheduler = s;
    sm.listRunningSessions = () => ([{ tmuxSession: 'a', jobSlug: 'x' }, { tmuxSession: 'b', jobSlug: 'y' }]) as any;
    s.start();
    expect(await s.triggerJob('probe', 'test')).toBe('triggered');
    await waitFor(() => project!.state.getJobState('probe')?.lastResult === 'success');
  });
});

describe('rollback projection (§8.4)', () => {
  it.each([
    ['fleet', {}],
    ['explicit disable', { developmentAgent: true, jobs: { scriptRunners: { enabled: false } } }],
    ['slug exclusion', { developmentAgent: true, jobs: { scriptRunners: { disabledSlugs: ['script-job-supervisor'] } } }],
  ])('new supervisor stays dark under %s without a new session', async (_label, cfg) => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'script-job-supervisor', "console.log('JOB_RESULT ok')\n");
    const { s, sm } = mkScheduler(project, cfg);
    scheduler = s;
    s.start();
    expect(await s.triggerJob('script-job-supervisor', 'test')).toBe('skipped');
    expect(sm._spawnCount).toBe(0);
    expect(lastRun(s, 'script-job-supervisor')).toBeUndefined();
  });

  it('the new supervisor remains inactive even with dev and explicit fleet opt-in until audit certification', async () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'script-job-supervisor', "console.log('JOB_RESULT ok')\n");
    const { s, sm, setCfg } = mkScheduler(project);
    scheduler = s;
    s.start();
    expect(await s.triggerJob('script-job-supervisor', 'dev')).toBe('skipped');
    setCfg({ jobs: { scriptRunners: { enabled: true } } });
    expect(s.scriptRunnersActiveFor('script-job-supervisor')).toBe(false);
    expect(await s.triggerJob('script-job-supervisor', 'fleet-opt-in')).toBe('skipped');
    expect(sm._spawnCount).toBe(0);
  });

  it('drops a queued supervisor when the script rollout closes before dispatch', () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'script-job-supervisor', "console.log('JOB_RESULT ok')\n");
    const { s, sm, setCfg } = mkScheduler(project);
    scheduler = s;
    s.start();
    (s as any).queue.push({ slug: 'script-job-supervisor', reason: 'queued-before-disable' });
    setCfg({ developmentAgent: true, jobs: { scriptRunners: { enabled: false } } });
    project.state.setReadOnly(true);
    try {
      expect(() => s.processQueue()).not.toThrow();
    } finally {
      project.state.setReadOnly(false);
    }
    expect(sm._spawnCount).toBe(0);
    expect((s as any).queue).toHaveLength(0);
  });

  it('keeps later-wave jobs on sessions even before config migration writes their exclusions', () => {
    project = createTempProject();
    const { s, setCfg } = mkScheduler(project, { developmentAgent: true });
    scheduler = s;
    expect(s.scriptRunnersActiveFor('health-check')).toBe(false);
    expect(s.scriptRunnersActiveFor('feedback-factory-process')).toBe(false);
    expect(s.scriptRunnersActiveFor('llm-decision-grading')).toBe(true);
    expect(s.scriptRunnersActiveFor('correction-class-review-backstop')).toBe(true);
    setCfg({ developmentAgent: true, jobs: { scriptRunners: { enabled: true, disabledSlugs: [] } } });
    expect(s.scriptRunnersActiveFor('health-check')).toBe(false);
  });

  it.each([
    ['enabled:false', { developmentAgent: true, jobs: { scriptRunners: { enabled: false } } }],
    ['slug in disabledSlugs', { developmentAgent: true, jobs: { scriptRunners: { disabledSlugs: ['probe'] } } }],
    ['dev gate off (fleet)', {}],
  ])('%s → body runs as an agentmd session with the template allowlist and expectedDurationMinutes', async (_label, cfg) => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe', "import fs from 'node:fs'; fs.writeFileSync('ran.txt','x'); console.log('JOB_RESULT ok')\n");
    const { s, sm } = mkScheduler(project, cfg as Record<string, unknown>);
    scheduler = s;
    s.start();
    expect(await s.triggerJob('probe', 'test')).toBe('triggered');
    await waitFor(() => sm._spawnCount === 1);
    const args = sm._lastSpawnArgs as any;
    expect(args.allowedTools).toEqual(['Read', 'Bash']); // frontmatter allowlist, not legacy full tools
    expect(args.maxDurationMinutes).toBe(7);              // expectedDurationMinutes, not the script bound
    expect(args.prompt).toContain('Do the job by hand');
    expect(args.prompt).not.toContain('Run this script');
    expect(args.jobSlug).toBe('probe');
    expect(fs.existsSync(path.join(project.dir, 'ran.txt'))).toBe(false);
    expect(lastRun(s, 'probe').origin).toBe('instar');
  });

  it('the rollback switch is read live at each trigger', async () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe', "console.log('JOB_RESULT ok')\n");
    const { s, sm, setCfg } = mkScheduler(project);
    scheduler = s;
    s.start();
    expect(s.scriptRunnersActiveFor('probe')).toBe(true);
    setCfg({ developmentAgent: true, jobs: { scriptRunners: { enabled: false } } });
    expect(s.scriptRunnersActiveFor('probe')).toBe(false);
    await s.triggerJob('probe', 'test');
    await waitFor(() => sm._spawnCount === 1);
  });
});

describe('triage projection (F13)', () => {
  it('spawns tagged triage:<slug>, confined + no auth env, and never touches JobState', async () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe', "console.log('JOB_RESULT ok')\n");
    const { s, sm } = mkScheduler(project);
    scheduler = s;
    s.start();
    const before = { slug: 'probe', consecutiveFailures: 1, lastResult: 'failure' as const, lastError: 'e' };
    project.state.saveJobState(before);
    const ended: unknown[] = [];
    s.addProjectedSessionListener((end) => ended.push(end));

    const job = s.getJobs().find((j) => j.slug === 'probe')!;
    const r = s.spawnProjectedSession(job, {
      prompt: 'Investigate the result.', slugTag: 'triage:probe', origin: 'triage', trigger: 'triage:abc',
      confinedTools: ['Read', 'Grep', 'Glob', 'Bash'], omitAuthEnv: true, modelOverride: 'agent-default', maxDurationMinutes: 15,
    });
    expect('sessionName' in r).toBe(true);
    await waitFor(() => sm._spawnCount === 1);
    const args = sm._lastSpawnArgs as any;
    expect(args).toMatchObject({
      jobSlug: 'triage:probe', omitAuthEnv: true, useAgentDefaultModel: true,
      confinedTools: ['Read', 'Grep', 'Glob', 'Bash'], allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], maxDurationMinutes: 15,
    });
    expect(args.model).toBeUndefined();

    // The job's own already-running guard is not tripped by the triage session.
    expect(await s.triggerJob('probe', 'test')).toBe('triggered');
    await waitFor(() => project!.state.getJobState('probe')?.lastResult === 'success');
    project.state.saveJobState(before);

    const session = sm._sessions[0];
    session.status = 'completed';
    project.state.saveSession(session as any);
    await s.notifyJobComplete(session.id, session.tmuxSession);
    expect(ended).toEqual([{ slugTag: 'triage:probe', sessionName: session.name, trigger: 'triage:abc', output: 'mock output', result: 'success' }]);
    expect(project.state.getJobState('probe')).toMatchObject(before);
    const rows = s.getRunHistory().query({ slug: 'probe', limit: 10 }).runs;
    const triageRow = rows.find((x) => x.origin === 'triage')!;
    expect(triageRow).toMatchObject({ result: 'success', trigger: 'triage:abc' });
    expect(s.getRunHistory().stats('probe').totalRuns).toBe(1); // only the script run counts
  });

  it('refuses a malformed slug tag and an empty tool set', () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe', "console.log('JOB_RESULT ok')\n");
    const { s } = mkScheduler(project);
    scheduler = s;
    s.start();
    const job = s.getJobs().find((j) => j.slug === 'probe')!;
    expect(s.spawnProjectedSession(job, { prompt: 'x', slugTag: 'probe', origin: 'triage', trigger: 't', confinedTools: ['Read'] })).toHaveProperty('refused');
    expect(s.spawnProjectedSession(job, { prompt: 'x', slugTag: 'triage:probe', origin: 'triage', trigger: 'triage:r1' })).toHaveProperty('refused');
    // The trigger must name the triaged run: triage:<runId>.
    expect(s.spawnProjectedSession(job, { prompt: 'x', slugTag: 'triage:probe', origin: 'triage', trigger: 'manual', confinedTools: ['Read'] })).toHaveProperty('refused');
  });
});

describe('canary + listing surface', () => {
  it('runScriptCanary passes --canary + INSTAR_SCRIPT_CANARY=1, writes no history row', async () => {
    project = createTempProject();
    addScriptJob(project.stateDir, 'probe', "console.log(process.argv.includes('--canary') && process.env.INSTAR_SCRIPT_CANARY === '1' ? 'JOB_RESULT failed canary-ok ' + process.argv[process.argv.indexOf('--server-url') + 1] : 'JOB_RESULT ok'); process.exit(1)\n");
    const { s } = mkScheduler(project);
    scheduler = s;
    s.start();
    const seen: ScriptRunContext[] = [];
    s.addScriptRunObserver({ onScriptRunCompleted: (c) => { seen.push(c); } });
    const r = await s.runScriptCanary('probe', { serverUrl: 'http://127.0.0.1:1' });
    expect(r.parsed.result).toBe('failure');
    expect(r.parsed.reason).toBe('canary-ok http://127.0.0.1:1');
    expect(s.getRunHistory().query({ slug: 'probe' }).total).toBe(0);
    expect(seen[0].canary).toBe(true);
    expect(s.listScriptJobs().map((j) => j.slug)).toEqual(['probe']);
  });
});
