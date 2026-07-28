/**
 * Session-clock injector — migration coverage (Step 2 delivery).
 *
 * migrateScripts installs `.instar/scripts/emit-session-clock.sh` on every
 * update run (always-overwrite, like secret-drop-retrieve.mjs). Existing agents
 * must receive the time-awareness injector without waiting for a re-init.
 * Spec: docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md (Component 2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
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

describe('PostUpdateMigrator — emit-session-clock.sh install', () => {
  let projectDir: string;
  let clockPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-emit-session-clock-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    clockPath = path.join(projectDir, '.instar', 'scripts', 'emit-session-clock.sh');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-emitSessionClock.test.ts',
    });
  });

  it('installs .instar/scripts/emit-session-clock.sh on update', () => {
    const result = runMigrateScripts(createMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(clockPath)).toBe(true);
    const content = fs.readFileSync(clockPath, 'utf-8');
    expect(content).toContain('SESSION CLOCK');
    expect(content).toContain('render');
    expect(content).toContain('query');
  });

  it('is always-overwrite (idempotent + restores a stale copy)', () => {
    fs.mkdirSync(path.dirname(clockPath), { recursive: true });
    fs.writeFileSync(clockPath, '#!/bin/bash\n# stale\n', { mode: 0o755 });
    runMigrateScripts(createMigrator(projectDir));
    const content = fs.readFileSync(clockPath, 'utf-8');
    expect(content).toContain('SESSION CLOCK');
    expect(content).not.toContain('# stale');
    // re-run is safe
    const r2 = runMigrateScripts(createMigrator(projectDir));
    expect(r2.errors).toEqual([]);
    expect(fs.existsSync(clockPath)).toBe(true);
  });

  it('the installed script is executable (mode 0o755)', () => {
    runMigrateScripts(createMigrator(projectDir));
    const mode = fs.statSync(clockPath).mode & 0o777;
    expect(mode & 0o100).toBe(0o100); // owner-executable
  });
});
