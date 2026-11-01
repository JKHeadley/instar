/**
 * Migration parity for signed records (docs/specs/mobile-native-conversations.md increment 2):
 * the Native app conversations section's increment-1 "signature checking is not built yet" line
 * is refreshed in place on existing agents, idempotently, to the wording new agents get.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PostUpdateMigrator, APP_CONVERSATIONS_CLAUDEMD_SECTION, APP_CONVERSATIONS_CURRENT_VERDICT_LINE, APP_CONVERSATIONS_STALE_VERDICT_LINE,
} from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const UPDATED = 'CLAUDE.md: updated the Native app conversations signature-verdict line';

describe('PostUpdateMigrator — native app conversations signed-records wording', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-app-signed-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-appConversationsSignedRecords.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('the template carries the current wording, not the increment-1 line', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain(APP_CONVERSATIONS_CURRENT_VERDICT_LINE);
    expect(md).not.toContain(APP_CONVERSATIONS_STALE_VERDICT_LINE);
    expect(APP_CONVERSATIONS_CLAUDEMD_SECTION(4040)).toContain(APP_CONVERSATIONS_CURRENT_VERDICT_LINE);
  });

  it('refreshes the stale line in an existing section once, idempotently', () => {
    const stale = APP_CONVERSATIONS_CLAUDEMD_SECTION(4321).replace(APP_CONVERSATIONS_CURRENT_VERDICT_LINE, APP_CONVERSATIONS_STALE_VERDICT_LINE);
    expect(stale).toContain(APP_CONVERSATIONS_STALE_VERDICT_LINE);
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n${stale}`);
    expect(run().upgraded).toContain(UPDATED);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).not.toContain(APP_CONVERSATIONS_STALE_VERDICT_LINE);
    expect(after).toContain(APP_CONVERSATIONS_CURRENT_VERDICT_LINE);
    expect(after.split('### Native app conversations').length - 1).toBe(1);
    expect(run().upgraded).not.toContain(UPDATED);
  });
});
