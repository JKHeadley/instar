/**
 * Fresh-install lifecycle (production scaffold path): `instar init --standalone`
 * writes a CLAUDE.md far under Claude Code's 150k limit, carrying the core
 * rules and the "read on demand" table, with every feature section in
 * .instar/reference/ (docs/specs/claude-md-reference-layout.md §2.3). The
 * first server start runs the migrator over it, which must leave it small.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../src/commands/init.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  CLAUDE_MD_CORE_BUDGET_CHARS,
  CLAUDE_MD_LEGACY_BACKUP_REL,
  REFERENCE_DIR_REL,
  findCoreRegion,
} from '../../src/scaffold/claudeMdLayout.js';

describe('fresh init writes the small CLAUDE.md + reference files', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-claude-md-layout-init-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    SafeFsExecutor.safeRmSync(tmpHome, { recursive: true, force: true, operation: 'tests/e2e/claude-md-reference-layout-init-lifecycle.test.ts' });
  });

  it('standalone init → small CLAUDE.md with dispatch table; first update keeps it small', async () => {
    const agentName = 'cml-' + Math.random().toString(36).slice(2, 8);
    await initProject({ name: agentName, standalone: true, port: 4098, skipPrereqs: true });
    const agentDir = path.join(tmpHome, '.instar', 'agents', agentName);
    const claudeMdPath = path.join(agentDir, 'CLAUDE.md');

    const md = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(md.length).toBeLessThan(CLAUDE_MD_CORE_BUDGET_CHARS);
    expect(findCoreRegion(md)).not.toBeNull();
    expect(md).toContain('## Instar Reference — read on demand');
    expect(md).toContain('### Self-Discovery');
    expect(fs.existsSync(path.join(agentDir, CLAUDE_MD_LEGACY_BACKUP_REL))).toBe(false);

    const refDir = path.join(agentDir, REFERENCE_DIR_REL);
    const index = fs.readFileSync(path.join(refDir, 'INDEX.md'), 'utf-8');
    expect(index).toContain('Normal-Chrome browser');
    const allRef = fs.readdirSync(refDir).map(f => fs.readFileSync(path.join(refDir, f), 'utf-8')).join('\n');
    expect(allRef).toContain('### Normal-Chrome browser (account-bound web tasks, macOS + Windows)');

    // First server start: the migrator runs (now with Telegram configured).
    const result = new PostUpdateMigrator({
      projectDir: agentDir, stateDir: path.join(agentDir, '.instar'), port: 4098, hasTelegram: true, projectName: agentName,
    }).migrate();
    expect(result.errors.filter(e => /CLAUDE|reference/i.test(e))).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after.length).toBeLessThan(CLAUDE_MD_CORE_BUDGET_CHARS);
    expect(after).toContain('## Telegram Relay');
    expect(after).not.toContain('Kept from the previous CLAUDE.md');
  }, 300_000);
});
