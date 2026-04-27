/**
 * Unit test — deferral-detector orphan-TODO patterns.
 *
 * The hook source lives inside `getDeferralDetectorHook()` in
 * src/core/PostUpdateMigrator.ts and is deployed at install time to
 * .instar/hooks/instar/deferral-detector.js. This test renders the hook
 * to a temp file and spawns it via child_process — exercising the real
 * shipped behavior end-to-end (no mocking of the regex layer).
 *
 * Spec: docs/specs/deferral-detector-orphan-todo.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let hookPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deferral-detector-test-'));
  hookPath = path.join(tmpDir, 'deferral-detector.js');

  // Render the hook from PostUpdateMigrator's source-of-truth template.
  const migrator = new PostUpdateMigrator({
    projectDir: tmpDir,
    stateDir: path.join(tmpDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'deferral-test',
  });
  const hookContent = (
    migrator as unknown as { getHookContent(name: string): string }
  ).getHookContent('deferral-detector');
  fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
});

afterAll(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/deferral-detector-orphan-todo.test.ts:cleanup',
  });
});

function runHook(command: string): {
  exitCode: number;
  stdout: string;
  parsed: { decision?: string; additionalContext?: string } | null;
} {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
  });
  const result = spawnSync('node', [hookPath], {
    input,
    encoding: 'utf-8',
    timeout: 5000,
  });
  let parsed: { decision?: string; additionalContext?: string } | null = null;
  if (result.stdout && result.stdout.trim().length > 0) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = null;
    }
  }
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout || '',
    parsed,
  };
}

describe('deferral-detector — orphan-TODO patterns', () => {
  it('does not fire on a clean message', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nDone, the build is shipped on main at f9b5e3bb.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBeNull();
  });

  it('fires on "queue them for the next session"', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nLayer 1 shipped. Want me to queue them for the next session?\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/ORPHAN-TODO TRAP/i);
    expect(result.parsed?.additionalContext).toMatch(/queue_for_later/);
  });

  it('fires on "we can pick this up later"', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nWe can pick this up later when we have more time.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/ORPHAN-TODO TRAP/i);
    expect(result.parsed?.additionalContext).toMatch(/pick_up_later/);
  });

  it('fires on "I\'ll fix that later"', () => {
    const result = runHook(
      "cat <<EOF | telegram-reply.sh 100\nI'll fix that later.\nEOF"
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/ORPHAN-TODO TRAP/i);
    expect(result.parsed?.additionalContext).toMatch(/self_promised_later/);
  });

  it('fires on "deferred to a later session"', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nThe templates-drift verifier is deferred to a later session.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/ORPHAN-TODO TRAP/i);
    expect(result.parsed?.additionalContext).toMatch(/explicit_defer/);
  });

  it('does NOT fire on "deferred to a follow-up PR" (the chained-PR pattern is infrastructure-backed)', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nThe templates-drift verifier is deferred to a follow-up PR.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    if (result.parsed) {
      expect(result.parsed.additionalContext || '').not.toMatch(/ORPHAN-TODO TRAP/);
    }
  });

  it('fires on "future work"', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nThis is future work — leaving as-is for now.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/ORPHAN-TODO TRAP/i);
    expect(result.parsed?.additionalContext).toMatch(/future_work_marker/);
  });

  it('SUPPRESSES orphan-TODO checklist when /schedule is named', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nWant me to /schedule a remote agent to pick this up later?\nEOF'
    );
    expect(result.exitCode).toBe(0);
    // Either no additional context, or no orphan section.
    if (result.parsed) {
      expect(result.parsed.additionalContext || '').not.toMatch(/ORPHAN-TODO TRAP/);
    }
  });

  it('SUPPRESSES orphan-TODO checklist when /commit-action is named', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nFiling a /commit-action so we pick this up later.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    if (result.parsed) {
      expect(result.parsed.additionalContext || '').not.toMatch(/ORPHAN-TODO TRAP/);
    }
  });

  it('SUPPRESSES on same-branch follow-up commit phrasing', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nQueueing this for a follow-up commit on the same branch before we stop.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    if (result.parsed) {
      expect(result.parsed.additionalContext || '').not.toMatch(/ORPHAN-TODO TRAP/);
    }
  });

  it('still fires inability-claim independently of orphan patterns', () => {
    const result = runHook(
      "cat <<EOF | telegram-reply.sh 100\nI can't do this myself, you'll need to handle it.\nEOF"
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/DEFERRAL DETECTED/);
    expect(result.parsed?.additionalContext).toMatch(/inability_claim|directing_human/);
  });

  it('emits BOTH sections when message has both inability and orphan patterns', () => {
    const result = runHook(
      "cat <<EOF | telegram-reply.sh 100\nI can't tackle that one — let's queue it for the next session.\nEOF"
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/DEFERRAL DETECTED/);
    expect(result.parsed?.additionalContext).toMatch(/ORPHAN-TODO TRAP/);
  });

  it('does not fire on non-message commands', () => {
    const result = runHook('git commit -m "wip — pick this up later in a follow-up"');
    expect(result.exitCode).toBe(0);
    // The command pattern gate filters out non-message commands.
    expect(result.parsed).toBeNull();
  });

  it('returns valid JSON with decision: approve (never blocks)', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nQueue them for the next session.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.decision).toBe('approve');
  });
});
