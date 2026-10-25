import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Migration Parity for Resume Follows the Account (docs/specs/resume-follows-account.md):
// existing agents gain the awareness bullet once, after the Continuity guarantee bullet.
describe('PostUpdateMigrator — conversation-follows-login awareness parity', () => {
  let dir = '';
  afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'conversation-follows-login-md-cleanup' }); });

  function run(content: string): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-follows-md-'));
    fs.mkdirSync(path.join(dir, '.instar'));
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, content);
    const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    const once = () => (migrator as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);
    once();
    once();
    return fs.readFileSync(file, 'utf8');
  }

  it('inserts the bullet exactly once, right after the Continuity guarantee bullet', () => {
    const after = run('# Agent\n\n**Subscription Pool (multi-account quota + auto-swap + enrollment)** — pool\n- **Continuity guarantee** — sessions resume on another account.\n- **Next bullet** — unchanged.\n');
    expect(after.split('Conversation follows its login')).toHaveLength(2);
    const continuity = after.indexOf('- **Continuity guarantee**');
    const inserted = after.indexOf('- **Conversation follows its login**');
    const next = after.indexOf('- **Next bullet**');
    expect(continuity).toBeLessThan(inserted);
    expect(inserted).toBeLessThan(next);
    expect(after).toContain('sessions.resumeFollowsAccount.enabled: false');
  });
});
