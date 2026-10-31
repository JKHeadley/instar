/**
 * Migration Parity + Agent Awareness for queue pace (docs/specs/queue-pace.md): existing agents
 * learn GET /queue-pace on update, once; a fresh template carries the same section.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, QUEUE_PACE_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = 'Queue Pace — is every work pile shrinking';

function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Queue Pace CLAUDE.md section', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'instar-qp-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-queuePaceSection.test.ts:cleanup' });
  });

  it('adds the section once and is idempotent', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md\n');
    expect(run(projectDir).upgraded).toContain('CLAUDE.md: added Queue Pace section');
    run(projectDir);
    const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(content.split(MARKER).length - 1).toBe(1);
    expect(content).toContain('http://localhost:4042/queue-pace?scope=pool');
    expect(content).toContain('queuePace.tuner.enabled');
  });

  it('the template carries the same section, so a fresh agent is never double-patched', () => {
    expect(QUEUE_PACE_CLAUDEMD_SECTION(4040)).toContain(MARKER);
    expect(generateClaudeMd('fixture', 'Fixture', 4042, true)).toContain(MARKER);
  });
});
