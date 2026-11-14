/**
 * Migration parity for CMT-1586 (fb-d075a5c4-c4c): an instar update rewrote
 * `.instar/jobs/schedule/health-check.json` and reverted the operator's
 * `*\/10` back to the shipped `*\/5` (2026-11-10 07:32 PST on Echo).
 *
 * Drives the REAL update path (`PostUpdateMigrator.migrateBuiltinJobs`, which
 * installs the shipped templates from this repo) twice around an operator
 * edit, and checks the CLAUDE.md awareness bullet reaches existing agents
 * exactly once.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { loadAgentMdJobs } from '../../src/scheduler/AgentMdJobLoader.js';
import { BUILTIN_SCHEDULE_EDIT_AWARENESS } from '../../src/scheduler/InstallBuiltinJobs.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
type Internals = {
  migrateBuiltinJobs(r: MigrationResult): void;
  migrateClaudeMd(r: MigrationResult): void;
};

function newMigrator(projectDir: string): Internals {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  }) as unknown as Internals;
}

const fresh = (): MigrationResult => ({ upgraded: [], skipped: [], errors: [] });

describe('PostUpdateMigrator — built-in schedule edits survive updates', () => {
  let projectDir: string;
  let stateDir: string;
  let manifestPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-schededit-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    manifestPath = path.join(stateDir, 'jobs', 'schedule', 'health-check.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-builtinScheduleEdit.test.ts',
    });
  });

  it('keeps an operator health-check schedule edit through the next update', () => {
    const first = fresh();
    newMigrator(projectDir).migrateBuiltinJobs(first);
    expect(first.errors).toEqual([]);
    const installed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(installed.shippedSchedule).toBe(installed.schedule);
    const shipped = installed.schedule as string;
    const edited = shipped === '*/10 * * * *' ? '*/15 * * * *' : '*/10 * * * *';

    installed.schedule = edited;
    fs.writeFileSync(manifestPath, JSON.stringify(installed, null, 2));

    const update = fresh();
    newMigrator(projectDir).migrateBuiltinJobs(update);
    expect(update.errors).toEqual([]);
    const after = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(after).toMatchObject({ schedule: edited, shippedSchedule: shipped });

    // The loader — what the scheduler actually runs — uses the edited value.
    const loaded = loadAgentMdJobs(path.join(stateDir, 'jobs', 'schedule'), path.join(stateDir, 'jobs'));
    expect(loaded.jobs.find(j => j.slug === 'health-check')?.schedule).toBe(edited);
  });

  it('documents the durable schedule edit in an existing CLAUDE.md, idempotently', () => {
    const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md', '',
      '**Job Scheduler** — Run tasks on a schedule. Jobs in `.instar/jobs.json`.',
      '- Trigger: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/jobs/SLUG/trigger`',
      '',
    ].join('\n'));
    const once = fresh();
    newMigrator(projectDir).migrateClaudeMd(once);
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain(BUILTIN_SCHEDULE_EDIT_AWARENESS);
    expect(once.upgraded).toContain('CLAUDE.md: documented durable built-in job schedule edits');

    const twice = fresh();
    newMigrator(projectDir).migrateClaudeMd(twice);
    const again = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(again.split('shippedSchedule').length).toBe(content.split('shippedSchedule').length);
    expect(twice.upgraded).not.toContain('CLAUDE.md: documented durable built-in job schedule edits');
  });
});
