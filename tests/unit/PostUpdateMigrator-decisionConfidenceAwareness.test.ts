import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DECISION_JOURNAL_CONFIDENCE_CLAUDEMD_GUIDANCE,
  PostUpdateMigrator,
} from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function migrateClaudeMd(projectDir: string): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (newMigrator(projectDir) as unknown as {
    migrateClaudeMd(r: MigrationResult): void;
  }).migrateClaudeMd(result);
  return result;
}

describe('decision-journal confidence awareness migration parity', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-confidence-awareness-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-decisionConfidenceAwareness.test.ts:cleanup',
    });
  });

  it('teaches new agents the exact accepted shape and legacy-data posture', () => {
    const fresh = generateClaudeMd('test', 'TestAgent', 4042, false);

    expect(fresh).toContain(DECISION_JOURNAL_CONFIDENCE_CLAUDEMD_GUIDANCE);
    expect(fresh).toContain('a numeric string such as `"0.8"` is accepted');
    expect(fresh).toContain('a qualitative label such as `"high"` is refused');
    expect(fresh).toContain('Existing qualitative rows are treated as unmeasurable');
    expect(fresh).toContain('`sampleSize > 0` does not by itself prove');
  });

  it('adds the same contract to an existing agent that already has the older journal guidance', () => {
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n' +
        '- **Decision journal — principle is required:** existing guidance.\n' +
        '- **Alignment score — N/A means not assessed:** old guidance.\n',
    );

    const result = migrateClaudeMd(projectDir);
    const migrated = fs.readFileSync(claudeMdPath, 'utf8');

    expect(result.errors).toEqual([]);
    expect(result.upgraded).toContain(
      'CLAUDE.md: added decision-journal confidence contract awareness',
    );
    expect(migrated).toContain(DECISION_JOURNAL_CONFIDENCE_CLAUDEMD_GUIDANCE);
  });

  it('is content-sniffed and idempotent for both migrated and freshly scaffolded agents', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    migrateClaudeMd(projectDir);
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf8');
    const second = migrateClaudeMd(projectDir);
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf8');

    expect(afterSecond).toBe(afterFirst);
    expect(
      afterSecond.split(DECISION_JOURNAL_CONFIDENCE_CLAUDEMD_GUIDANCE).length - 1,
    ).toBe(1);
    expect(second.upgraded).not.toContain(
      'CLAUDE.md: added decision-journal confidence contract awareness',
    );

    fs.writeFileSync(
      claudeMdPath,
      generateClaudeMd('test', 'TestAgent', 4042, false),
    );
    const freshResult = migrateClaudeMd(projectDir);
    const freshAfterMigration = fs.readFileSync(claudeMdPath, 'utf8');

    expect(freshResult.upgraded).not.toContain(
      'CLAUDE.md: added decision-journal confidence contract awareness',
    );
    expect(
      freshAfterMigration.split(DECISION_JOURNAL_CONFIDENCE_CLAUDEMD_GUIDANCE).length - 1,
    ).toBe(1);
  });
});
