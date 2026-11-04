/**
 * Verifies PostUpdateMigrator adds the Mid-Work Resume Queue section to
 * existing agents' CLAUDE.md on update (Migration Parity Standard + Agent
 * Awareness — an agent that doesn't know /sessions/resume-queue exists will
 * tell the user their interrupted work is simply gone), and that the config
 * defaults registration matches the reap-notify spec exactly (perTopic +
 * maxImmediatePerFlush registered; drainEnabled + resumeQueue.* deliberately
 * CODE-defaulted so the later fleet flip of dryRun takes effect).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { getMigrationDefaults } from '../../src/config/ConfigDefaults.js';

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

describe('PostUpdateMigrator — Mid-Work Resume Queue CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-resumequeue-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-resumeQueueSection.test.ts:cleanup',
    });
  });

  it('patches the installed lifeline sentence so routine job completions are described as reap-log only (idempotent)', () => {
    const oldSentence = '(bursts coalesce per topic; unbound sessions + a cross-topic index go to the lifeline)';
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\nEach topic gets ONE notice ${oldSentence}. /sessions/resume-queue\n`);
    const first = runClaudeMdMigration(newMigrator(projectDir));
    expect(first.upgraded).toContain('CLAUDE.md: reap notices — routine job completions stay in the reap-log');
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).not.toContain(oldSentence);
    expect(after).toContain('except a background job whose work completed normally, which stays in the reap-log only');
    const second = runClaudeMdMigration(newMigrator(projectDir));
    expect(second.upgraded).not.toContain('CLAUDE.md: reap notices — routine job completions stay in the reap-log');
    expect(fs.readFileSync(claudeMdPath, 'utf-8').match(/stays in the reap-log only/g)).toHaveLength(1);
  });

  it("patches the Reap-log section's own sentence too (idempotent)", () => {
    const oldSentence = '(bursts coalesce per topic; the lifeline gets unbound sessions + a cross-topic index)';
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n- Notices are PER-TOPIC ${oldSentence}. /sessions/resume-queue\n`);
    const first = runClaudeMdMigration(newMigrator(projectDir));
    expect(first.upgraded).toContain('CLAUDE.md: reap-log section — routine job completions stay in the reap-log');
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).not.toContain(oldSentence);
    const second = runClaudeMdMigration(newMigrator(projectDir));
    expect(second.upgraded).not.toContain('CLAUDE.md: reap-log section — routine job completions stay in the reap-log');
    expect(fs.readFileSync(claudeMdPath, 'utf-8').match(/stays in the reap-log only/g)).toHaveLength(1);
  });

  it('a freshly added section already carries the routine-completion wording', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    runClaudeMdMigration(newMigrator(projectDir));
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toContain('which stays in the reap-log only');
  });

  it('adds the section when CLAUDE.md does not contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.upgraded).toContain('CLAUDE.md: added Mid-Work Resume Queue section');
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('## Mid-Work Resume Queue & Per-Topic Reap Notices');
    expect(content).toContain('/sessions/resume-queue');
    expect(content).toContain('resumeOnReap: true');
  });

  it('is idempotent — a second run skips without duplicating', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    runClaudeMdMigration(newMigrator(projectDir));
    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    expect(result2.skipped).toContain('CLAUDE.md: Mid-Work Resume Queue section already present');
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const occurrences = content.split('## Mid-Work Resume Queue & Per-Topic Reap Notices').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('ConfigDefaults — reap-notify spec registration discipline', () => {
  const monitoring = (getMigrationDefaults('standalone') as { monitoring: Record<string, unknown> }).monitoring;

  it('registers reapNotify.perTopic + maxImmediatePerFlush (nested-merge adds them on update)', () => {
    const reapNotify = monitoring.reapNotify as Record<string, unknown>;
    expect(reapNotify.perTopic).toBe(true);
    expect(reapNotify.maxImmediatePerFlush).toBe(5);
  });

  it('deliberately does NOT register drainEnabled or any resumeQueue key (code-defaulted for the fleet flip)', () => {
    const reapNotify = monitoring.reapNotify as Record<string, unknown>;
    expect('drainEnabled' in reapNotify).toBe(false);
    expect('resumeQueue' in monitoring).toBe(false);
  });
});
