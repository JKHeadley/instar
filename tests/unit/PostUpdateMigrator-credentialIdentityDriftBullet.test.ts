import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PostUpdateMigrator — credential identity drift awareness parity', () => {
  let dir = '';
  afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'credential-drift-awareness-cleanup' }); });

  it('patches an existing Subscription Pool section exactly once', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-drift-md-'));
    fs.mkdirSync(path.join(dir, '.instar'));
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Agent\n\n## Subscription Pool (multi-account quota + seamless continuation)\n- Existing operator text.\n');
    const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    const run = () => (migrator as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);
    run();
    run();
    const after = fs.readFileSync(file, 'utf8');
    expect(after.split('Credential identity drift is self-healing safety state')).toHaveLength(2);
    expect(after).toContain('live identity pre-flight before every swap');
    expect(after).toContain('owner re-login commitment');
  });
});
