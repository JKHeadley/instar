import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator, SCRIPT_JOBS_CLAUDEMD_MARKER } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const dirs: string[] = [];

function migrate(projectDir: string): Result {
  const result: Result = { upgraded: [], skipped: [], errors: [] };
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'echo' });
  (migrator as unknown as { migrateClaudeMd(value: Result): void }).migrateClaudeMd(result);
  return result;
}

describe('Scheduled jobs run as scripts — agent awareness', () => {
  afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-scriptJobs.test.ts' }); });

  it('generateClaudeMd carries the section with the read surfaces', () => {
    const fresh = generateClaudeMd('instar', 'Echo', 4042, true);
    expect(fresh).toContain(SCRIPT_JOBS_CLAUDEMD_MARKER);
    expect(fresh).toContain('http://localhost:4042/jobs/triage');
    expect(fresh).toContain('http://localhost:4042/jobs/cost?sinceDays=7');
    expect(fresh).toContain('`runner`, `lockTrust`, `tokens`, `triage`');
    expect(fresh).toContain('health-check pushes critical problems at once');
    expect(fresh.split(SCRIPT_JOBS_CLAUDEMD_MARKER)).toHaveLength(2);
  });

  it('migrateClaudeMd adds it once (content-sniffed, idempotent)', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-jobs-awareness-'));
    dirs.push(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing agent\n');
    const first = migrate(projectDir);
    expect(first.upgraded).toContain('CLAUDE.md: added Scheduled jobs run as scripts section');
    const migrated = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(migrated).toContain('http://localhost:4042/jobs/triage');
    const second = migrate(projectDir);
    expect(second.upgraded).not.toContain('CLAUDE.md: added Scheduled jobs run as scripts section');
    expect(second.skipped).toContain('CLAUDE.md: Scheduled jobs run as scripts section already present');
    const after = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(after.split(SCRIPT_JOBS_CLAUDEMD_MARKER)).toHaveLength(2);
  });
});
