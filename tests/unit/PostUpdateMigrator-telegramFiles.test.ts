/**
 * Migration parity for Telegram files on any machine (docs/specs/native-conversation-base.md §3c):
 * the `### Telegram files on any machine` section reaches new agents through the template and existing
 * agents through migrateClaudeMd, once, by its exact heading, with this agent's port in the fetch route.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, TELEGRAM_FILES_CLAUDEMD_MARKER } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const ADDED = 'CLAUDE.md: added Telegram files on any machine section';

describe('PostUpdateMigrator — Telegram files on any machine', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-files-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-telegramFiles.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: true, projectName: 'test' });
    const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
    return r;
  };

  it('new agents get the section from the template', () => {
    const md = generateClaudeMd('test', 'Test', 4040, true);
    expect(md).toContain(TELEGRAM_FILES_CLAUDEMD_MARKER);
    expect(md).toContain('http://localhost:4040/conversation-media/path?conversationKey=telegram:<topicId>&platformMessageId=<id>');
    expect(md).toContain('[typed image:/etc/hostname]');
  });

  it('an existing agent gets it once, with its own port', () => {
    const file = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(file, '# CLAUDE.md\n\nSome existing content.\n');
    expect(run().upgraded).toContain(ADDED);
    expect(run().upgraded).not.toContain(ADDED);
    const after = fs.readFileSync(file, 'utf-8');
    expect(after.split(TELEGRAM_FILES_CLAUDEMD_MARKER).length - 1).toBe(1);
    expect(after).toContain('http://localhost:4321/conversation-media/path');
    expect(after).toContain('Some existing content.');
  });
});
