/**
 * Verifies PostUpdateMigrator backfills the "Quiet update mechanics" guidance
 * into existing agents' CLAUDE.md on update (quiet-update-mechanics spec —
 * Migration Parity Standard).
 *
 * The behavior change (silencing update mechanics) ships in code, so existing
 * agents get it on npm update. But the AWARENESS — that the agent must mirror
 * the same rule when self-narrating its OWN restart/update (no version numbers,
 * no restart plumbing) — only reaches existing agents through this migration. It
 * uses its OWN content-sniff guard, separate from the maturity-honesty marker,
 * so an agent that already has the maturity section still receives this block.
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

const GUARD = 'Quiet update mechanics (version/restart churn';
const HEADING = 'Quiet update mechanics (version/restart churn → logs, not the user)';

describe('PostUpdateMigrator — quiet-update-mechanics CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-quiet-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-quietUpdateMechanics.test.ts:cleanup',
    });
  });

  it('adds the section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('Quiet update mechanics'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(HEADING);
    expect(after).toContain('version-free');
    expect(after).toContain('backgroundRefreshHeartbeat');
    expect(after).toContain('quiet-update-mechanics.md');
  });

  it('is idempotent — re-running does not add a duplicate section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.upgraded.some(u => u.includes('Quiet update mechanics'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    const headingMatches = afterSecond.match(/### Quiet update mechanics/g);
    expect(headingMatches?.length).toBe(1);
  });

  it('still backfills for an agent that ALREADY has the maturity-honesty section', () => {
    // The separate guard is the whole point: maturity honesty present, quiet
    // mechanics absent ⇒ the migration must still add the quiet-mechanics block.
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n### Maturity honesty (silent-by-default user announcements)\n\nAlready here.\n',
    );

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.upgraded.some(u => u.includes('Quiet update mechanics'))).toBe(true);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toContain(HEADING);
  });

  it('does not double-patch an agent that already has the marker', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n- **${GUARD} → logs, not the user)**: already here.\n`);

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.upgraded.some(u => u.includes('Quiet update mechanics'))).toBe(false);
  });
});

describe('generateClaudeMd template includes the quiet-update-mechanics guidance', () => {
  it('the source template emits the marker so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain(GUARD);
  });
});
