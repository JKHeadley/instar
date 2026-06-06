/**
 * Verifies PostUpdateMigrator rewrites the stale "Record a manual cycle" line
 * in existing agents' CLAUDE.md so it teaches the transcript-audit gate
 * (#864 follow-through — Migration Parity Standard).
 *
 * Agents that already carry the Apprenticeship Program section never re-trigger
 * the section-level sniff, so without this targeted line rewrite they would keep
 * teaching the pre-gate POST shape — and every telegram-playwright cycle they
 * record would 400 with no idea why. The line rewrite is the only update path.
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

const STALE_LINE =
  '- Record a manual cycle: `POST /apprenticeship/cycles` with `instanceId`, positive `cycleNumber`, `task`, `menteeOutput`, optional `mentorFlagged` / `overseerDifferential` / `coaching` / `infraItems`, `kind` (`mentor-mentee-differential`, `overseer-apprentice-devreview`, `overseer-mentee-direct`), and `channel` (`telegram-playwright`, `threadline-backup`, `direct-shortcut`, `unknown`). Use this when the overseer or manual loop found a differential outside the automated mentor tick.';

describe('PostUpdateMigrator — transcript-audit gate cycle-record line rewrite', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tagate-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-transcriptAuditGate.test.ts:cleanup',
    });
  });

  it('rewrites the stale pre-gate line in place (agents that already have the section)', () => {
    fs.writeFileSync(
      claudeMdPath,
      `# CLAUDE.md\n\n**Apprenticeship Program**\n\nThe standing program.\n${STALE_LINE}\n- **When to use** (PROACTIVE): drive it through the registry.\n`,
    );
    const result = runClaudeMdMigration(newMigrator(projectDir));

    const content = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content).toContain('transcriptAudit');
    expect(content).toContain('dev:post-drive-transcript-audit');
    expect(content).toContain('--history-base-url');
    expect(content).not.toContain(STALE_LINE);
    expect(result.upgraded).toContain('CLAUDE.md: cycle-record line now teaches the transcript-audit gate');
  });

  it('is idempotent — a second run does not change the file or report an upgrade', () => {
    fs.writeFileSync(
      claudeMdPath,
      `# CLAUDE.md\n\n**Apprenticeship Program**\n\nThe standing program.\n${STALE_LINE}\n`,
    );
    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf8');

    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf8');

    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded).not.toContain('CLAUDE.md: cycle-record line now teaches the transcript-audit gate');
  });

  it('does not fire on a CLAUDE.md without the apprenticeship cycle line', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nNo apprenticeship section here.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.upgraded).not.toContain('CLAUDE.md: cycle-record line now teaches the transcript-audit gate');
  });

  it('a freshly-added section (via the section migration) already carries the new line — the rewrite never double-fires', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nBare agent.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    // The section migration adds the NEW line; the rewrite must not also report.
    expect(result.upgraded).toContain('CLAUDE.md: added Apprenticeship Program section');
    expect(result.upgraded).not.toContain('CLAUDE.md: cycle-record line now teaches the transcript-audit gate');
    const content = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content).toContain('transcriptAudit');
  });
});
