/**
 * Verifies PostUpdateMigrator adds the GET /jobs?scope=pool awareness bullet to
 * an existing agent's CLAUDE.md Job Scheduler section on update (WS4.3,
 * MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.3 — read-side). Migration Parity Standard:
 * a deployed agent only learns about pool-wide jobs visibility through this path.
 *
 * Content-sniff on 'jobs?scope=pool' keeps it idempotent and route-qualified (a
 * bare `scope=pool` sniff would falsely match other pool-scope routes).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

// A minimal CLAUDE.md carrying the Job Scheduler section as a deployed agent
// (predating WS4.3) would have it.
const LEGACY_JOBS_SECTION =
  '# CLAUDE.md\n\n' +
  '**Job Scheduler** — Run tasks on a schedule. Jobs in `.instar/jobs.json`.\n' +
  '- View: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/jobs`\n' +
  '- Trigger: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/jobs/SLUG/trigger`\n';

describe('PostUpdateMigrator — Job Scheduler pool-scope bullet (WS4.3)', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-jobs-pool-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-jobsPoolScope.test.ts:cleanup',
    });
  });

  it('adds the jobs?scope=pool bullet to an existing Job Scheduler section', () => {
    fs.writeFileSync(claudeMdPath, LEGACY_JOBS_SECTION);

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('Job Scheduler pool-scope'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('jobs?scope=pool');
    expect(after).toContain('pool.divergences');
    // The bullet is inserted right after the /jobs View line, not at EOF.
    const viewIdx = after.indexOf('- View: `curl');
    const poolIdx = after.indexOf('jobs?scope=pool');
    const triggerIdx = after.indexOf('- Trigger:');
    expect(viewIdx).toBeLessThan(poolIdx);
    expect(poolIdx).toBeLessThan(triggerIdx);
  });

  it('is idempotent — re-running does not add a duplicate bullet', () => {
    fs.writeFileSync(claudeMdPath, LEGACY_JOBS_SECTION);

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.upgraded.some((u) => u.includes('Job Scheduler pool-scope'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    expect((afterSecond.match(/jobs\?scope=pool/g) ?? []).length).toBe(1);
  });

  it('does NOT patch a CLAUDE.md with no Job Scheduler section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nNothing job-related here.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(after).not.toContain('jobs?scope=pool');
  });
});

describe('Job Scheduler pool-scope is in the agent template (fresh installs get it)', () => {
  it('the template emits the jobs?scope=pool bullet', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain('jobs?scope=pool');
    expect(templateSource).toContain('pool.divergences');
  });
});
