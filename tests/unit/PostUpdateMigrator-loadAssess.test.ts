/**
 * Robust Load Assessment — migration + hook coverage (CMT-1703).
 * Spec: docs/specs/robust-load-assessment-fleet.md
 *
 * Three guarantees, three tests:
 *  - migrateScripts installs `.instar/scripts/load-assess.sh` (always-overwrite).
 *  - getSessionStartHook() emits the MACHINE LOAD awareness block ABOVE the
 *    `exec compaction-recovery.sh` branch — the load-bearing compaction-survival
 *    property (a tail-placed block would never fire on compact).
 *  - migrateClaudeMd appends the Machine Load Assessment section (idempotent),
 *    and generateClaudeMd carries the same text (Agent-Awareness, no drift).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, MACHINE_LOAD_ASSESSMENT_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function createMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: true,
    projectName: 'test-agent',
  });
}
function runMigrateScripts(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateScripts(r: MigrationResult): void }).migrateScripts(result);
  return result;
}
function runMigrateClaudeMd(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — load-assess.sh install', () => {
  let projectDir: string;
  let scriptPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-load-assess-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    scriptPath = path.join(projectDir, '.instar', 'scripts', 'load-assess.sh');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-loadAssess.test.ts' });
  });

  it('installs .instar/scripts/load-assess.sh on update, executable', () => {
    const result = runMigrateScripts(createMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(scriptPath)).toBe(true);
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('MACHINE LOAD ASSESSMENT');
    expect(content).toContain('load-assess.sh');
    // executable
    expect(fs.statSync(scriptPath).mode & 0o100).toBe(0o100);
  });

  it('is always-overwrite (restores a stale copy, idempotent)', () => {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/bash\n# stale\n', { mode: 0o755 });
    runMigrateScripts(createMigrator(projectDir));
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('MACHINE LOAD ASSESSMENT');
    expect(content).not.toContain('# stale');
    const r2 = runMigrateScripts(createMigrator(projectDir));
    expect(r2.errors).toEqual([]);
  });
});

describe('getSessionStartHook — MACHINE LOAD block survives compaction', () => {
  it('emits the MACHINE LOAD block ABOVE the compact `exec` delegate', () => {
    const m = createMigrator(fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hook-')));
    const hook = (m as unknown as { getSessionStartHook(): string }).getSessionStartHook();
    expect(hook).toContain('--- MACHINE LOAD ---');
    expect(hook).toContain('load-assess.sh');
    const blockIdx = hook.indexOf('--- MACHINE LOAD ---');
    const execIdx = hook.indexOf('exec bash "$INSTAR_DIR/hooks/compaction-recovery.sh"');
    expect(blockIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(-1);
    // The load-bearing property: the block prints BEFORE the process-replacing exec,
    // so its stdout is emitted on the compact path too (compaction-survival).
    expect(blockIdx).toBeLessThan(execIdx);
  });

  it('warns against trusting the uptime load average', () => {
    const m = createMigrator(fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hook2-')));
    const hook = (m as unknown as { getSessionStartHook(): string }).getSessionStartHook();
    expect(hook.toLowerCase()).toContain('load average');
    expect(hook.toLowerCase()).toContain('never');
  });
});

describe('CLAUDE.md — Machine Load Assessment section', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-load-claudemd-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-loadAssess.test.ts' });
  });

  it('migrateClaudeMd appends the section to an existing CLAUDE.md, idempotent', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — instar\n\nExisting content.\n');
    const r1 = runMigrateClaudeMd(createMigrator(projectDir));
    const after1 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after1).toContain('Machine Load Assessment');
    expect(after1).toContain('load-assess.sh');
    expect(r1.upgraded.some((u) => u.includes('Machine Load Assessment'))).toBe(true);
    // idempotent — second run does not duplicate
    runMigrateClaudeMd(createMigrator(projectDir));
    const after2 = fs.readFileSync(claudeMdPath, 'utf-8');
    const count = after2.split('Machine Load Assessment').length - 1;
    expect(count).toBe(1);
  });

  it('generateClaudeMd carries the same section (no new-vs-existing drift)', () => {
    const generated = generateClaudeMd(
      { name: 'test-agent', role: 'test', personality: 'test' } as never,
      { projectName: 'test-agent', projectDir, port: 4042 } as never,
    );
    expect(generated).toContain('Machine Load Assessment');
    // shared single-source: the exported section function feeds both paths
    expect(MACHINE_LOAD_ASSESSMENT_CLAUDEMD_SECTION()).toContain('load-assess.sh');
  });
});
