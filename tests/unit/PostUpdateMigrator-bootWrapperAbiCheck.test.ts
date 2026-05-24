/**
 * Verifies migrateBootWrapperAbiCheck regenerates the boot wrapper for
 * existing .cjs agents that predate the ABI-aware node self-heal, and
 * skips idempotently once the ABI-check marker is present.
 *
 * recurring-SQLite-bane fix: the .js→.cjs migration skips agents already
 * on .cjs, so they never received the selfHealNodeSymlink ABI check.
 * This migration closes that gap.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

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

function run(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateBootWrapperAbiCheck(r: MigrationResult): void }).migrateBootWrapperAbiCheck(result);
  return result;
}

const MARKER = 'cannot load better-sqlite3 (ABI drift)';

describe('PostUpdateMigrator — boot-wrapper ABI-check regeneration', () => {
  let projectDir: string;
  let bootWrapperPath: string;
  const isDarwin = process.platform === 'darwin';

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-bootabi-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    bootWrapperPath = path.join(projectDir, '.instar', 'instar-boot.cjs');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-bootWrapperAbiCheck.test.ts:cleanup',
    });
  });

  it('skips when the boot wrapper already contains the ABI-check marker (idempotent)', () => {
    if (!isDarwin) {
      // On non-darwin the migration short-circuits; assert that instead.
      const result = run(newMigrator(projectDir));
      expect(result.skipped.some(s => s.includes('non-darwin'))).toBe(true);
      return;
    }
    fs.writeFileSync(bootWrapperPath, `#!/usr/bin/env node\n// has the marker: ${MARKER}\n`);
    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('already current'))).toBe(true);
    // Must NOT have rewritten it.
    expect(result.upgraded.some(u => u.includes('ABI-check'))).toBe(false);
  });

  it('skips gracefully when no boot wrapper exists', () => {
    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    if (isDarwin) {
      expect(result.skipped.some(s => s.includes('no instar-boot.cjs'))).toBe(true);
    } else {
      expect(result.skipped.some(s => s.includes('non-darwin'))).toBe(true);
    }
  });

  it('attempts regeneration when the marker is absent (darwin only)', () => {
    if (!isDarwin) return; // installBootWrapper is darwin-launchd-specific
    fs.writeFileSync(bootWrapperPath, '#!/usr/bin/env node\n// old wrapper without ABI logic\n');

    // Spy on installBootWrapper indirectly: it will try to write files. We
    // only assert the migration RECOGNIZED the marker as missing and took
    // the regeneration branch (upgraded OR errored — both prove it didn't
    // silently skip). It must not land in "already current".
    const result = run(newMigrator(projectDir));
    expect(result.skipped.some(s => s.includes('already current'))).toBe(false);
    const tookRegenBranch =
      result.upgraded.some(u => u.includes('ABI-check')) ||
      result.errors.some(e => e.includes('ABI-check'));
    expect(tookRegenBranch).toBe(true);
  });
});
