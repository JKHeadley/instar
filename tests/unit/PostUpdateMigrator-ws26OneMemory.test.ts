/**
 * Verifies PostUpdateMigrator splices the WS2.6 user-registry + topic-operator One Memory bullets
 * into an already-deployed CLAUDE.md (Agent Awareness + Migration Parity). An agent that already
 * has the WS2.5 line but not the WS2.6 lines gets them — ESPECIALLY the topic-operator
 * UNTRUSTED-REPLICATED-OPERATOR invariant — so the awareness reaches deployed agents before any
 * operator enables this PII replication. Idempotent (a second run no-ops).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

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

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

// A CLAUDE.md that already carries the One Memory section through WS2.5 but NOT WS2.6. A real
// deployed WS2.5 agent has every prior bullet (the migrator chain splices them one pass at a time),
// so the WS2.6 chained else-if is the branch that fires.
const DEPLOYED_WS25 = `# CLAUDE.md

### One Memory (replicated stores)

- **Preferences are the FIRST live store** (WS2.1): blah.
- **Relationships are the FIRST PII store** (WS2.3): blah.
- **Learnings are the SECOND memory-family store** (WS2.2): blah.
- **Knowledge base is the THIRD memory-family store** (WS2.4): blah.
- **Evolution action queue is the FOURTH memory-family store** (WS2.5): blah.
- **When to use** (PROACTIVE — these are the triggers): the user asks something. Spec: docs.
`;

describe('PostUpdateMigrator — WS2.6 user-registry + topic-operator One Memory splice', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ws26-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-ws26OneMemory.test.ts:cleanup' });
  });

  it('splices BOTH WS2.6 bullets BEFORE the When-to-use bullet for a deployed WS2.5 agent', () => {
    fs.writeFileSync(claudeMdPath, DEPLOYED_WS25);
    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('WS2.6 user-registry + topic-operator'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('User registry is the SECOND PII store');
    expect(after).toContain('Topic-operator binding is the THIRD PII store');
    // The load-bearing invariant prose reaches the deployed agent.
    expect(after).toContain('NEVER my authoritative answer to "who is my verified operator of this topic?"');
    // Spliced BEFORE the When-to-use bullet (order preserved).
    expect(after.indexOf('User registry is the SECOND PII store')).toBeLessThan(after.indexOf('- **When to use**'));
  });

  it('is idempotent — a second run does not re-splice', () => {
    fs.writeFileSync(claudeMdPath, DEPLOYED_WS25);
    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(second.upgraded.some((u) => u.includes('WS2.6 user-registry + topic-operator'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    // Exactly one copy of each marker.
    expect(afterSecond.split('User registry is the SECOND PII store').length - 1).toBe(1);
    expect(afterSecond.split('Topic-operator binding is the THIRD PII store').length - 1).toBe(1);
  });
});
