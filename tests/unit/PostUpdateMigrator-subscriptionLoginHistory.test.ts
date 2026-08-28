import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PostUpdateMigrator — passive subscription sign-in history awareness', () => {
  let dir = '';
  afterEach(() => {
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'subscription-history-awareness-cleanup' });
  });

  it('patches an existing pool section idempotently without changing its operator text', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-history-md-'));
    fs.mkdirSync(path.join(dir, '.instar'));
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, [
      '# Agent',
      '',
      '**Subscription Pool (multi-account quota + auto-swap + enrollment)**',
      '- See the pool. · poll all now: `POST /subscription-pool/poll`.',
      '- Operator customized text stays.',
      '',
    ].join('\n'));
    const migrator = new PostUpdateMigrator({
      projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042,
      hasTelegram: false, projectName: 'test',
    });
    const run = () => (migrator as unknown as {
      migrateClaudeMd(r: { upgraded: string[]; skipped: string[]; errors: string[] }): void;
    }).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
    run();
    run();
    const content = fs.readFileSync(file, 'utf8');
    expect(content.split('Sign-in reliability history (passive, never repair authority)')).toHaveLength(2);
    expect(content).toContain('/subscription-pool/login-history?summary=1&days=7');
    expect(content).toContain('Operator customized text stays.');
  });
});
