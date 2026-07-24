/**
 * Verifies PostUpdateMigrator documents the DURABLE built-in job enablement
 * surface in existing agents' CLAUDE.md on update.
 *
 * Discovered 2026-07-23 the expensive way. Enabling a built-in job by editing
 * `enabled: true` in `.instar/jobs/instar/<slug>.md` is FUTILE: installBuiltinJobs
 * regenerates that markdown from the shipped template on every update (the same
 * always-overwrite rule as built-in hooks), so the edit reverts silently — observed
 * ~20 minutes later on a live machine. The durable setting is `enabled` in
 * `.instar/jobs/schedule/<slug>.json`, which installBuiltinJobs explicitly PRESERVES
 * and which AgentMdJobLoader actually reads.
 *
 * The failure is silent in the worst way: the `.md` carries a visible `enabled:`
 * line that looks authoritative, the edit appears to work, the file shows the new
 * value — and then it quietly reverts. Nothing in the agent-facing surface said
 * otherwise, so an agent reaches for the wrong file, watches it fail, and can
 * reasonably conclude no durable path exists at all (which is exactly what
 * happened, and produced a false blocker report to the operator).
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

const JOB_SCHEDULER_BLOCK = [
  '**Job Scheduler** — Run tasks on a schedule. Jobs in `.instar/jobs.json`.',
  '- View: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/jobs`',
  '- Trigger: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/jobs/SLUG/trigger`',
  '',
  '**Sessions** — Spawn and manage sessions.',
].join('\n');

describe('PostUpdateMigrator — built-in job enablement surface', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-jobenable-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-jobEnableSurface.test.ts',
    });
  });

  it('adds the bullet to an existing agent that has a Job Scheduler section', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${JOB_SCHEDULER_BLOCK}\n`);
    const result = runClaudeMdMigration(newMigrator(projectDir));

    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('Enabling/disabling a BUILT-IN job');
    // The load-bearing facts: WHICH file is durable, and WHY the other one lies.
    expect(content).toContain('.instar/jobs/schedule/<slug>.json');
    expect(content).toContain('regenerated from the shipped template on EVERY update');
    expect(result.upgraded.some((u) => u.includes('built-in job enablement'))).toBe(true);
  });

  it('inserts the bullet INSIDE the Job Scheduler block, right after the Trigger line', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${JOB_SCHEDULER_BLOCK}\n`);
    runClaudeMdMigration(newMigrator(projectDir));

    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const trigger = content.indexOf('/jobs/SLUG/trigger');
    const bullet = content.indexOf('Enabling/disabling a BUILT-IN job');
    const sessions = content.indexOf('**Sessions**');
    expect(trigger).toBeGreaterThan(-1);
    expect(bullet).toBeGreaterThan(trigger);
    // Must land before the NEXT section, or it reads as Sessions guidance.
    expect(bullet).toBeLessThan(sessions);
  });

  it('is IDEMPOTENT — a second run does not duplicate the bullet', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${JOB_SCHEDULER_BLOCK}\n`);
    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.split('Enabling/disabling a BUILT-IN job').length - 1).toBe(1);
    expect(second.upgraded.some((u) => u.includes('built-in job enablement'))).toBe(false);
  });

  it('does NOT add the bullet to a CLAUDE.md with no Job Scheduler section', () => {
    // No scheduler surface ⇒ nothing to annotate; the migration must not append
    // orphaned guidance to an unrelated document.
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nSomething else entirely.\n');
    runClaudeMdMigration(newMigrator(projectDir));

    expect(fs.readFileSync(claudeMdPath, 'utf-8')).not.toContain('Enabling/disabling a BUILT-IN job');
  });

  it('falls back to appending when the Trigger anchor is absent (older CLAUDE.md)', () => {
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n**Job Scheduler** — Run tasks on a schedule.\n- View: `GET /jobs`\n',
    );
    runClaudeMdMigration(newMigrator(projectDir));

    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('Enabling/disabling a BUILT-IN job');
  });
});
