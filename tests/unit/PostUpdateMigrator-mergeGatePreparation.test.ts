import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('merge-gate preparation awareness migration', () => {
  let dir = '';
  afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'merge-gate-preparation-test' }); });

  it('replaces the old queued-only guidance once on an existing agent', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-prep-migrate-'));
    fs.mkdirSync(path.join(dir, '.instar'));
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '**Test-Runner Concurrency Bound**\n- When Local Verify has runnable merge-gate work, it holds a short claim for the next full-suite slot. Ordinary full suites wait; small targeted tests keep their own lane. `GET /test-runner-limiter` → `mergeGatePriority.active` explains a wait with no current suite holder. The claim expires if the verifier stalls.\n');
    const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    const run = () => (migrator as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);
    run();
    const once = fs.readFileSync(file, 'utf8');
    run();
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
    expect(once).toContain('next full-suite slot through child preparation. Ordinary full suites wait');
    expect(once).not.toContain('next full-suite slot. Ordinary full suites wait');
  });

  it('adds the fair suite-waiter line once on an existing agent', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-prep-migrate-'));
    fs.mkdirSync(path.join(dir, '.instar'));
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '**Test-Runner Concurrency Bound**\n- When Local Verify has runnable merge-gate work, it holds a short claim for the next full-suite slot through child preparation. Ordinary full suites wait.\n- **"Why is my test run waiting?" / a rejected push**\n');
    const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    const run = () => (migrator as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);
    run();
    const once = fs.readFileSync(file, 'utf8');
    run();
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
    expect(once.split('`suiteWaiters`').length).toBe(2);
    expect(once.split('`alternatingSuiteTurns` and `suiteTurn`').length).toBe(2);
    expect(once.indexOf('`suiteWaiters`')).toBeLessThan(once.indexOf('Why is my test run waiting?'));
  });
});
