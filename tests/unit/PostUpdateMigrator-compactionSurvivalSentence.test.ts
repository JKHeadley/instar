/**
 * context-budget-layered-summaries §9.1 — the CLAUDE.md "Compaction Survival"
 * sentence promised a recovery hook that never ran on Claude Code. The template
 * and the migration both carry the corrected sentence, which names the block a
 * session should see after a compaction. Migration Parity: existing agents get
 * it on update; idempotent on a second run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const OLD = "The compaction-recovery hook re-injects all of this. If it doesn't fire, read `.instar/AGENT.md` immediately.";
const NEW_MARK = '=== IDENTITY RECOVERY (post-compaction) ===';

function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('Compaction Survival sentence correction', () => {
  let projectDir: string;
  let claudeMd: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cs-migrate-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-compactionSurvivalSentence.test.ts' });
  });

  it('replaces the old sentence in an existing agent and is idempotent', () => {
    fs.writeFileSync(claudeMd, `# CLAUDE.md\n\n## Compaction Survival\n\n**What compaction erases**: Your name. ${OLD}\n`);
    const first = run(projectDir);
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain('CLAUDE.md: corrected the Compaction Survival recovery sentence');
    const after = fs.readFileSync(claudeMd, 'utf-8');
    expect(after).not.toContain(OLD);
    expect(after).toContain(NEW_MARK);
    const second = run(projectDir);
    expect(second.upgraded).not.toContain('CLAUDE.md: corrected the Compaction Survival recovery sentence');
    expect(fs.readFileSync(claudeMd, 'utf-8').split(NEW_MARK).length).toBe(2);
  });

  it('the template already carries the corrected sentence', () => {
    const md = generateClaudeMd('test', 'Echo', 4042, false);
    expect(md).not.toContain(OLD);
    expect(md).toContain(NEW_MARK);
  });
});
