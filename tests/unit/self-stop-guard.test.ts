/**
 * Unit test — self-stop-guard hook.
 *
 * The hook source lives inside `getSelfStopGuardHook()` in
 * src/core/PostUpdateMigrator.ts and is deployed at install time to
 * .instar/hooks/instar/self-stop-guard.js. This test renders the hook from the
 * source-of-truth template and spawns it via child_process — exercising the
 * real shipped regex/decision layer end-to-end (no mocking).
 *
 * The hook is SIGNAL-ONLY: it never blocks. On a detected stop-excuse it writes
 * { decision: 'approve', additionalContext: <checklist> } to stdout. Otherwise
 * it exits 0 with empty stdout. Born from the 2026-06-02 "maxed out context"
 * self-stop correction. Task #34.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-stop-guard-test-'));
  hookPath = path.join(tmpDir, 'self-stop-guard.js');
  const migrator = new PostUpdateMigrator({
    projectDir: tmpDir,
    stateDir: path.join(tmpDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'self-stop-guard-test',
  });
  const hookContent = (
    migrator as unknown as { getHookContent(name: string): string }
  ).getHookContent('self-stop-guard');
  fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
});

afterAll(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, sourceTreeOverride: true });
});

/** Spawn the hook with a PreToolUse payload, return stdout. */
function runHook(toolName: string, commandKey: 'command' | 'cmd', command: string): string {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: { [commandKey]: command } });
  const res = spawnSync('node', [hookPath], { input: payload, encoding: 'utf-8' });
  return (res.stdout || '').trim();
}

/** Convenience: a Claude Bash telegram-reply carrying the given message text. */
function telegramReply(message: string): string {
  return runHook('Bash', 'command', `cat <<'EOF' | .instar/scripts/telegram-reply.sh 13435\n${message}\nEOF`);
}

describe('self-stop-guard — fires on context/length stop-excuses in outbound messages', () => {
  const excuses: Array<[string, string]> = [
    ['maxed_context', "I'm maxed out on context, so let's pause here."],
    ['low_on_context', "I'm running low on context — better to stop."],
    ['session_too_long', 'This session has been running too long, so I should wrap up.'],
    ['long_running_session', "It's a long-running session, time to stop."],
    ['fresh_session_deflection', "Why don't we start a fresh session to continue?"],
    ['continue_fresh_session', "Let's pick this up in a new session."],
    ['close_out_and_restart', "Let's close this out and start a new run."],
    ['good_stopping_point', 'This feels like a good stopping point.'],
    ['preserve_context', 'I want to preserve context, so I will stop now.'],
  ];

  for (const [label, msg] of excuses) {
    it(`flags "${label}"`, () => {
      const out = telegramReply(msg);
      expect(out).not.toBe('');
      const parsed = JSON.parse(out);
      expect(parsed.decision).toBe('approve'); // signal-only — never blocks
      expect(parsed.additionalContext).toContain('SELF-STOP EXCUSE DETECTED');
      expect(parsed.additionalContext).toContain('NEVER valid');
    });
  }

  it('fires for Codex exec_command (tool_input.cmd) too', () => {
    const out = runHook('exec_command', 'cmd', "echo 'maxed out context, starting a fresh session' | .instar/scripts/telegram-reply.sh 1");
    expect(out).not.toBe('');
    expect(JSON.parse(out).additionalContext).toContain('SELF-STOP EXCUSE DETECTED');
  });
});

describe('self-stop-guard — silent on the other side of the boundary', () => {
  it('does NOT fire on a normal outbound message (no stop-excuse)', () => {
    expect(telegramReply('On it — the fix is landing now, will report when CI is green.')).toBe('');
  });

  it('does NOT fire when the stop is legitimate (work complete)', () => {
    // Even though "wrap up" could match, the legitimate-completion anti-trigger wins.
    expect(telegramReply('The build is complete and all tests are passing — wrapping up this task.')).toBe('');
  });

  it('does NOT fire on the autonomous completion promise', () => {
    expect(telegramReply('All tasks done. <promise>ALL_TASKS_COMPLETE</promise>')).toBe('');
  });

  it('does NOT fire when the user explicitly asked to stop', () => {
    expect(telegramReply('Understood — stopping now since you asked me to stop.')).toBe('');
  });

  it('does NOT fire on a NON-communication command even if it contains excuse text', () => {
    // A shell command that merely mentions "context" must not trip the guard —
    // only outbound user messages are in scope.
    expect(runHook('Bash', 'command', 'grep -r "maxed out context" logs/ | head')).toBe('');
  });

  it('does NOT fire on a non-shell tool', () => {
    const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });
    const res = spawnSync('node', [hookPath], { input: payload, encoding: 'utf-8' });
    expect((res.stdout || '').trim()).toBe('');
  });
});
