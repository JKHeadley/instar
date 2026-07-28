/**
 * P3 migration-parity test (spec §10): existing Codex agents must get the
 * per-project .codex/hooks.json on UPDATE, not just on init.
 *
 * installCodexHooks runs from init's refreshHooksAndSettings; the update path is
 * PostUpdateMigrator. Without the migrateHooks codex block, an existing Codex
 * agent would receive the updated gate scripts but never the registration that
 * makes Codex fire them — "works for new agents only" = broken (Migration Parity
 * Standard). This proves the migrate path writes the registration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import type { MigrationResult } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let projectDir: string;

function setup(enabledFrameworks: string[]): void {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-migrate-'));
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.instar', 'config.json'),
    JSON.stringify({ port: 4042, projectName: 'migrate-test', enabledFrameworks }),
  );
}

function runMigrateHooks(): MigrationResult {
  const migrator = new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'migrate-test',
  });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateHooks(r: MigrationResult): void }).migrateHooks(result);
  return result;
}

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-codexHooks.test.ts:cleanup' });
});

describe('PostUpdateMigrator — Codex enforcement-hook registration (migration parity)', () => {
  it('writes .codex/hooks.json for an existing codex-cli agent on update', () => {
    setup(['codex-cli']);
    const result = runMigrateHooks();
    const hooksPath = path.join(projectDir, '.codex', 'hooks.json');
    expect(fs.existsSync(hooksPath), 'migrate path did not register Codex hooks').toBe(true);
    const cfg = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    const pre = cfg.hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(pre.some((c: string) => c.includes('dangerous-command-guard.sh'))).toBe(true);
    const stop = cfg.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stop.some((c: string) => c.includes('stop-gate-router.js'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.instar', 'hooks', 'instar', 'stop-gate-router.js'))).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('.codex/hooks.json'))).toBe(true);
  });

  it('does NOT write .codex/hooks.json for a claude-only agent', () => {
    setup(['claude-code']);
    runMigrateHooks();
    expect(fs.existsSync(path.join(projectDir, '.codex', 'hooks.json'))).toBe(false);
  });

  it('is idempotent across repeated migrations (no duplicate instar groups)', () => {
    setup(['codex-cli']);
    runMigrateHooks();
    runMigrateHooks();
    const cfg = JSON.parse(fs.readFileSync(path.join(projectDir, '.codex', 'hooks.json'), 'utf-8'));
    const instarPre = cfg.hooks.PreToolUse.filter((g: any) =>
      g.hooks.some((h: any) => h.command.includes('.instar/hooks/instar/')),
    );
    expect(instarPre).toHaveLength(1);
  });
});
