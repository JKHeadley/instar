/**
 * Tests for auth-failure detection in the scheduler completion handler.
 *
 * Claude Code exits cleanly (status = 'completed', exit code 0) on a
 * 401 / invalid-auth response. Without scanning the captured session output
 * the scheduler records these silent failures as successes. This patch
 * adds a post-completion scan and reclassifies the session as a failure
 * when a known auth-failure landmark is matched.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SCHEDULER_SRC = path.join(process.cwd(), 'src/scheduler/JobScheduler.ts');

function readSource(): string {
  return fs.readFileSync(SCHEDULER_SRC, 'utf-8');
}

describe('JobScheduler — AUTH_FAILURE_PATTERNS constant', () => {
  it('exists at module scope (not inside a function)', () => {
    const source = readSource();
    // The const must appear before the class definition
    const constIdx = source.indexOf('const AUTH_FAILURE_PATTERNS');
    const classIdx = source.indexOf('export class JobScheduler');
    expect(constIdx).toBeGreaterThan(-1);
    expect(classIdx).toBeGreaterThan(-1);
    expect(constIdx).toBeLessThan(classIdx);
  });

  it('is typed as readonly RegExp[]', () => {
    const source = readSource();
    expect(source).toContain('const AUTH_FAILURE_PATTERNS: readonly RegExp[]');
  });

  it('includes a 401 pattern', () => {
    const source = readSource();
    const blockStart = source.indexOf('const AUTH_FAILURE_PATTERNS');
    const blockEnd = source.indexOf('];', blockStart);
    const block = source.slice(blockStart, blockEnd + 2);
    expect(block).toContain('401');
  });

  it('includes an Unauthorized pattern', () => {
    const source = readSource();
    const blockStart = source.indexOf('const AUTH_FAILURE_PATTERNS');
    const blockEnd = source.indexOf('];', blockStart);
    const block = source.slice(blockStart, blockEnd + 2);
    expect(block).toContain('Unauthorized');
  });

  it('includes an Invalid API key pattern', () => {
    const source = readSource();
    const blockStart = source.indexOf('const AUTH_FAILURE_PATTERNS');
    const blockEnd = source.indexOf('];', blockStart);
    const block = source.slice(blockStart, blockEnd + 2);
    expect(block).toMatch(/Invalid.*API key/);
  });

  it('includes a Please re-authenticate pattern', () => {
    const source = readSource();
    const blockStart = source.indexOf('const AUTH_FAILURE_PATTERNS');
    const blockEnd = source.indexOf('];', blockStart);
    const block = source.slice(blockStart, blockEnd + 2);
    expect(block).toContain('authenticate');
  });

  it('includes an OAuth token pattern', () => {
    const source = readSource();
    const blockStart = source.indexOf('const AUTH_FAILURE_PATTERNS');
    const blockEnd = source.indexOf('];', blockStart);
    const block = source.slice(blockStart, blockEnd + 2);
    expect(block).toContain('OAuth token');
  });
});

describe('JobScheduler — completion handler uses let failed', () => {
  it('declares failed with let so the auth-failure override is possible', () => {
    const source = readSource();
    // Must use `let`, not `const`
    expect(source).toContain("let failed = session.status === 'failed' || session.status === 'killed'");
    expect(source).not.toContain("const failed = session.status === 'failed' || session.status === 'killed'");
  });
});

describe('JobScheduler — auth-failure scan reads last 4 KB of output', () => {
  it('slices the last 4000 bytes of output before pattern matching', () => {
    const source = readSource();
    // Find the scan block — the second occurrence of AUTH_FAILURE_PATTERNS is
    // inside the for-loop in the completion handler (first is the const def)
    const firstIdx = source.indexOf('AUTH_FAILURE_PATTERNS');
    const scanIdx = source.indexOf('AUTH_FAILURE_PATTERNS', firstIdx + 1);
    expect(scanIdx).toBeGreaterThan(-1);

    // The nearby context (look back far enough to see the slice call) must
    // reference slice(-4000)
    const scanBlock = source.slice(scanIdx - 400, scanIdx + 300);
    expect(scanBlock).toContain('slice(-4000)');
  });
});

describe('JobScheduler — authFailureReason flows into error fields', () => {
  it('authFailureReason is declared in the completion handler', () => {
    const source = readSource();
    expect(source).toContain('let authFailureReason: string | null = null');
  });

  it('authFailureReason flows into recordCompletion error field', () => {
    const source = readSource();
    // Find recordCompletion call in notifyJobComplete
    const recordIdx = source.indexOf('this.runHistory.recordCompletion({', source.indexOf('notifyJobComplete'));
    const recordBlock = source.slice(recordIdx, recordIdx + 400);
    expect(recordBlock).toContain('authFailureReason');
    expect(recordBlock).toContain('error:');
  });

  it('authFailureReason flows into persisted lastError field', () => {
    const source = readSource();
    // Find the JobState object literal in notifyJobComplete
    const jobStateIdx = source.indexOf('const jobState: JobState = {', source.indexOf('notifyJobComplete'));
    const jobStateBlock = source.slice(jobStateIdx, jobStateIdx + 400);
    expect(jobStateBlock).toContain('authFailureReason');
    expect(jobStateBlock).toContain('lastError:');
  });

  it('uses nullish coalescing to fall back to session-status string when no auth failure', () => {
    const source = readSource();
    // Both usages should follow the pattern: authFailureReason ?? `Session ...`
    const matches = source.match(/authFailureReason \?\? `Session/g);
    expect(matches).not.toBeNull();
    // Should appear in both recordCompletion and lastError
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});
