/**
 * Declared job failure + feedback-inbox token awareness (spec
 * docs/specs/feedback-inbox-vault-token.md §B, §D).
 *
 * - jobDeclaredFailure: per-run path, read-and-remove, reason sanitising
 *   (one line, token shapes redacted, capped), empty/absent cases.
 * - Awareness: the shared sentence refresh (old → new, idempotent, drifted text
 *   untouched) through the REAL migrateClaudeMd + migrateFrameworkShadowCapabilities,
 *   and the declared-failure bullet inserted once in the Job Scheduler block.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import {
  jobDeclaredFailurePath,
  readJobDeclaredFailure,
  sanitizeDeclaredFailureReason,
  JOB_DECLARED_FAILURE_AWARENESS,
} from '../../src/scheduler/jobDeclaredFailure.js';
import {
  FEEDBACK_INBOX_TOKEN_SENTENCE,
  FEEDBACK_INBOX_TOKEN_SENTENCE_OLD,
  refreshFeedbackInboxTokenAwareness,
} from '../../src/feedback-factory/inbox/inboxAwareness.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-declared-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-declared-failure.test.ts' }); });

function declare(tmuxSession: string, content: string): string {
  const file = jobDeclaredFailurePath(dir, tmuxSession);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe('jobDeclaredFailure', () => {
  it('names the file by the run\'s tmux session under state/job-declared-failures', () => {
    expect(jobDeclaredFailurePath(dir, 'echo-job-feedback-factory-process-m1x2'))
      .toBe(path.join(dir, 'state', 'job-declared-failures', 'echo-job-feedback-factory-process-m1x2.txt'));
    // A path separator in a name can never escape the directory.
    expect(path.dirname(jobDeclaredFailurePath(dir, '../../etc/x'))).toBe(path.join(dir, 'state', 'job-declared-failures'));
  });

  it('absent file → null (the run declared nothing)', () => {
    expect(readJobDeclaredFailure(dir, 'no-such-run')).toBeNull();
  });

  it('reads the reason once and removes the file', () => {
    const file = declare('run-a', 'drain posture unavailable: initialization-failure');
    expect(readJobDeclaredFailure(dir, 'run-a')).toBe('drain posture unavailable: initialization-failure');
    expect(fs.existsSync(file)).toBe(false);
    expect(readJobDeclaredFailure(dir, 'run-a')).toBeNull();
  });

  it('another run\'s file is never read', () => {
    declare('run-a', 'a failed');
    expect(readJobDeclaredFailure(dir, 'run-b')).toBeNull();
    expect(readJobDeclaredFailure(dir, 'run-a')).toBe('a failed');
  });

  it('an empty file still declares failure', () => {
    declare('run-empty', '   \n');
    expect(readJobDeclaredFailure(dir, 'run-empty')).toBe('(no reason given)');
  });

  it('sanitises: one line, control characters gone, capped at 500', () => {
    expect(sanitizeDeclaredFailureReason('line one\nline\ttwo\u0007 end')).toBe('line one line two end');
    expect(sanitizeDeclaredFailureReason('x'.repeat(900))).toHaveLength(500);
  });

  it('redacts bearer tokens and token shapes before the reason is stored or alerted', () => {
    const out = sanitizeDeclaredFailureReason('curl said 401 with authorization: Bearer abc.def-123 and ghp_' + 'A'.repeat(36));
    expect(out).not.toContain('abc.def-123');
    expect(out).not.toContain('A'.repeat(36));
    expect(out).toContain('Bearer REDACTED');
  });
});

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function migrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}
function run(m: PostUpdateMigrator, method: 'migrateClaudeMd' | 'migrateFrameworkShadowCapabilities'): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as Record<string, (r: MigrationResult) => void>)[method](result);
  return result;
}

describe('feedback-inbox token awareness', () => {
  const OLD_SECTION = `**Feedback-Inbox Receiving End (operated feedback factory)** — When this install runs an operated feedback-factory instance, the receiving end is: ... ${FEEDBACK_INBOX_TOKEN_SENTENCE_OLD}\n- Status (read-only counters): \`curl http://localhost:4042/feedback-inbox/status\`\n`;
  const JOB_BLOCK = [
    '**Job Scheduler** — Run tasks on a schedule. Jobs in `.instar/jobs.json`.',
    '- Trigger: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/jobs/SLUG/trigger`',
    '',
  ].join('\n');

  it('refresh replaces the old sentence, is idempotent, and leaves drifted text alone', () => {
    const once = refreshFeedbackInboxTokenAwareness(`a ${FEEDBACK_INBOX_TOKEN_SENTENCE_OLD} b`);
    expect(once).toBe(`a ${FEEDBACK_INBOX_TOKEN_SENTENCE} b`);
    expect(refreshFeedbackInboxTokenAwareness(once)).toBe(once);
    const drifted = 'Ships dark behind something an operator rewrote.';
    expect(refreshFeedbackInboxTokenAwareness(drifted)).toBe(drifted);
  });

  it('new agents: the CLAUDE.md template carries the vault sentence and the declared-failure bullet', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(md).toContain(FEEDBACK_INBOX_TOKEN_SENTENCE);
    expect(md).not.toContain(FEEDBACK_INBOX_TOKEN_SENTENCE_OLD);
    expect(md).toContain(JOB_DECLARED_FAILURE_AWARENESS.trim());
    expect(md).toContain('feedback_inbox_blob_token');
  });

  it('existing agents: migrateClaudeMd updates the old sentence and inserts the bullet once', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-aware-'));
    try {
      fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
      const claudeMd = path.join(projectDir, 'CLAUDE.md');
      fs.writeFileSync(claudeMd, `# CLAUDE.md\n\n${JOB_BLOCK}\n${OLD_SECTION}`);
      const first = run(migrator(projectDir), 'migrateClaudeMd');
      expect(first.errors).toEqual([]);
      const after = fs.readFileSync(claudeMd, 'utf8');
      expect(after).toContain(FEEDBACK_INBOX_TOKEN_SENTENCE);
      expect(after).not.toContain(FEEDBACK_INBOX_TOKEN_SENTENCE_OLD);
      expect(after.split('INSTAR_JOB_FAILURE_FILE`**').length - 1).toBe(1);
      expect(first.upgraded).toContain('CLAUDE.md: feedback inbox token may come from the vault');

      run(migrator(projectDir), 'migrateClaudeMd');
      const again = fs.readFileSync(claudeMd, 'utf8');
      expect(again.split(FEEDBACK_INBOX_TOKEN_SENTENCE).length - 1).toBe(1);
      expect(again.split('INSTAR_JOB_FAILURE_FILE`**').length - 1).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/job-declared-failure.test.ts' });
    }
  });

  it('existing agents: an AGENTS.md shadow with the old section is refreshed too', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-shadow-'));
    try {
      fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), `# CLAUDE.md\n\n${JOB_BLOCK}\n${OLD_SECTION}`);
      fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), `# AGENTS.md\n\n${OLD_SECTION}`);
      run(migrator(projectDir), 'migrateClaudeMd');
      const result = run(migrator(projectDir), 'migrateFrameworkShadowCapabilities');
      expect(result.errors).toEqual([]);
      const shadow = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8');
      expect(shadow).toContain(FEEDBACK_INBOX_TOKEN_SENTENCE);
      expect(shadow).not.toContain(FEEDBACK_INBOX_TOKEN_SENTENCE_OLD);
      expect(shadow).toContain(JOB_DECLARED_FAILURE_AWARENESS.trim());
      run(migrator(projectDir), 'migrateFrameworkShadowCapabilities');
      const again = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8');
      expect(again.split('INSTAR_JOB_FAILURE_FILE`**').length - 1).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/job-declared-failure.test.ts' });
    }
  });
});
