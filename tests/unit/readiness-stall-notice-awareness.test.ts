// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/** Agent Awareness + Migration Parity for the readiness stall notice and the narrowed brake wording. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { READINESS_PAUSE_ALARM_BULLET, READINESS_STALL_NOTICE_MARKER, READINESS_STALL_NOTICE_BULLET, generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const WHEN_TO_USE = "- **When to use** (PROACTIVE): a drain tick 403s, or the user asks why feedback isn't turning into work → read the proposal, then give the operator the dashboard tab + PIN path. Never ask them to curl the POST route.";
const BRAKE_1002 = '(spend cap, a different model or prompt answering, or three runs in a row with no usable answer: timeouts, provider errors, or answers that failed the checks; a single timeout or rejected answer is just retried, and a restart on the same machine keeps the approval);';
const STATUS_1002 = '(`at` says when; it stays after later calls succeed); `blockers` says in plain words why nothing can be approved yet.';
type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}
const count = (s: string) => s.split(READINESS_STALL_NOTICE_MARKER).length - 1;

describe('readiness stall-notice CLAUDE.md bullet + narrowed brake wording', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-stall-notice-bullet-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/readiness-stall-notice-awareness.test.ts:cleanup' }));

  it('new agents get it from the template, right after the pause-alarm bullet, with the narrowed brake wording', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(count(md)).toBe(1);
    expect(md).toContain(READINESS_PAUSE_ALARM_BULLET + '\n' + READINESS_STALL_NOTICE_BULLET);
    expect(md).not.toContain('three runs in a row');
    expect(md).toContain('a rate limit or a rejected answer NEVER pauses it');
    expect(md).toContain('`readinessProgress` says how many runs in a row');
  });

  it('existing agents on the 2026-10-02 wording are carried forward once; idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n**Feedback Readiness Authority (operator approval)** — …\n- Read what would be approved (read-only): … ' + BRAKE_1002 + ' `pausedBecause` says why in plain words, and `GET /feedback-factory/drain/status` → `lastReadinessFailure` names the exact check that refused the most recent failed readiness call ' + STATUS_1002 + '\n' + WHEN_TO_USE + '\n');
    const r1 = run(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(r1.upgraded).toContain('CLAUDE.md: Feedback Readiness Authority brake wording — invocation failures never pause');
    expect(r1.upgraded).toContain('CLAUDE.md: Feedback Readiness Authority status now names readinessProgress');
    expect(r1.upgraded).toContain('CLAUDE.md: added readiness stall-notice bullet');
    expect(once).not.toContain('three runs in a row');
    expect(once).toContain('a rate limit or a rejected answer NEVER pauses it');
    expect(once).toContain('while `readinessProgress` says how many runs in a row');
    expect(count(once)).toBe(1);
    expect(once).toContain(READINESS_PAUSE_ALARM_BULLET + '\n' + READINESS_STALL_NOTICE_BULLET);
    const r2 = run(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(r2.skipped).toContain('CLAUDE.md: readiness stall-notice bullet already present');
    expect(r2.upgraded).not.toContain('CLAUDE.md: Feedback Readiness Authority brake wording — invocation failures never pause');
  });

  it('an agent on the OLDEST (pre-2026-10-01) wording reaches the new wording in one pass', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n**Feedback Readiness Authority (operator approval)** — …\n- Read what would be approved (read-only): … `proposal-only` means a safety brake paused it (spend cap or model mismatch); `blockers` says in plain words why nothing can be approved yet.\n' + WHEN_TO_USE + '\n');
    const r = run(projectDir);
    const md = fs.readFileSync(claudeMd, 'utf8');
    expect(r.upgraded).toContain('CLAUDE.md: updated Feedback Readiness Authority brake wording');
    expect(r.upgraded).toContain('CLAUDE.md: Feedback Readiness Authority brake wording — invocation failures never pause');
    expect(r.upgraded).toContain('CLAUDE.md: Feedback Readiness Authority status now names readinessProgress');
    expect(md).not.toContain('three runs in a row');
    expect(md).not.toContain('(spend cap or model mismatch)');
    expect(md).toContain('a rate limit or a rejected answer NEVER pauses it');
    expect(md).toContain('while `readinessProgress` says how many runs in a row');
    expect(count(md)).toBe(1);
  });

  it('says what never pauses, what the one notice means, and where to read progress', () => {
    expect(READINESS_STALL_NOTICE_BULLET).toContain('never pauses the readiness authority');
    expect(READINESS_STALL_NOTICE_BULLET).toContain('nothing is paused and nothing needs approval');
    expect(READINESS_STALL_NOTICE_BULLET).toContain('Nothing retries out of cadence');
    expect(READINESS_STALL_NOTICE_BULLET).toContain('`readinessProgress`');
  });
});
