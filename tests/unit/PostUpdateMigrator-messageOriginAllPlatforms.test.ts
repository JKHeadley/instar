/**
 * Migration Parity + Agent Awareness for message-origin-all-platforms: existing agents learn, on
 * update and once, that app and Slack record origin, what the phone row says, where the setting
 * lives and that the Slack off switch is the operator's. A fresh template (with or without
 * Telegram) carries the same section, so a new agent is never double-patched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { MESSAGE_ORIGIN_ALL_PLATFORMS_HEADING } from '../../src/messaging/telegram-origin/OriginAwareness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — message origin on app and Slack', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'instar-mo-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-messageOriginAllPlatforms.test.ts:cleanup' });
  });

  it('adds the section once and is idempotent', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md\n');
    expect(run(projectDir).upgraded).toContain('CLAUDE.md: added message origin on app and Slack awareness');
    run(projectDir);
    const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(content.split(MESSAGE_ORIGIN_ALL_PLATFORMS_HEADING).length - 1).toBe(1);
    expect(content).toContain('http://localhost:4042/health');
    expect(content).toContain('messageOrigin.display');
    expect(content).toContain('messageOrigin.recording.slackFailClosed: false');
    expect(content).toContain("only on a verified operator's instruction");
  });

  it('every fresh template carries it, with or without Telegram', () => {
    expect(generateClaudeMd('fixture', 'Fixture', 4042, true)).toContain(MESSAGE_ORIGIN_ALL_PLATFORMS_HEADING);
    expect(generateClaudeMd('fixture', 'Fixture', 4042, false)).toContain(MESSAGE_ORIGIN_ALL_PLATFORMS_HEADING);
  });
});
