/**
 * Integration test (Tier 2) for the briefing-injection fix.
 *
 * Asserts that when the PostUpdateMigrator runs migrateHooks against a fresh
 * .instar/hooks/instar directory, the installed telegram-topic-context.sh
 * file CONTAINS the /topic-intent/:id/briefing fetch in both the
 * authenticated and unauthenticated branches.
 *
 * Spec: docs/specs/topic-intent-briefing-injection.md (FAIL-mac-lan-001).
 *
 * The drift that this test catches end-to-end (the original failure mode):
 * the prior migrator wrote a hook file that did NOT include the briefing
 * fetch, so the per-prompt context lacked the topic-intent briefing on
 * every Echo-shaped agent. After this fix, the file on disk has the fetch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    projectName: 'briefing-injection-it',
  });
}

function runMigrateHooks(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateHooks(r: MigrationResult): void }).migrateHooks(result);
  return result;
}

describe('PostUpdateMigrator integration — telegram-topic-context briefing fetch', () => {
  let projectDir: string;
  let installedHookPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-briefing-injection-it-'));
    fs.mkdirSync(path.join(projectDir, '.instar', 'hooks', 'instar'), { recursive: true });
    installedHookPath = path.join(
      projectDir,
      '.instar',
      'hooks',
      'instar',
      'telegram-topic-context.sh',
    );
  });

  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(projectDir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/PostUpdateMigrator-telegramTopicContextBriefing',
      });
    } catch {
      /* best-effort */
    }
  });

  it('installs telegram-topic-context.sh', () => {
    const migrator = newMigrator(projectDir);
    runMigrateHooks(migrator);
    expect(fs.existsSync(installedHookPath)).toBe(true);
    const stat = fs.statSync(installedHookPath);
    expect(stat.size).toBeGreaterThan(0);
    // 755 — executable bit set
    expect((stat.mode & 0o111) !== 0).toBe(true);
  });

  it('installed file contains the topic-intent briefing fetch in both auth branches', () => {
    const migrator = newMigrator(projectDir);
    runMigrateHooks(migrator);
    const installed = fs.readFileSync(installedHookPath, 'utf-8');
    // The original bug: this curl line was absent from the installed hook.
    const matches = installed.match(/topic-intent\/\$\{TOPIC_ID\}\/briefing/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
    // 2-second timeout per the degrade-open design
    expect(installed).toContain('--max-time 2');
  });

  it('preserves the recent-message-history block and the unanswered-message detector', () => {
    const migrator = newMigrator(projectDir);
    runMigrateHooks(migrator);
    const installed = fs.readFileSync(installedHookPath, 'utf-8');
    // Recent-history fetch (the existing behaviour, must not regress)
    expect(installed).toContain('/telegram/topics/${TOPIC_ID}/messages?limit=30');
    // Unanswered-message guidance (the existing behaviour, must not regress)
    expect(installed).toContain('UNANSWERED MESSAGE(S) FROM USER');
    expect(installed).toContain('You MUST address these messages substantively');
  });

  it('migrator log line reflects the briefing capability so operators see the impact', () => {
    const migrator = newMigrator(projectDir);
    const result = runMigrateHooks(migrator);
    const tracked = result.upgraded.find(line =>
      line.startsWith('hooks/instar/telegram-topic-context.sh'),
    );
    expect(tracked).toBeDefined();
    expect(tracked).toContain('briefing');
  });
});
