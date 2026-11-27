/**
 * job-cost-reduction §5.1 / §8.1 / §8.5 — the installer copies shipped
 * scripts (always overwrite, prune stale), writes a script manifest for a
 * `runner: script` template (a bare validated filename, never a command), and
 * refuses a bad name. Plus the template-load pin: every SHIPPED template
 * installs and loads under the same version's loader with no entry skipped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBuiltinJobs } from '../../../src/scheduler/InstallBuiltinJobs.js';
import { validateManifest, loadAgentMdJobs } from '../../../src/scheduler/AgentMdJobLoader.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('installBuiltinJobs — script runners', () => {
  let workspace: string;
  let agentStateDir: string;
  let packageRoot: string;
  let templatesDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-installScripts-'));
    agentStateDir = path.join(workspace, 'agent', '.instar');
    packageRoot = path.join(workspace, 'pkg');
    templatesDir = path.join(packageRoot, 'src', 'scaffold', 'templates', 'jobs', 'instar');
    fs.mkdirSync(path.join(templatesDir, 'scripts'), { recursive: true });
    fs.mkdirSync(agentStateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'InstallBuiltinJobs-scripts.test cleanup' });
  });

  function writeTemplate(slug: string, extra: string): void {
    const fm = [
      `name: "${slug}"`,
      `description: "${slug} desc"`,
      'schedule: "*/5 * * * *"',
      'priority: "low"',
      'expectedDurationMinutes: "3"',
      'model: "haiku"',
      'enabled: "true"',
      'toolAllowlist: "*"',
      'unrestrictedTools: "true"',
      extra,
    ].filter(Boolean).join('\n');
    fs.writeFileSync(path.join(templatesDir, `${slug}.md`), `---\n${fm}\n---\nBody for ${slug}\n`);
  }

  it('copies scripts, writes an execute:script manifest, and the loader carries the fields', () => {
    writeTemplate('probe-job', [
      'runner: "script"',
      'script: "probe-job.mjs"',
      'scriptTimeoutMinutes: "2"',
      'scriptSupervision: "deterministic"',
      'anomalies:',
      '  - kind: "disk-low"',
      '    class: "critical"',
      'triageFields: ["outcome"]',
      'supervision: "tier0"',
      'triageEvidence: "structured-only"',
      'triageBareOk:',
      '  - "nothing to do"',
      'triageBareSkipped: ["feature-dark"]',
    ].join('\n'));
    fs.writeFileSync(path.join(templatesDir, 'scripts', 'probe-job.mjs'), 'console.log("JOB_RESULT ok")\n');

    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    expect(report.errors).toEqual([]);
    expect(report.installed).toEqual(['probe-job']);

    const copied = path.join(agentStateDir, 'jobs', 'instar', 'scripts', 'probe-job.mjs');
    expect(fs.readFileSync(copied, 'utf-8')).toContain('JOB_RESULT ok');
    const manifest = JSON.parse(fs.readFileSync(path.join(agentStateDir, 'jobs', 'schedule', 'probe-job.json'), 'utf-8'));
    expect(manifest.execute).toEqual({ type: 'script', value: 'probe-job.mjs' });
    expect(() => validateManifest(manifest)).not.toThrow();

    const loaded = loadAgentMdJobs(path.join(agentStateDir, 'jobs', 'schedule'), path.join(agentStateDir, 'jobs'));
    const job = loaded.jobs.find((j) => j.slug === 'probe-job')!;
    expect(job).toBeDefined();
    expect(job).toMatchObject({
      runner: 'script',
      scriptFile: 'probe-job.mjs',
      scriptTimeoutMinutes: 2,
      scriptSupervision: 'deterministic',
      anomalies: [{ kind: 'disk-low', class: 'critical' }],
      triageFields: ['outcome'],
      supervision: 'tier0',
      triageEvidence: 'structured-only',
      triageBareOk: ['nothing to do'],
      triageBareSkipped: ['feature-dark'],
      expectedDurationMinutes: 3,
      lockTrust: 'untrusted-no-lockfile',
    });
    expect(job.body).toContain('Body for probe-job');
  });

  it('refuses a script name that is not <slug>.mjs', () => {
    writeTemplate('bad-job', 'runner: "script"\nscript: "../evil.mjs"');
    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    expect(report.installed).toEqual([]);
    expect(report.errors.some((e) => e.slug === 'bad-job' && /refused/.test(e.reason))).toBe(true);
    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'schedule', 'bad-job.json'))).toBe(false);
  });

  it('refuses a runner template whose script is not shipped', () => {
    writeTemplate('ghost-job', 'runner: "script"\nscript: "ghost-job.mjs"');
    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    expect(report.installed).toEqual([]);
    expect(report.errors[0].reason).toMatch(/not shipped/);
  });

  it('refuses a badly named shipped script and prunes stale installed scripts', () => {
    writeTemplate('plain', '');
    fs.writeFileSync(path.join(templatesDir, 'scripts', 'Bad_Name.mjs'), '//');
    const staleDir = path.join(agentStateDir, 'jobs', 'instar', 'scripts');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'old-job.mjs'), '//');
    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    expect(report.errors.some((e) => /Bad_Name\.mjs/.test(e.reason))).toBe(true);
    expect(fs.existsSync(path.join(staleDir, 'old-job.mjs'))).toBe(false);
    expect(fs.existsSync(path.join(staleDir, 'Bad_Name.mjs'))).toBe(false);
  });

  it('always overwrites an installed script with the shipped bytes', () => {
    writeTemplate('probe-job', 'runner: "script"\nscript: "probe-job.mjs"');
    fs.writeFileSync(path.join(templatesDir, 'scripts', 'probe-job.mjs'), 'v2\n');
    const dst = path.join(agentStateDir, 'jobs', 'instar', 'scripts');
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, 'probe-job.mjs'), 'tampered\n');
    installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    expect(fs.readFileSync(path.join(dst, 'probe-job.mjs'), 'utf-8')).toBe('v2\n');
  });

  it('an instar script manifest naming a command line is refused by validateManifest', () => {
    expect(() => validateManifest({
      slug: 'x', origin: 'instar', schedule: '* * * * *', priority: 'low', expectedDurationMinutes: 1,
      enabled: true, execute: { type: 'script', value: 'node evil.js --flag' },
    })).toThrow(/must name "x\.mjs"/);
    // A user-origin script job keeps its shell command value.
    expect(() => validateManifest({
      slug: 'x', origin: 'user', schedule: '* * * * *', priority: 'low', expectedDurationMinutes: 1,
      enabled: true, execute: { type: 'script', value: 'echo hi' },
    })).not.toThrow();
  });
});

describe('template-load pin (§8.5): every shipped template loads under this loader', () => {
  let workspace: string;
  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'template-load pin cleanup' });
  });

  it('installs and loads all shipped templates with no entry skipped', () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-template-pin-'));
    const agentStateDir = path.join(workspace, '.instar');
    fs.mkdirSync(agentStateDir, { recursive: true });
    // A fake package root that exposes ONLY the real src templates (so a dev
    // checkout's signed dist lock-file cannot skew the result).
    const pkg = path.join(workspace, 'pkg');
    fs.mkdirSync(path.join(pkg, 'src', 'scaffold', 'templates', 'jobs'), { recursive: true });
    fs.symlinkSync(
      path.join(REPO_ROOT, 'src', 'scaffold', 'templates', 'jobs', 'instar'),
      path.join(pkg, 'src', 'scaffold', 'templates', 'jobs', 'instar'),
    );
    const shipped = fs.readdirSync(path.join(REPO_ROOT, 'src', 'scaffold', 'templates', 'jobs', 'instar'))
      .filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();

    const report = installBuiltinJobs({ agentStateDir, packageRoot: pkg, port: 4042 });
    expect(report.errors).toEqual([]);
    expect(report.installed.sort()).toEqual(shipped);

    const loaded = loadAgentMdJobs(path.join(agentStateDir, 'jobs', 'schedule'), path.join(agentStateDir, 'jobs'));
    const nonLockProblems = loaded.problems.filter((p) => p.kind !== 'lock-mismatch');
    expect(nonLockProblems).toEqual([]);
    expect(loaded.jobs.map((j) => j.slug).sort()).toEqual(shipped);
    for (const slug of ['health-check', 'script-job-supervisor']) {
      expect(loaded.jobs.find(j => j.slug === slug), slug).toMatchObject({
        enabled: true, runner: 'script', execute: { type: 'script', value: `${slug}.mjs` },
      });
    }
    for (const job of loaded.jobs) {
      // Disabled manifests deliberately skip body hydration until enabled.
      if (job.execute.type === 'script' && job.enabled) expect(job.runner, job.slug).toBe('script');
    }
  });
});
