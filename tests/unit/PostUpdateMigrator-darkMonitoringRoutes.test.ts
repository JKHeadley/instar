import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MISSING_LOGIN_SESSION_CLAUDEMD_SECTION,
  PostUpdateMigrator,
  SINGLE_MACHINE_FAILOVER_GAP_CLAUDEMD_SECTION,
} from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — dark monitoring route awareness', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dark-monitoring-routes-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-darkMonitoringRoutes.test.ts:cleanup',
    });
  });

  function newMigrator(): PostUpdateMigrator {
    return new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
  }

  it('backfills both missing sections and is byte-idempotent on the second run', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nExisting guidance.\n');

    const first = runClaudeMdMigration(newMigrator());
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf8');
    expect(afterFirst).toContain('http://localhost:4042/pool/failover-gap');
    expect(afterFirst).toContain('http://localhost:4042/pool/missing-login');
    expect(afterFirst).toContain('A 503 means the guard is dark/not constructed');
    expect(afterFirst).toContain('would-raise counters but sends no Attention item');
    expect(first.upgraded.some((entry) => entry.includes('Single-Machine Failover-Gap Guard'))).toBe(true);
    expect(first.upgraded.some((entry) => entry.includes('Missing-Login Session Guard'))).toBe(true);

    const second = runClaudeMdMigration(newMigrator());
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf8');
    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.split('### Single-Machine Failover-Gap Guard').length - 1).toBe(1);
    expect(afterSecond.split('### Missing-Login Session Guard').length - 1).toBe(1);
    expect(second.upgraded.some((entry) => entry.includes('Failover-Gap Guard'))).toBe(false);
    expect(second.upgraded.some((entry) => entry.includes('Missing-Login Session Guard'))).toBe(false);
  });

  it('uses the exact shared sections in fresh-agent generation', () => {
    const generated = generateClaudeMd('test', 'TestAgent', 4042, false);
    expect(generated).toContain(SINGLE_MACHINE_FAILOVER_GAP_CLAUDEMD_SECTION(4042));
    expect(generated).toContain(MISSING_LOGIN_SESSION_CLAUDEMD_SECTION(4042));
  });
});
