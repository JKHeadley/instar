/**
 * The post-gate check in triggerJob re-reads the live job set after a gate has
 * waited, and refuses the fire when the definition or approval moved.
 *
 * Regression: the check compared the live definition with the session-rollback
 * PROJECTION of a script job (`execute: { type: 'agentmd' }`). The two can never
 * match, so every gated, projected job was refused on every fire, as a
 * "definition changed", and written up as a portable integrity failure.
 *
 * Both sides of the boundary are pinned here: projection is not a change; a real
 * edit during the gate is; a real imported-job failure still records.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createTempProject, createMockSessionManager, type TempProject } from '../../helpers/setup.js';
import { JobScheduler } from '../../../src/scheduler/JobScheduler.js';
import type { JobSchedulerConfig } from '../../../src/core/types.js';

type Scheduler = InstanceType<typeof JobScheduler>;

const SOURCE = `m_${'a'.repeat(32)}`;
const BODY = 'Do the job by hand: check the thing.\n';

let project: TempProject | undefined;
let scheduler: Scheduler | undefined;
afterEach(() => {
  scheduler?.stop();
  project?.cleanup();
  scheduler = undefined;
  project = undefined;
});

function manifest(slug: string, gate: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug, origin: 'instar', schedule: '0 0 1 1 *', priority: 'medium', model: 'haiku',
    expectedDurationMinutes: 7, enabled: true,
    execute: { type: 'script', value: `${slug}.mjs` }, unrestrictedTools: false, gate, ...extra,
  };
}

function addGatedScriptJob(stateDir: string, slug: string, gate: string): string {
  const jobs = path.join(stateDir, 'jobs');
  fs.mkdirSync(path.join(jobs, 'schedule'), { recursive: true });
  fs.mkdirSync(path.join(jobs, 'instar', 'scripts'), { recursive: true });
  const file = path.join(jobs, 'schedule', `${slug}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest(slug, gate)));
  fs.writeFileSync(path.join(jobs, 'instar', `${slug}.md`), [
    '---', `name: "${slug} job"`, `description: "${slug} desc"`, 'toolAllowlist: ["Read", "Bash"]',
    'runner: "script"', `script: "${slug}.mjs"`, 'scriptTimeoutMinutes: "1"',
    'anomalies:', '  - kind: "disk-low"', '    class: "critical"', 'triageFields: ["outcome"]', '---', BODY,
  ].join('\n'));
  fs.writeFileSync(path.join(jobs, 'instar', 'scripts', `${slug}.mjs`), "console.log('JOB_RESULT ok done');\n");
  return file;
}

function mkScheduler(p: TempProject, cfg: Record<string, unknown>) {
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
  s.setConfigReader(() => cfg);
  return { s, sm };
}

const sha256 = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
const dependencyPath = (p: TempProject) => path.join(p.dir, 'imported-dep.txt');
const approvalPath = (p: TempProject) => path.join(p.stateDir, 'state', 'job-portable-activate-approval.json');

/** Marks `slug` as an imported job; its approval covers its manifest and one project file. */
function writeImportJournal(p: TempProject, slug: string): void {
  fs.writeFileSync(dependencyPath(p), 'approved bytes\n');
  const manifestBytes = fs.readFileSync(path.join(p.stateDir, 'jobs', 'schedule', `${slug}.json`));
  fs.mkdirSync(path.join(p.stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(p.stateDir, 'state', 'job-portable-import-journal.json'), JSON.stringify({
    version: 1,
    jobs: { [slug]: {
      state: 'active', root: 'root-1', source: SOURCE, manifestHash: sha256(manifestBytes),
      expected: {
        [`.instar/jobs/schedule/${slug}.json`]: sha256(manifestBytes),
        'imported-dep.txt': sha256('approved bytes\n'),
      },
    } },
  }));
  fs.writeFileSync(approvalPath(p), JSON.stringify({ version: 1, approvals: { [slug]: { root: 'root-1' } } }));
}

const portableStatus = (p: TempProject): Record<string, { state: string; reason: string }> | null => {
  const file = path.join(p.stateDir, 'state', 'job-portable-status.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).jobs : null;
};

const skippedEvents = (p: TempProject, slug: string) =>
  p.state.queryEvents({ type: 'job_skipped', limit: 50 })
    .filter((event) => event.metadata?.slug === slug);

const DISABLED = (slug: string) => ({ developmentAgent: true, jobs: { scriptRunners: { disabledSlugs: [slug] } } });

describe('post-gate check: projection is not a definition change', () => {
  it.each([
    ['a slug in disabledSlugs', DISABLED('probe')],
    ['the fleet default, where script runners are dark', {}],
  ])('a gated script job projected by %s runs as its session', async (_label, cfg) => {
    project = createTempProject();
    addGatedScriptJob(project.stateDir, 'probe', 'true');
    const { s, sm } = mkScheduler(project, cfg);
    scheduler = s;
    s.start();

    expect(await s.triggerJob('probe', 'test')).toBe('triggered');
    expect(sm._spawnCount).toBe(1);
    expect((sm._lastSpawnArgs as { prompt: string }).prompt).toContain('Do the job by hand');
    expect(skippedEvents(project, 'probe')).toEqual([]);
    expect(s.getSkipLedger().getSkips({ slug: 'probe' })).toEqual([]);
  });

  it('a gated script job projected by a supervision hold runs as its session', async () => {
    project = createTempProject();
    addGatedScriptJob(project.stateDir, 'probe', 'true');
    const { s, sm } = mkScheduler(project, { developmentAgent: true, jobs: { scriptRunners: { disabledSlugs: [] } } });
    scheduler = s;
    s.start();
    s.getJobSupervisionStore().holdSlug('probe', 'independent-history-mismatch');

    expect(await s.triggerJob('probe', 'test')).toBe('triggered');
    expect(sm._spawnCount).toBe(1);
    expect(skippedEvents(project, 'probe')).toEqual([]);
  });

  it('every later fire of a projected job also runs, not only the first', async () => {
    project = createTempProject();
    addGatedScriptJob(project.stateDir, 'probe', 'true');
    const { s, sm } = mkScheduler(project, DISABLED('probe'));
    scheduler = s;
    s.start();

    expect(await s.triggerJob('probe', 'first')).toBe('triggered');
    sm.listRunningSessions = () => [];
    (sm as { isSessionAlive?: () => boolean }).isSessionAlive = () => false;
    await s.triggerJob('probe', 'second');
    expect(skippedEvents(project, 'probe').filter((e) => e.metadata?.gateReason === 'post-gate-definition-changed')).toEqual([]);
  });
});

describe('post-gate check: runtime state is not a definition change', () => {
  it('a topic assigned to the job while its gate runs does not refuse the fire', async () => {
    project = createTempProject();
    addGatedScriptJob(project.stateDir, 'probe', 'sleep 0.3');
    const { s, sm } = mkScheduler(project, DISABLED('probe'));
    scheduler = s;
    s.start();

    const fire = s.triggerJob('probe', 'test');
    await new Promise((resolve) => setTimeout(resolve, 100));
    s.getJobs().find((job) => job.slug === 'probe')!.topicId = 4242;

    expect(await fire).toBe('triggered');
    expect(sm._spawnCount).toBe(1);
    expect(skippedEvents(project, 'probe')).toEqual([]);
  });

  it('a reload that drops a runtime topic while the gate runs does not refuse the fire', async () => {
    project = createTempProject();
    const other = path.join(project.stateDir, 'jobs', 'schedule', 'other.json');
    addGatedScriptJob(project.stateDir, 'other', 'true');
    const editedOther = path.join(project.stateDir, 'edited-other.json');
    fs.writeFileSync(editedOther, JSON.stringify(manifest('other', 'true', { priority: 'high' })));
    addGatedScriptJob(project.stateDir, 'probe', `cp "${editedOther}" "${other}"`);
    const { s, sm } = mkScheduler(project, DISABLED('probe'));
    scheduler = s;
    s.start();
    s.getJobs().find((job) => job.slug === 'probe')!.topicId = 4242;

    expect(await s.triggerJob('probe', 'test')).toBe('triggered');
    expect(sm._spawnCount).toBe(1);
    expect(skippedEvents(project, 'probe')).toEqual([]);
  });
});

describe('post-gate check: a real change during the gate is still refused', () => {
  it.each([
    ['a projected job', DISABLED('probe')],
    ['a job running as its script', { developmentAgent: true, jobs: { scriptRunners: { disabledSlugs: [] } } }],
  ])('%s edited during its gate does not run, and is recorded as a definition change', async (_label, cfg) => {
    project = createTempProject();
    const edited = path.join(project.stateDir, 'edited.json');
    const gate = `cp "${edited}" "${path.join(project.stateDir, 'jobs', 'schedule', 'probe.json')}"`;
    addGatedScriptJob(project.stateDir, 'probe', gate);
    fs.writeFileSync(edited, JSON.stringify(manifest('probe', gate, { priority: 'high' })));
    const { s, sm } = mkScheduler(project, cfg);
    scheduler = s;
    s.start();

    expect(await s.triggerJob('probe', 'test')).toBe('skipped');
    expect(sm._spawnCount).toBe(0);
    expect(skippedEvents(project, 'probe').at(-1)?.metadata?.gateReason).toBe('post-gate-definition-changed');
    expect(s.getSkipLedger().getSkips({ slug: 'probe' }).map((row) => row.reason)).toEqual(['definition-changed']);
    expect(portableStatus(project)).toBeNull();
    // A job refused like this on fire after fire must reach the silence alert.
    expect(project.state.get<{ count: number }>('job-silence-probe')?.count).toBe(1);
  });

  it('a job switched off during its gate does not run, and says so', async () => {
    project = createTempProject();
    const edited = path.join(project.stateDir, 'edited.json');
    const gate = `cp "${edited}" "${path.join(project.stateDir, 'jobs', 'schedule', 'probe.json')}"`;
    addGatedScriptJob(project.stateDir, 'probe', gate);
    fs.writeFileSync(edited, JSON.stringify(manifest('probe', gate, { enabled: false })));
    const { s, sm } = mkScheduler(project, DISABLED('probe'));
    scheduler = s;
    s.start();

    expect(await s.triggerJob('probe', 'test')).toBe('skipped');
    expect(sm._spawnCount).toBe(0);
    expect(skippedEvents(project, 'probe').at(-1)?.metadata?.gateReason).toBe('disabled');
    expect(s.getSkipLedger().getSkips({ slug: 'probe' }).map((row) => row.reason)).toEqual(['disabled']);
    expect(portableStatus(project)).toBeNull();
  });

  it('a job deleted during its gate does not run, and says so', async () => {
    project = createTempProject();
    const file = path.join(project.stateDir, 'jobs', 'schedule', 'probe.json');
    addGatedScriptJob(project.stateDir, 'probe', `rm "${file}"`);
    const { s, sm } = mkScheduler(project, DISABLED('probe'));
    scheduler = s;
    s.start();

    expect(await s.triggerJob('probe', 'test')).toBe('skipped');
    expect(sm._spawnCount).toBe(0);
    expect(skippedEvents(project, 'probe').at(-1)?.metadata?.gateReason).toBe('job-missing');
    expect(portableStatus(project)).toBeNull();
  });
});

describe('post-gate check: portable integrity', () => {
  const integrityRow = { state: 'error', reason: 'imported-file-integrity' };

  it('an imported job whose approved file changes during its gate records the integrity failure', async () => {
    project = createTempProject();
    addGatedScriptJob(project.stateDir, 'probe', `echo tampered > "${dependencyPath(project)}"`);
    writeImportJournal(project, 'probe');
    const { s, sm } = mkScheduler(project, DISABLED('probe'));
    scheduler = s;
    s.start();

    expect(await s.triggerJob('probe', 'test')).toBe('skipped');
    expect(sm._spawnCount).toBe(0);
    expect(skippedEvents(project, 'probe').at(-1)?.metadata?.gateReason).toBe('portable-integrity');
    expect(portableStatus(project)?.[`${SOURCE}:probe`]).toMatchObject(integrityRow);
  });

  it('an imported job that loses its approval during its gate records the integrity failure', async () => {
    project = createTempProject();
    addGatedScriptJob(project.stateDir, 'probe', `rm "${approvalPath(project)}"`);
    writeImportJournal(project, 'probe');
    const { s, sm } = mkScheduler(project, DISABLED('probe'));
    scheduler = s;
    s.start();

    expect(await s.triggerJob('probe', 'test')).toBe('skipped');
    expect(sm._spawnCount).toBe(0);
    expect(skippedEvents(project, 'probe').at(-1)?.metadata?.gateReason).toBe('portable-integrity');
    expect(portableStatus(project)?.[`${SOURCE}:probe`]).toMatchObject(integrityRow);
  });

  it('an imported job whose manifest is edited during its gate records the integrity failure', async () => {
    project = createTempProject();
    const edited = path.join(project.stateDir, 'edited.json');
    const gate = `cp "${edited}" "${path.join(project.stateDir, 'jobs', 'schedule', 'probe.json')}"`;
    addGatedScriptJob(project.stateDir, 'probe', gate);
    fs.writeFileSync(edited, JSON.stringify(manifest('probe', gate, { priority: 'high' })));
    writeImportJournal(project, 'probe');
    const { s, sm } = mkScheduler(project, DISABLED('probe'));
    scheduler = s;
    s.start();

    expect(await s.triggerJob('probe', 'test')).toBe('skipped');
    expect(sm._spawnCount).toBe(0);
    expect(skippedEvents(project, 'probe').at(-1)?.metadata?.gateReason).toBe('portable-integrity');
    expect(portableStatus(project)?.[`${SOURCE}:probe`]).toMatchObject(integrityRow);
  });

  it('an imported job left untouched by its gate runs', async () => {
    project = createTempProject();
    addGatedScriptJob(project.stateDir, 'probe', 'true');
    writeImportJournal(project, 'probe');
    const { s, sm } = mkScheduler(project, DISABLED('probe'));
    scheduler = s;
    s.start();

    expect(await s.triggerJob('probe', 'test')).toBe('triggered');
    expect(sm._spawnCount).toBe(1);
    expect(portableStatus(project)).toBeNull();
  });
});
