/**
 * Verifies PostUpdateMigrator backfills the "Update-Relevance Gate" guidance into
 * existing agents' CLAUDE.md on update (update-relevance-gate spec — Migration
 * Parity Standard).
 *
 * New agents get the guidance via generateClaudeMd; existing agents update in
 * place and only receive it through this migration. An agent that doesn't know a
 * self-narrated update may be silently WITHHELD would treat a 200 {suppressed:true}
 * as an error to retry, and wouldn't know to write updates in plain owner-facing
 * terms — so the migration is required for the feature to be complete fleet-wide.
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

// The content-sniff marker shared by the template bullet and the migration section.
const MARKER = 'a self-narrated update may be silently withheld';

describe('PostUpdateMigrator — update-relevance-gate CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-update-relevance-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-updateRelevanceGate.test.ts:cleanup',
    });
  });

  it('adds the section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('Update-Relevance Gate'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MARKER);
    expect(after).toContain('{ok:true, suppressed:true}');
    expect(after).toContain('logs/update-relevance.jsonl');
    expect(after).toContain('docs/specs/update-relevance-gate.md');
  });

  it('is idempotent — re-running does not add a duplicate section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.upgraded.some((u) => u.includes('Update-Relevance Gate'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    const headingMatches = afterSecond.match(
      /### Update-Relevance Gate \(a self-narrated update may be silently withheld\)/g,
    );
    expect(headingMatches?.length).toBe(1);
  });

  it('does not double-patch an agent that already has the marker (template parity)', () => {
    // A freshly-initialized agent's CLAUDE.md carries the marker inline; the
    // migration must skip it.
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n- **Relevance gate (${MARKER})**: already here.\n`);

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.upgraded.some((u) => u.includes('Update-Relevance Gate'))).toBe(false);
  });

  it('preserves existing CLAUDE.md content', () => {
    const original = '# CLAUDE.md\n\n## My Custom Section\n\nKeep this.\n';
    fs.writeFileSync(claudeMdPath, original);

    runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(after.startsWith(original)).toBe(true);
  });
});

describe('generateClaudeMd template includes the update-relevance-gate guidance', () => {
  it('the source template emits the marker so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain(MARKER);
  });
});
