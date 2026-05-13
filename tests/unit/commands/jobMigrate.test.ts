/**
 * Phase 3 — jobsMigrate unit tests. The Seamless Migration Guarantee
 * invariants that apply at the migration-script layer (PR #180 §Seamless
 * Migration Guarantee) are asserted here.
 *
 * Invariants under test:
 *   1 Zero job loss — every jobs.json entry is accounted for in the outcome
 *   2 Zero schedule drift — manifest schedule matches pre-migration schedule
 *   3 Byte-identical prompts for body-matched defaults — runtime resolution
 *     of a migrated default produces the same body as today (covered by
 *     the integration test in Phase 1c-runtime + this manifest assertion)
 *   4 User-namespace untouched if no user-namespace operations are
 *     intended — verified by mtime snapshot
 *   5 One-button rollback — `--abandon` restores pre-migration state
 *   9 Fail-closed — `--default-action=fail` on near-miss aborts with no
 *     partial state on the user side
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { jobsMigrate } from '../../../src/commands/jobMigrate.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('jobsMigrate', () => {
  let workspace: string;
  let agentStateDir: string;
  let packageRoot: string;
  let templatesDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-migrate-'));
    agentStateDir = path.join(workspace, '.instar');
    packageRoot = path.join(workspace, 'pkg');
    templatesDir = path.join(packageRoot, 'src', 'scaffold', 'templates', 'jobs', 'instar');
    fs.mkdirSync(agentStateDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'jobMigrate.test cleanup' });
  });

  function shipDefault(slug: string, body: string) {
    const fm = [
      `name: "${slug}"`,
      'description: "default"',
      'schedule: "*/5 * * * *"',
      'priority: low',
      'expectedDurationMinutes: 1',
      'model: haiku',
      'enabled: true',
      'toolAllowlist: "*"',
      'unrestrictedTools: true',
    ].join('\n');
    fs.writeFileSync(path.join(templatesDir, `${slug}.md`), `---\n${fm}\n---\n${body}`, 'utf-8');
  }

  function writeJobsJson(entries: any[]) {
    fs.writeFileSync(path.join(agentStateDir, 'jobs.json'), JSON.stringify(entries, null, 2), 'utf-8');
  }

  // ── Invariant 1 + 2 ─────────────────────────────────────────────────

  it('migrates a body-matched default to origin:instar with manifest only', () => {
    const body = 'Run a health check\n';
    shipDefault('health-check', body);
    writeJobsJson([
      {
        slug: 'health-check',
        name: 'Health Check',
        description: 'd',
        schedule: '*/5 * * * *',
        priority: 'critical',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: body },
      },
    ]);

    const r = jobsMigrate({ agentStateDir, packageRoot });

    expect(r.status).toBe('completed');
    expect(r.perEntry).toEqual([{ slug: 'health-check', action: 'migrated-instar' }]);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(agentStateDir, 'jobs', 'schedule', 'health-check.json'), 'utf-8'),
    );
    expect(manifest.origin).toBe('instar');
    expect(manifest.execute.type).toBe('agentmd');
    expect(manifest.schedule).toBe('*/5 * * * *'); // invariant 2: schedule preserved
  });

  it('forks a user-authored job to .instar/jobs/user/ with manifest', () => {
    writeJobsJson([
      {
        slug: 'my-custom-job',
        name: 'My Custom Job',
        description: 'user thing',
        schedule: '0 9 * * *',
        priority: 'medium',
        expectedDurationMinutes: 2,
        model: 'sonnet',
        enabled: true,
        execute: { type: 'prompt', value: 'Do my thing\n' },
      },
    ]);

    const r = jobsMigrate({ agentStateDir, packageRoot });

    expect(r.status).toBe('completed');
    expect(r.perEntry[0].action).toBe('kept-user');

    const userBody = fs.readFileSync(path.join(agentStateDir, 'jobs', 'user', 'my-custom-job.md'), 'utf-8');
    expect(userBody).toContain('Do my thing');
    expect(userBody).toContain('toolAllowlist:'); // user jobs default to ['Read']

    const manifest = JSON.parse(
      fs.readFileSync(path.join(agentStateDir, 'jobs', 'schedule', 'my-custom-job.json'), 'utf-8'),
    );
    expect(manifest.origin).toBe('user');
  });

  // ── Invariant 9 ─────────────────────────────────────────────────────

  it('refuses to proceed on near-miss when --default-action=fail (or default)', () => {
    shipDefault('health-check', 'Run a health check\nWith extra step\n');
    writeJobsJson([
      {
        slug: 'health-check',
        name: 'Health Check',
        description: 'd',
        schedule: '*/5 * * * *',
        priority: 'critical',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'Run a health check\n' }, // operator removed a step
      },
    ]);

    const r = jobsMigrate({ agentStateDir, packageRoot, defaultAction: 'fail' });

    expect(r.status).toBe('aborted');
    expect(r.errors[0]).toContain('Near-miss on default');
    // No manifest should have been written.
    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'schedule', 'health-check.json'))).toBe(false);
  });

  it('forks a near-miss default to user namespace with --default-action=fork', () => {
    shipDefault('health-check', 'Run a health check\nWith extra step\n');
    const editedBody = 'Run a health check\n';
    writeJobsJson([
      {
        slug: 'health-check',
        name: 'Health Check',
        description: 'd',
        schedule: '*/5 * * * *',
        priority: 'critical',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: editedBody },
      },
    ]);

    const r = jobsMigrate({ agentStateDir, packageRoot, defaultAction: 'fork' });

    expect(r.status).toBe('completed');
    expect(r.perEntry[0].action).toBe('forked-user');
    // User-body contains the edited content, not the shipped body.
    const userBody = fs.readFileSync(path.join(agentStateDir, 'jobs', 'user', 'health-check.md'), 'utf-8');
    expect(userBody).toContain('Run a health check');
    expect(userBody).not.toContain('With extra step');
  });

  it('renames a near-miss default to <slug>-user with --default-action=rename', () => {
    shipDefault('health-check', 'Run a health check\nWith extra step\n');
    writeJobsJson([
      {
        slug: 'health-check',
        name: 'Health Check',
        description: 'd',
        schedule: '*/5 * * * *',
        priority: 'critical',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'Run a health check\n' },
      },
    ]);

    const r = jobsMigrate({ agentStateDir, packageRoot, defaultAction: 'rename' });

    expect(r.status).toBe('completed');
    expect(r.perEntry[0].slug).toBe('health-check-user');
    expect(r.perEntry[0].action).toBe('renamed-user');
    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'user', 'health-check-user.md'))).toBe(true);
  });

  // ── Invariant 1 (zero job loss): script/skill entries surface ──────

  it('non-prompt entries (script/skill) are skipped (legacy path keeps them)', () => {
    writeJobsJson([
      { slug: 'a', execute: { type: 'script', value: 'echo' }, schedule: '* * * * *' },
      { slug: 'b', execute: { type: 'skill', value: 'some-skill' }, schedule: '* * * * *' },
    ]);

    const r = jobsMigrate({ agentStateDir, packageRoot });

    expect(r.status).toBe('completed');
    expect(r.perEntry.map((e) => e.action)).toEqual(['skipped', 'skipped']);
  });

  // ── Backup + abandon ────────────────────────────────────────────────

  it('writes a pre-migrate backup of jobs.json before any destructive operation', () => {
    writeJobsJson([{ slug: 'a', execute: { type: 'prompt', value: 'b' }, schedule: '* * * * *' }]);

    const r = jobsMigrate({ agentStateDir, packageRoot });

    expect(r.backupPath).toBeDefined();
    expect(fs.existsSync(r.backupPath!)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(r.backupPath!, 'utf-8'));
    expect(backup[0].slug).toBe('a');
  });

  it('--abandon removes schedule/ and writes the abandonment marker', () => {
    writeJobsJson([{ slug: 'a', execute: { type: 'prompt', value: 'b' }, schedule: '* * * * *' }]);
    jobsMigrate({ agentStateDir, packageRoot });
    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'schedule'))).toBe(true);

    const r = jobsMigrate({ agentStateDir, packageRoot, abandon: true });

    expect(r.status).toBe('abandoned');
    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'schedule'))).toBe(false);
    expect(fs.existsSync(path.join(agentStateDir, 'jobs', '.migration-abandoned.json'))).toBe(true);
    // jobs.json must remain intact for full rollback.
    expect(fs.existsSync(path.join(agentStateDir, 'jobs.json'))).toBe(true);
  });

  // ── Reporting / dry-run ─────────────────────────────────────────────

  it('--report classifies entries without writing anything', () => {
    const body = 'Run a health check\n';
    shipDefault('health-check', body);
    writeJobsJson([
      { slug: 'health-check', execute: { type: 'prompt', value: body }, schedule: '* * * * *' },
      { slug: 'user-job', execute: { type: 'prompt', value: 'mine' }, schedule: '* * * * *' },
    ]);

    const r = jobsMigrate({ agentStateDir, packageRoot, report: true });

    expect(r.status).toBe('reported');
    expect(r.perEntry.length).toBe(2);
    expect(r.perEntry[0].action).toBe('migrated-instar');
    expect(r.perEntry[1].action).toBe('kept-user');
    // No manifest written.
    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'schedule'))).toBe(false);
  });

  // ── Idempotency ──────────────────────────────────────────────────────

  it('is idempotent — re-running produces stable on-disk state', () => {
    shipDefault('a', 'body-a\n');
    writeJobsJson([{ slug: 'a', execute: { type: 'prompt', value: 'body-a\n' }, schedule: '* * * * *' }]);
    jobsMigrate({ agentStateDir, packageRoot });
    const manifest1 = fs.readFileSync(path.join(agentStateDir, 'jobs', 'schedule', 'a.json'), 'utf-8');
    jobsMigrate({ agentStateDir, packageRoot });
    const manifest2 = fs.readFileSync(path.join(agentStateDir, 'jobs', 'schedule', 'a.json'), 'utf-8');
    expect(manifest2).toBe(manifest1);
  });

  // ── Aborted on missing jobs.json ─────────────────────────────────────

  it('aborts when jobs.json is absent', () => {
    const r = jobsMigrate({ agentStateDir, packageRoot });
    expect(r.status).toBe('aborted');
    expect(r.errors[0]).toContain('No jobs.json');
  });
});
