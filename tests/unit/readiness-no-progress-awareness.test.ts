// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/** Agent Awareness + Migration Parity for the readiness no-progress (wall-clock) alarm, ACT-114. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { READINESS_STALL_NOTICE_BULLET, READINESS_NO_PROGRESS_MARKER, READINESS_NO_PROGRESS_BULLET, generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const WHEN_TO_USE = "- **When to use** (PROACTIVE): a drain tick 403s, or the user asks why feedback isn't turning into work → read the proposal, then give the operator the dashboard tab + PIN path. Never ask them to curl the POST route.";
type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}
const count = (s: string) => s.split(READINESS_NO_PROGRESS_MARKER).length - 1;

describe('readiness no-progress CLAUDE.md bullet', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-no-progress-bullet-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/readiness-no-progress-awareness.test.ts:cleanup' }));

  it('new agents get it from the template, right after the stall-notice bullet', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(count(md)).toBe(1);
    expect(md).toContain(READINESS_STALL_NOTICE_BULLET + '\n' + READINESS_NO_PROGRESS_BULLET);
  });

  it('existing agents receive it once, after the stall notice; idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n**Feedback Readiness Authority (operator approval)** — …\n' + WHEN_TO_USE + '\n');
    const r1 = run(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(r1.upgraded).toContain('CLAUDE.md: added readiness no-progress bullet');
    expect(count(once)).toBe(1);
    expect(once).toContain(READINESS_STALL_NOTICE_BULLET + '\n' + READINESS_NO_PROGRESS_BULLET);
    const r2 = run(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(r2.skipped).toContain('CLAUDE.md: readiness no-progress bullet already present');
  });

  it('names the field to read and that it never repairs anything', () => {
    expect(READINESS_NO_PROGRESS_BULLET).toContain('`readinessProgressAge`');
    expect(READINESS_NO_PROGRESS_BULLET).toContain('Signal only');
    expect(READINESS_NO_PROGRESS_BULLET).toContain('feedback-drain:readiness-no-progress:<since>');
  });
});
