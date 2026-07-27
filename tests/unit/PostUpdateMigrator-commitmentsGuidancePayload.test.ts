/**
 * Verifies PostUpdateMigrator rewrites the stale installed commitments curl
 * shape in existing CLAUDE.md files. Fresh templates already carry the accepted
 * payload; deployed agents with the section present need an in-place migration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

const STALE_PAYLOAD = `-d '{"userRequest":"<what you promised>","type":"follow-up","topicId":TOPIC_ID}'`;

describe('PostUpdateMigrator — commitments guidance payload migration', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-commitments-guidance-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-commitmentsGuidancePayload.test.ts:cleanup',
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

  it('rewrites the stale follow-up payload in an already-installed Commitments section and is idempotent', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md

**Commitments & Follow-Through** — Durable tracking for any promise you make to the user.
- Open a one-time follow-up commitment: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4044/commitments -H 'Content-Type: application/json' ${STALE_PAYLOAD}\`
- List / inspect: \`curl -H "Authorization: Bearer $AUTH" http://localhost:4044/commitments\`
`);

    const result = runClaudeMdMigration(newMigrator());
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('commitments guidance payload'))).toBe(true);
    expect(afterFirst).toContain('"agentResponse":"<what you said you would do>"');
    expect(afterFirst).toContain('"type":"one-time-action"');
    expect(afterFirst).not.toContain(STALE_PAYLOAD);

    const result2 = runClaudeMdMigration(newMigrator());
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(result2.upgraded.some((u) => u.includes('commitments guidance payload'))).toBe(false);
  });
});
