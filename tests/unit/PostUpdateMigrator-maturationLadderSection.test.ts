/** Migration Parity + Agent Awareness: existing agents learn the ladder on update, once; a fresh template carries it too. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, MATURATION_LADDER_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = 'Maturation Ladder — what does this feature need';

function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'p' } as unknown as ConstructorParameters<typeof PostUpdateMigrator>[0]);
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Maturation Ladder CLAUDE.md section', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'instar-ml-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Agent\n');
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-maturationLadderSection.test.ts' }); });

  it('adds the section once', () => {
    expect(run(projectDir).upgraded).toContain('CLAUDE.md: added Maturation Ladder section');
    const first = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(first).toContain(MARKER);
    expect(run(projectDir).upgraded).not.toContain('CLAUDE.md: added Maturation Ladder section');
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8').split(MARKER)).toHaveLength(2);
  });

  it('says how to read it, how to record, and that numbers move nothing', () => {
    const s = MATURATION_LADDER_CLAUDEMD_SECTION(4042);
    expect(s).toContain('localhost:4042/maturation/ladder');
    expect(s).toContain('featureEvidence.record');
    expect(s).toContain('Numbers never move anything by themselves');
  });
});
