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
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

const STALE_PAYLOAD = `-d '{"userRequest":"<what you promised>","type":"follow-up","topicId":TOPIC_ID}'`;
const BARE_PAYLOAD =
  `-d '{"userRequest":"<what the user asked>","agentResponse":"<what you said you would do>","type":"one-time-action","topicId":TOPIC_ID}'`;
const ENROLLED_PAYLOAD =
  `-d '{"userRequest":"<what the user asked>","agentResponse":"<what you said you would do>","type":"one-time-action","topicId":TOPIC_ID,"beaconEnabled":true,"nextUpdateDueAt":"<ISO deadline>"}'`;

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
    expect(afterFirst).toContain('"beaconEnabled":true');
    expect(afterFirst).toContain('"nextUpdateDueAt":"<ISO deadline>"');
    expect(afterFirst).not.toContain(STALE_PAYLOAD);
    expect(afterFirst).not.toContain(BARE_PAYLOAD);

    const result2 = runClaudeMdMigration(newMigrator());
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(result2.upgraded.some((u) => u.includes('commitments guidance payload'))).toBe(false);
  });

  it('migrates the previously shipped bare payload to explicit PromiseBeacon enrollment', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md

**Commitments & Follow-Through**
- Open: \`curl http://localhost:4044/commitments ${BARE_PAYLOAD}\`
`);

    const result = runClaudeMdMigration(newMigrator());
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(after).toContain(ENROLLED_PAYLOAD);
    expect(after).not.toContain(BARE_PAYLOAD);
    expect(result.upgraded.some((u) => u.includes('enrolled commitments guidance'))).toBe(true);
  });

  it('leaves customized commitments guidance untouched when exact shipped payloads are absent', () => {
    const customizedPayload =
      `-d '{"userRequest":"<operator wording>","agentResponse":"<agent wording>","type":"one-time-action","topicId":TOPIC_ID,"source":"local-playbook","beaconEnabled":true,"nextUpdateDueAt":"<local deadline>"}'`;
    const baseline = generateClaudeMd('test', 'TestAgent', 4042, false);
    expect(baseline).toContain(ENROLLED_PAYLOAD);

    const customized = baseline.replace(ENROLLED_PAYLOAD, customizedPayload);
    fs.writeFileSync(claudeMdPath, customized);

    const unrelatedMigrationResult = runClaudeMdMigration(newMigrator());
    const otherwiseCurrentCustomizedDoc = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(otherwiseCurrentCustomizedDoc).toContain(customizedPayload);
    expect(unrelatedMigrationResult.upgraded.some((u) => u.includes('commitments guidance payload'))).toBe(false);

    const result = runClaudeMdMigration(newMigrator());
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(after).toBe(otherwiseCurrentCustomizedDoc);
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('commitments guidance payload'))).toBe(false);
    expect(result.upgraded.some((u) => u.includes('enrolled commitments guidance'))).toBe(false);
  });
});
