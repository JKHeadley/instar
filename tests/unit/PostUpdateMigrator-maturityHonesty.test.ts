/**
 * Verifies PostUpdateMigrator backfills the "Maturity honesty (silent-by-default
 * user announcements)" guidance into existing agents' CLAUDE.md on update
 * (mature-update-announcements spec — Migration Parity Standard).
 *
 * New agents get the guidance via generateClaudeMd; existing agents update in
 * place and only receive it through this migration. An agent that doesn't know
 * announcements are now opt-in + maturity-tagged would self-narrate ships the
 * old (overselling) way — so the migration is required for the feature to be
 * complete fleet-wide.
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

const MARKER = 'Maturity honesty (silent-by-default user announcements)';

describe('PostUpdateMigrator — maturity-honesty CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-maturity-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-maturityHonesty.test.ts:cleanup',
    });
  });

  it('adds the section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes(MARKER))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MARKER);
    expect(after).toContain('opt-in and maturity-tagged');
    expect(after).toContain('⚗️ Experimental');
    expect(after).toContain('mature-update-announcements');
  });

  it('is idempotent — re-running does not add a duplicate section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.upgraded.some(u => u.includes(MARKER))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    const headingMatches = afterSecond.match(/### Maturity honesty \(silent-by-default user announcements\)/g);
    expect(headingMatches?.length).toBe(1);
  });

  it('does not double-patch an agent that already has the marker (template parity)', () => {
    // A freshly-initialized agent's CLAUDE.md carries the marker inline; the
    // migration must skip it.
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n- **${MARKER}**: already here.\n`);

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.upgraded.some(u => u.includes(MARKER))).toBe(false);
  });

  it('preserves existing CLAUDE.md content', () => {
    const original = '# CLAUDE.md\n\n## My Custom Section\n\nKeep this.\n';
    fs.writeFileSync(claudeMdPath, original);

    runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(after.startsWith(original)).toBe(true);
  });
});

describe('generateClaudeMd template includes the maturity-honesty guidance', () => {
  it('the source template emits the marker so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain(MARKER);
  });
});
