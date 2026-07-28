import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = 'POST /session-pool/promote';

describe('session-pool promotion awareness migration parity', () => {
  let projectDir: string;
  let claudeMd: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pool-promotion-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-sessionPoolPromotion.test.ts',
    });
  });

  function migrate(): MigrationResult {
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

  it('teaches an existing pool-aware agent once and remains byte-idempotent', () => {
    fs.writeFileSync(
      claudeMd,
      '# Agent\n\n## Multi-Machine Session Pool (active-active — spread conversations across machines)\n\nExisting pool guidance.\n',
    );
    expect(migrate().errors).toEqual([]);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(once).toContain(MARKER);
    expect(once).toContain('promotionModel');
    expect(once).toContain('promotionCeiling');
    expect(once.split(MARKER)).toHaveLength(2);

    expect(migrate().errors).toEqual([]);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
  });

  it('fresh generation includes the same operator lever and safe default', () => {
    const fresh = generateClaudeMd({
      projectName: 'test',
      port: 4042,
      framework: 'claude-code',
    } as never);
    expect(fresh).toContain(MARKER);
    expect(fresh).toContain('defaults to `off`');
    expect(fresh).toContain('hard upper bound');
  });
});
