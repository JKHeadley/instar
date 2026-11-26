import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = '### Quota-enforcement scheduler pause';
const GUIDANCE = 'After a deadline release, check `awaitingFreshQuota`: AI jobs stay gated until a new healthy reading arrives, while script checks can run.';

describe('quota pause guidance for fresh and existing agents', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-quota-pause-awareness-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-quotaPauseAwareness.test.ts:cleanup',
    });
  });

  const migrate = (): MigrationResult => {
    const migrator = new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator as unknown as { migrateClaudeMd(result: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('puts the same bounded-pause explanation in fresh-agent guidance', () => {
    const fresh = generateClaudeMd('test', 'TestAgent', 4042, false);
    expect(fresh).toContain(MARKER);
    expect(fresh).toContain('http://localhost:4042/quota/migration');
    expect(fresh).toContain(GUIDANCE);
    expect(fresh).toContain('an absent field is not evidence of a live pause');
  });

  it('backfills existing guidance once, preserving the deadline-versus-fresh-quota distinction', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nExisting guidance.\n');
    const first = migrate();
    const firstText = fs.readFileSync(claudeMdPath, 'utf8');
    expect(firstText).toContain(MARKER);
    expect(firstText).toContain('http://localhost:4042/quota/migration');
    expect(firstText).toContain(GUIDANCE);
    expect(firstText).toContain('an absent field is not evidence of a live pause');
    expect(first.upgraded).toContain('CLAUDE.md: added bounded quota-enforcement pause awareness');

    const second = migrate();
    const secondText = fs.readFileSync(claudeMdPath, 'utf8');
    expect(secondText).toBe(firstText);
    expect(secondText.split(MARKER).length - 1).toBe(1);
    expect(second.upgraded).not.toContain('CLAUDE.md: added bounded quota-enforcement pause awareness');
  });
});
