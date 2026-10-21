/**
 * Hand-started Codex connect — Agent Awareness + Migration Parity.
 *
 *  - generateClaudeMd carries the `instar codex connect <agent>` section
 *    (new agents learn the command and the one-agent-at-a-time caveat).
 *  - migrateClaudeMd appends the SAME text to an existing agent's CLAUDE.md
 *    (idempotent: a second run adds nothing).
 *  - The section is on the framework-shadow marker list, so a Codex agent's
 *    AGENTS.md gets it too (the audience IS a Codex operator).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, CODEX_CONNECT_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function runMigrateClaudeMd(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('CODEX_CONNECT_CLAUDEMD_SECTION', () => {
  it('names the command, the dry-run flag, CODEX_HOME, and the one-agent-at-a-time caveat', () => {
    const text = CODEX_CONNECT_CLAUDEMD_SECTION();
    expect(text).toContain('### Hand-started Codex: `instar codex connect <agent>`');
    expect(text).toContain('--dry-run');
    expect(text).toContain('CODEX_HOME');
    expect(text).toContain('ONE agent at a time');
    expect(text).toContain('does NOT write that file at boot');
    expect(text).toContain('-c mcp_servers.threadline.*');
  });

  it('generateClaudeMd carries the section verbatim (Agent Awareness)', () => {
    const md = generateClaudeMd('fixture', 'Fixture', 4042, true);
    expect(md).toContain(CODEX_CONNECT_CLAUDEMD_SECTION().trim());
  });
});

describe('migrateClaudeMd — Hand-started Codex connect section', () => {
  let projectDir: string;
  let claudeMd: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-codex-connect-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# CLAUDE.md — existing agent\n\nSome prior content.\n');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-codexConnect.test.ts' });
  });

  it('appends the section to an existing CLAUDE.md and is idempotent', () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test-agent' });
    const first = runMigrateClaudeMd(m);
    expect(first.upgraded).toContain('CLAUDE.md: added Hand-started Codex connect section');
    const after1 = fs.readFileSync(claudeMd, 'utf-8');
    expect(after1).toContain(CODEX_CONNECT_CLAUDEMD_SECTION().trim());
    expect(after1.split('instar codex connect <agent>').length - 1).toBeGreaterThanOrEqual(1);

    const second = runMigrateClaudeMd(m);
    expect(second.upgraded).not.toContain('CLAUDE.md: added Hand-started Codex connect section');
    const after2 = fs.readFileSync(claudeMd, 'utf-8');
    expect(after2.split('### Hand-started Codex: `instar codex connect <agent>`').length - 1).toBe(1);
  });

  it('is on the framework-shadow marker list (Codex/Gemini agents get it in their shadow file)', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/core/PostUpdateMigrator.ts'), 'utf-8');
    const markersStart = src.indexOf('const markers = [');
    expect(markersStart).toBeGreaterThan(0);
    const markersBlock = src.slice(markersStart, src.indexOf('];', markersStart));
    expect(markersBlock).toContain("'### Hand-started Codex: `instar codex connect <agent>`'");
  });
});
