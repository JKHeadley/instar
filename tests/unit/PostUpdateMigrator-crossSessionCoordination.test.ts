/**
 * Verifies PostUpdateMigrator adds the Cross-Session Coordination guidance section
 * to existing agents' CLAUDE.md on update, and that generateClaudeMd emits it for
 * fresh installs. Spec: docs/specs/cross-session-coordination.md.
 *
 * Migration parity: the coordinator is wired server-side, but the SIGNAL is only
 * useful if a session knows to announce intent before high-impact actions and to
 * STOP-and-confirm on a coordinationWarning. Without this section existing agents
 * would have the routes but never reach for them — a half-shipped feature.
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

const MARKER = 'Cross-Session Coordination (light, advisory)';

describe('PostUpdateMigrator — Cross-Session Coordination guidance', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-xsession-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-crossSessionCoordination.test.ts:cleanup',
    });
  });

  it('adds the section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('Cross-Session Coordination'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MARKER);
    expect(after).toContain('/coordination/intent');
    expect(after).toContain('/coordination/recent');
    expect(after).toContain('X-Instar-Session');
    // The STOP-and-confirm behavioral rule.
    expect(after).toContain('coordinationWarning');
  });

  it('is idempotent — re-running does not add a duplicate section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.errors).toEqual([]);
    expect(result2.upgraded.some(u => u.includes('Cross-Session Coordination'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    const headingMatches = afterSecond.match(/### Cross-Session Coordination \(light, advisory\)/g);
    expect(headingMatches?.length).toBe(1);
  });

  it('preserves existing CLAUDE.md content', () => {
    const original = '# CLAUDE.md\n\n## My Custom Section\n\nDo not delete this.\n';
    fs.writeFileSync(claudeMdPath, original);

    runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(after.startsWith(original)).toBe(true);
    expect(after.length).toBeGreaterThan(original.length);
  });

  it('skips gracefully when CLAUDE.md is missing', () => {
    expect(fs.existsSync(claudeMdPath)).toBe(false);
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('CLAUDE.md'))).toBe(true);
  });
});

describe('generateClaudeMd template includes Cross-Session Coordination section', () => {
  it('the source template emits the section so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain(MARKER);
    expect(templateSource).toContain('/coordination/intent');
    expect(templateSource).toContain('BEFORE any high-impact structural action');
  });
});
