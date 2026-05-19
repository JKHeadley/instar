/**
 * Verifies the framework-neutral telegram-reply.sh mirror added for the
 * cross-framework portability audit (Gap 4).
 *
 * Before this: telegram-reply.sh was installed ONLY under .claude/scripts/.
 * The SessionStart hook and the IdentityRenderer relay appendix prefer
 * .instar/scripts/telegram-reply.sh (because .instar/ exists for every
 * runtime, .claude/scripts/ only for Claude Code), but the neutral copy was
 * never created — so a Codex/Gemini install was instructed (via AGENTS.md) to
 * run a script that did not exist.
 *
 * After this: migrateScripts mirrors the same generated content to
 * .instar/scripts/telegram-reply.sh with install-if-missing semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function createMigrator(projectDir: string, hasTelegram = true): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram,
    projectName: 'test-agent',
  });
}

function runMigrateScripts(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateScripts(r: MigrationResult): void }).migrateScripts(result);
  return result;
}

describe('PostUpdateMigrator — framework-neutral telegram-reply mirror (Gap 4)', () => {
  let projectDir: string;
  let claudePath: string;
  let neutralPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-neutral-relay-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudePath = path.join(projectDir, '.claude', 'scripts', 'telegram-reply.sh');
    neutralPath = path.join(projectDir, '.instar', 'scripts', 'telegram-reply.sh');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-neutralRelayPath.test.ts',
    });
  });

  it('installs telegram-reply.sh at BOTH .claude/scripts and .instar/scripts', () => {
    const result = runMigrateScripts(createMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(fs.existsSync(claudePath)).toBe(true);
    expect(fs.existsSync(neutralPath)).toBe(true);

    // Same generated content in both locations.
    expect(fs.readFileSync(neutralPath, 'utf-8')).toBe(fs.readFileSync(claudePath, 'utf-8'));
    expect(result.upgraded.some(u => u.includes('.instar/scripts/telegram-reply.sh'))).toBe(true);
  });

  it('the neutral copy is executable', () => {
    runMigrateScripts(createMigrator(projectDir));
    const mode = fs.statSync(neutralPath).mode & 0o777;
    expect(mode & 0o100).toBeTruthy(); // owner-execute bit set
  });

  it('is idempotent — second run does not re-report the neutral install', () => {
    runMigrateScripts(createMigrator(projectDir));
    const second = runMigrateScripts(createMigrator(projectDir));
    expect(second.errors).toEqual([]);
    expect(second.upgraded.some(u => u.includes('.instar/scripts/telegram-reply.sh (framework-neutral relay)'))).toBe(false);
    expect(fs.existsSync(neutralPath)).toBe(true);
  });

  it('does nothing when Telegram is not configured', () => {
    runMigrateScripts(createMigrator(projectDir, /* hasTelegram */ false));
    expect(fs.existsSync(neutralPath)).toBe(false);
    expect(fs.existsSync(claudePath)).toBe(false);
  });
});
