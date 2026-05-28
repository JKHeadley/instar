/**
 * Wiring + safe-skip smoke test for migrateRuntimeRoot (macOS 26 TCC relocation
 * orchestrator). The decision logic (classifyRelocation), the move engine
 * (relocateRuntime), and the spool (EscalationSpool) are each fully unit-tested
 * in their own suites; the orchestrator's blocked/relocate ACTION branches get
 * end-to-end coverage in the Tier-3 b2lead reproduction. Here we verify:
 *   - it is wired into migrate() (not dead code),
 *   - it safely skips the common case (temp project dir, NOT under a TCC folder)
 *     without throwing or mutating anything,
 *   - the already-relocated short-circuit fires even when the source is
 *     unreadable (the NEW-R1 launchd-context regression guard).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { RELOCATE_SCHEMA_VERSION } from '../../src/core/InstarRuntimeRoot.js';

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

function runRuntimeRoot(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateRuntimeRoot(r: MigrationResult): void }).migrateRuntimeRoot(result);
  return result;
}

describe('PostUpdateMigrator — migrateRuntimeRoot orchestration', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rrmig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), JSON.stringify({ projectName: 'test' }));
  });

  afterEach(() => {
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('is wired into migrate() (appears in the migration result)', () => {
    const migrator = newMigrator(projectDir);
    const full = (migrator as unknown as { migrate(): MigrationResult }).migrate();
    const allEntries = [...full.upgraded, ...full.skipped, ...full.errors];
    expect(allEntries.some((e) => e.startsWith('runtime-root:'))).toBe(true);
  });

  it('safely skips a temp project dir that is not under a TCC folder — no throw, no mutation', () => {
    const migrator = newMigrator(projectDir);
    const before = fs.readdirSync(path.join(projectDir, '.instar')).sort();
    const result = runRuntimeRoot(migrator);
    expect(result.errors).toHaveLength(0);
    expect(result.upgraded).toHaveLength(0);
    expect(result.skipped.some((s) => s.startsWith('runtime-root:'))).toBe(true);
    // On macOS the reason is "not under a TCC-protected folder"; on Linux it's
    // "non-darwin". Either way, nothing moved and .instar is untouched.
    expect(fs.lstatSync(path.join(projectDir, '.instar')).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(path.join(projectDir, '.instar')).sort()).toEqual(before);
  });

  it('already-relocated short-circuits even when source config is unreadable (NEW-R1)', () => {
    // Simulate a relocated agent: stateDir holds a complete relocate.json.
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'relocate.json'),
      JSON.stringify({ completed: true, schemaVersion: RELOCATE_SCHEMA_VERSION, runtimeRoot: '/x' }),
    );
    // Make the source config unreadable to mimic a launchd/TCC-blind re-run.
    const cfg = path.join(projectDir, '.instar', 'config.json');
    try { fs.chmodSync(cfg, 0o000); } catch { /* some CI FS ignore perms */ }

    const result = runRuntimeRoot(newMigrator(projectDir));
    try { fs.chmodSync(cfg, 0o644); } catch { /* restore for cleanup */ }

    expect(result.errors).toHaveLength(0);
    expect(result.skipped.some((s) => s.includes('already relocated'))).toBe(true);
    // Did NOT attempt a move.
    expect(fs.lstatSync(path.join(projectDir, '.instar')).isSymbolicLink()).toBe(false);
  });
});
