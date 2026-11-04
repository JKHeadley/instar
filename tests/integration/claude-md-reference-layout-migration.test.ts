/**
 * Integration: a full PostUpdateMigrator.migrate() over an existing agent's
 * ~500k legacy CLAUDE.md (docs/specs/claude-md-reference-layout.md §2.4).
 * Every other migration runs first, then the conversion; AGENTS.md mirroring
 * keeps working from the canonical document once CLAUDE.md is small.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import {
  CLAUDE_MD_CORE_BUDGET_CHARS,
  CLAUDE_MD_LEGACY_BACKUP_REL,
  REFERENCE_DIR_REL,
  findCoreRegion,
} from '../../src/scaffold/claudeMdLayout.js';

describe('CLAUDE.md reference layout — full migrate() on a legacy agent', () => {
  let tmp: string;
  let projectDir: string;
  let stateDir: string;
  let legacy: string;
  let first: { upgraded: string[]; errors: string[] };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-layout-int-'));
    projectDir = path.join(tmp, 'agent');
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'legacy', port: 4043 }));
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Legacy\n\n## Who I Am\n\nI am Legacy.\n');
    // A legacy agent: the old full template plus an operator's own section.
    legacy = generateClaudeMd('legacy', 'Legacy', 4043, false) + '\n## Shop Rules\n\nNever ship on Fridays.\n';
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), legacy);
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# AGENTS.md — legacy\n\nCodex shadow.\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir, port: 4043, hasTelegram: false, projectName: 'legacy' });
    first = m.migrate();
  }, 300_000);

  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/claude-md-reference-layout-migration.test.ts' });
  });

  it('produces the small CLAUDE.md, the backup, the reference files and keeps the operator section', () => {
    const claudeMd = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(first.errors.filter(e => /CLAUDE|reference/i.test(e))).toEqual([]);
    expect(claudeMd.length).toBeLessThan(CLAUDE_MD_CORE_BUDGET_CHARS);
    expect(findCoreRegion(claudeMd)).not.toBeNull();
    expect(claudeMd).toContain('Never ship on Fridays.');
    expect(claudeMd).toContain('I am Legacy,');
    expect(fs.readFileSync(path.join(projectDir, CLAUDE_MD_LEGACY_BACKUP_REL), 'utf-8').length).toBeGreaterThanOrEqual(legacy.length);
    const refDir = path.join(projectDir, REFERENCE_DIR_REL);
    const files = fs.readdirSync(refDir);
    expect(files).toContain('INDEX.md');
    expect(files.length).toBeGreaterThan(8);
    // Migration-appended sections (not in the template) reach the reference files.
    const allRef = files.map(f => fs.readFileSync(path.join(refDir, f), 'utf-8')).join('\n');
    expect(allRef).toContain('### Quota-enforcement scheduler pause');
    expect(first.upgraded.some(u => u.startsWith('CLAUDE.md: moved'))).toBe(true);
  });

  it('AGENTS.md mirroring still gets its capability sections', () => {
    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('### Quota-enforcement scheduler pause');
  });

  it('a second migrate() leaves CLAUDE.md and the reference files unchanged', () => {
    const before = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    const m = new PostUpdateMigrator({ projectDir, stateDir, port: 4043, hasTelegram: false, projectName: 'legacy' });
    const second = m.migrate();
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8')).toBe(before);
    expect(second.upgraded.filter(u => /CLAUDE\.md|reference/.test(u))).toEqual([]);
  }, 300_000);
});
