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

/** Codex variant: the shell tool is 'exec_command' and the command is in tool_input.cmd. */
function runHookCodex(cmd: string): { exitCode: number; parsed: { decision?: string; additionalContext?: string } | null } {
  const input = JSON.stringify({ tool_name: 'exec_command', tool_input: { cmd } });
  const result = spawnSync('node', [hookPath], { input, encoding: 'utf-8', timeout: 5000 });
  let parsed: { decision?: string; additionalContext?: string } | null = null;
  if (result.stdout && result.stdout.trim().length > 0) {
    try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  }
  return { exitCode: result.status ?? -1, parsed };
}

describe('deferral-detector — Codex payload shape (exec_command / cmd)', () => {
  it('fires on a Codex exec_command payload with orphan-TODO language (regression: was Claude-only)', () => {
    const result = runHookCodex(
      'cat <<EOF | telegram-reply.sh 100\nI will handle the rest in a follow-up session later.\nEOF'
    );
    // Same detection as the Bash path — proves the detector reads exec_command + cmd.
    expect(result.parsed).not.toBeNull();
    expect(result.parsed!.decision).toBe('approve');
    expect(result.parsed!.additionalContext).toMatch(/ORPHAN-TODO TRAP DETECTED|DEFERRAL DETECTED/);
  });

  it('ignores a Codex exec_command that is a clean message', () => {
    const result = runHookCodex(
      'cat <<EOF | telegram-reply.sh 100\nDone, shipped on main.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBeNull();
  });
});

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

describe('deferral-detector — time/fatigue deferral patterns (2026-06-09 gravity well)', () => {
  it('fires on the exact incident phrasing ("rather than rush it at the tail of tonight")', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nI would rather not rush it at the tail of tonight, so I will do it carefully.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/TIME\/FATIGUE DEFERRAL DETECTED/);
    expect(result.parsed?.additionalContext).toMatch(/tail_of_period|avoid_rushing/);
  });

  it('THE KEY FIX: still fires even when the deferral is "tracked" (infrastructure-backed does NOT launder the framing)', () => {
    const result = runHook(
      "cat <<EOF | telegram-reply.sh 100\nI've filed a /commit-action and a tracked commitment for it — rather than rush at the tail of the night, I'll queue it for the next session.\nEOF"
    );
    expect(result.exitCode).toBe(0);
    // The orphan section is suppressed (infra-backed), but the TIME/FATIGUE section MUST still fire.
    expect(result.parsed?.additionalContext).toMatch(/TIME\/FATIGUE DEFERRAL DETECTED/);
    expect(result.parsed?.additionalContext || '').not.toMatch(/ORPHAN-TODO TRAP/);
  });

  it('fires on "it\'s late"', () => {
    const result = runHook(
      "cat <<EOF | telegram-reply.sh 100\nIt's late, so I'll hold off on the rest.\nEOF"
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/its_late/);
  });

  it('fires on "wrap up for now"', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nLet me wrap up here and we can continue another time.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/wind_down/);
  });

  it('fires on "tomorrow I\'ll"', () => {
    const result = runHook(
      "cat <<EOF | telegram-reply.sh 100\nTomorrow I'll pick up the remaining items.\nEOF"
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/do_it_tomorrow/);
  });

  it('fires on "defer it to next session"', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nThe durable fix — I will defer it to next session.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/defer_to_later_time|TIME\/FATIGUE/);
  });

  it('the checklist tells the agent to quote the actual injected current time', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nIt is getting late, let me call it a night here.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.additionalContext).toMatch(/CURRENT TIME|actual current time|check the clock/i);
  });

  it('does NOT fire on a clean message with no time/fatigue framing', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nBoth fixes verified live on v1.3.448. Continuing to the next item now.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBeNull();
  });

  it('never blocks — decision stays approve', () => {
    const result = runHook(
      'cat <<EOF | telegram-reply.sh 100\nIt is late, I will wrap up.\nEOF'
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.decision).toBe('approve');
  });
});
