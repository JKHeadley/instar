/**
 * Migration parity for the native-conversations gap fixes (docs/specs/mobile-native-conversations.md
 * §4.2, §4.8, §4.9): the Mobile operator chat content bullet (no longer "refused") and the Native
 * app conversations pool-read / approval-method bullet reach existing agents in place, idempotently,
 * with the wording new agents get.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PostUpdateMigrator, APP_CONVERSATIONS_CLAUDEMD_SECTION, APP_CONVERSATIONS_POOL_LINE, MOBILE_CHAT_CLAUDEMD_SECTION,
  MOBILE_CHAT_CONTENT_LINE, MOBILE_CHAT_STALE_CONTENT_LINE,
} from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — native app conversations gap wording', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-app-gaps-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-appConversationsGaps.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('new agents get the current wording', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain(APP_CONVERSATIONS_POOL_LINE);
    expect(md).toContain(MOBILE_CHAT_CONTENT_LINE);
    expect(md).not.toContain(MOBILE_CHAT_STALE_CONTENT_LINE);
  });

  it('existing agents get both lines in place, once', () => {
    const oldChat = MOBILE_CHAT_CLAUDEMD_SECTION(4321).replace(MOBILE_CHAT_CONTENT_LINE, MOBILE_CHAT_STALE_CONTENT_LINE);
    const oldApp = APP_CONVERSATIONS_CLAUDEMD_SECTION(4321).replace(`${APP_CONVERSATIONS_POOL_LINE}\n`, '');
    expect(oldChat).toContain(MOBILE_CHAT_STALE_CONTENT_LINE);
    expect(oldApp).not.toContain(APP_CONVERSATIONS_POOL_LINE);
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n${oldChat}${oldApp}`);
    const first = run().upgraded;
    expect(first).toContain('CLAUDE.md: updated the Mobile operator chat content bullet');
    expect(first).toContain('CLAUDE.md: added the Native app conversations pool-read line');
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MOBILE_CHAT_CONTENT_LINE);
    expect(after).not.toContain(MOBILE_CHAT_STALE_CONTENT_LINE);
    // The pool line sits right after the history bullet, as in the template.
    const lines = after.split('\n');
    const hist = lines.findIndex((l) => l.includes('/mobile/chat/app/CONVERSATION_KEY/messages'));
    expect(lines[hist + 1]).toBe(APP_CONVERSATIONS_POOL_LINE);
    const second = run().upgraded;
    expect(second).not.toContain('CLAUDE.md: updated the Mobile operator chat content bullet');
    expect(second).not.toContain('CLAUDE.md: added the Native app conversations pool-read line');
    expect(fs.readFileSync(claudeMdPath, 'utf-8').split(APP_CONVERSATIONS_POOL_LINE).length - 1).toBe(1);
  });
});
