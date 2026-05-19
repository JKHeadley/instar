/**
 * Verifies the framework gate added for the cross-framework portability
 * audit (Gap 5). `enabledFrameworks` is now a real, persisted config field;
 * the migrator's getEnabledFrameworks() reads it (default ['claude-code'])
 * and migrateSettings — which only touches Claude Code's .claude/settings.json
 * — skips entirely for a Codex-only install.
 *
 * Critically: the audit's original "wrap legacy steps in a guard" framing
 * would have been INERT, because enabledFrameworks was read defensively but
 * was never a real settable field (always undefined → always defaulted to
 * claude-code → guard never skipped). These tests prove the field is now
 * genuine and the gate is reachable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function migrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test-agent',
  });
}

function writeConfig(stateDir: string, enabledFrameworks?: string[]): void {
  const cfg: Record<string, unknown> = { projectName: 'test-agent' };
  if (enabledFrameworks) cfg.enabledFrameworks = enabledFrameworks;
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(cfg, null, 2));
}

function runMigrateSettings(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateSettings(r: MigrationResult): void }).migrateSettings(result);
  return result;
}

function enabledFrameworksOf(m: PostUpdateMigrator): readonly string[] {
  return (m as unknown as { getEnabledFrameworks(): readonly string[] }).getEnabledFrameworks();
}

describe('PostUpdateMigrator — framework gate (Gap 5)', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fw-gate-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-frameworkGate.test.ts',
    });
  });

  it('getEnabledFrameworks defaults to [claude-code] when config has no field', () => {
    writeConfig(stateDir);
    expect(enabledFrameworksOf(migrator(projectDir))).toEqual(['claude-code']);
  });

  it('getEnabledFrameworks defaults to [claude-code] when config.json is absent', () => {
    expect(enabledFrameworksOf(migrator(projectDir))).toEqual(['claude-code']);
  });

  it('getEnabledFrameworks honors an explicit codex-only config', () => {
    writeConfig(stateDir, ['codex-cli']);
    expect(enabledFrameworksOf(migrator(projectDir))).toEqual(['codex-cli']);
  });

  it('getEnabledFrameworks honors a dual-framework config', () => {
    writeConfig(stateDir, ['claude-code', 'codex-cli']);
    expect(enabledFrameworksOf(migrator(projectDir))).toEqual(['claude-code', 'codex-cli']);
  });

  it('migrateSettings SKIPS for a codex-only install (gate is reachable, not inert)', () => {
    writeConfig(stateDir, ['codex-cli']);
    // Even with a .claude/settings.json present, the gate must short-circuit.
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), '{}');

    const result = runMigrateSettings(migrator(projectDir));

    expect(result.skipped.some(s => s.includes('claude-code not in enabledFrameworks'))).toBe(true);
    expect(result.upgraded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('migrateSettings does NOT skip on the default (claude-code) install', () => {
    writeConfig(stateDir); // no enabledFrameworks → default ['claude-code']
    // No .claude/settings.json → it reaches the normal not-found skip,
    // proving the framework gate did NOT short-circuit first.
    const result = runMigrateSettings(migrator(projectDir));

    expect(result.skipped.some(s => s.includes('claude-code not in enabledFrameworks'))).toBe(false);
    expect(result.skipped.some(s => s.includes('not found — will be created on next init'))).toBe(true);
  });
});
