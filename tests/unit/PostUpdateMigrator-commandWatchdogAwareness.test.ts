import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const cleanup: string[] = [];

function migrate(projectDir: string): MigrationResult {
  const migrator = new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'PostUpdateMigrator-commandWatchdogAwareness.test.ts:cleanup',
    });
  }
});

describe('PostUpdateMigrator command-watchdog awareness parity', () => {
  it('hardens an existing legacy attribution line and is idempotent', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-watchdog-awareness-'));
    cleanup.push(projectDir);
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const claudeMd = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(
      claudeMd,
      '# Existing\n\n- **Command-watchdog attribution:** old bounded-waiter guidance.\n',
    );

    const first = migrate(projectDir);
    const afterFirst = fs.readFileSync(claudeMd, 'utf8');
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain(
      'CLAUDE.md: hardened command-watchdog descendant attribution awareness',
    );
    expect(afterFirst).toContain('pinned long-lived test/compiler services');
    expect(afterFirst).toContain('action-time PID/parent/argv identity check');
    expect(afterFirst).toContain('never sends pane-wide Ctrl+C');

    const second = migrate(projectDir);
    expect(second.errors).toEqual([]);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(afterFirst);
    expect(second.upgraded).not.toContain(
      'CLAUDE.md: hardened command-watchdog descendant attribution awareness',
    );
  });
});
