/**
 * Verifies PostUpdateMigrator adds the Dynamic MCP Lifecycle CLAUDE.md section to
 * EXISTING agents (Agent Awareness + Migration Parity), honestly dark-tagged, and
 * that the migration is idempotent. Also asserts generateClaudeMd (new agents)
 * carries the same section so new + existing agents stay in parity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}
function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Dynamic MCP Lifecycle CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dynmcp-section-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-dynamicMcpSection.test.ts:cleanup' });
  });

  it('adds the section (dark-tagged + key surface) when CLAUDE.md lacks it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('Dynamic MCP Lifecycle'))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Dynamic MCP Lifecycle');
    expect(after).toContain('ships DARK');     // maturity-honest
    expect(after).toContain('/mcp/session/');   // the surface
    expect(after).toContain('needs-approval');  // the C4 authorization rule
  });

  it('is idempotent — a second run does not re-add (content unchanged)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some((u) => u.includes('Dynamic MCP Lifecycle'))).toBe(false);
  });

  it('generateClaudeMd (new agents) carries the same section — parity', () => {
    const md = generateClaudeMd({ projectName: 'test', port: 4042 } as unknown as Parameters<typeof generateClaudeMd>[0]);
    expect(md).toContain('Dynamic MCP Lifecycle');
    expect(md).toContain('/mcp/load');
  });
});
