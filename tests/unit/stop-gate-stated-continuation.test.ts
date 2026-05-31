/**
 * Unit tests for the stated-continuation guard in the stop-gate-router hook.
 *
 * The guard is the structural fix for the recurring "silent stall after stating
 * you'll continue" behavior: the agent's final message tells the user it is
 * about to act this turn ("I'll build X now", "Next phase: ship ...") and then
 * the turn ENDS without doing it. The guard blocks ONCE (mode-independent, so it
 * fires even when the server-side gate is in shadow mode — which is exactly when
 * these stalls slipped through) and re-feeds: do the work, or tell the user
 * plainly you're stopping.
 *
 * These tests render the real hook via PostUpdateMigrator.getHookContent and
 * EXECUTE it as a subprocess against representative Stop-hook payloads — so a
 * template-string syntax error or a broken detection path fails the suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function renderHook(): string {
  const m = new PostUpdateMigrator({
    projectDir: '/tmp/stop-gate-render',
    stateDir: '/tmp/stop-gate-render/.instar',
    hasTelegram: false,
    port: 59999,
  });
  return m.getHookContent('stop-gate-router');
}

function runHook(hookPath: string, projectDir: string, input: object): { code: number; stdout: string } {
  try {
    const stdout = execFileSync('node', [hookPath], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, INSTAR_AUTH_TOKEN: 'test' },
      timeout: 8000,
    });
    return { code: 0, stdout };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return { code: err.status ?? -1, stdout: (err.stdout || '').toString() };
  }
}

describe('stop-gate-router — stated-continuation guard', () => {
  let tmp: string;
  let projectDir: string;
  let hookPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stated-cont-'));
    projectDir = path.join(tmp, 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    // Dead server port → the server round-trip fails fast (ECONNREFUSED) so the
    // benign path reaches exitOpen without depending on a running Instar server.
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ port: 59999, authToken: 'test' }),
    );
    hookPath = path.join(tmp, 'stop-gate-router.js');
    fs.writeFileSync(hookPath, renderHook(), { mode: 0o755 });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, {
      recursive: true,
      force: true,
      operation: 'tests/unit/stop-gate-stated-continuation.test.ts',
    });
  });

  it('renders syntactically valid JS containing the guard', () => {
    // node --check throws on any syntax error in the rendered template string.
    execFileSync('node', ['--check', hookPath], { encoding: 'utf-8' });
    expect(fs.readFileSync(hookPath, 'utf-8')).toContain('statedContinuationGuard');
  });

  it('BLOCKS when the final message states imminent action ("I\'ll build X now")', () => {
    const r = runHook(hookPath, projectDir, {
      session_id: 's1',
      last_assistant_message: "Great — I'll build that now and report back.",
    });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('"decision":"block"');
    expect(r.stdout).toContain('stated-continuation');
  });

  it('BLOCKS on the exact real-world stall pattern ("Next phase: build ...")', () => {
    const r = runHook(hookPath, projectDir, {
      session_id: 's2',
      last_assistant_message:
        'Milestone reached. Next phase: build the reverse reply-relay, then ship the durable fix.',
    });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('block');
  });

  it('does NOT block a benign completion message (no imminent commitment)', () => {
    const r = runHook(hookPath, projectDir, {
      session_id: 's3',
      last_assistant_message:
        'Done — all tests passed and the PR is merged. Let me know if you need anything else.',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('"decision":"block"');
  });

  it('does NOT re-block when stop_hook_active is true (loop guard prevents traps)', () => {
    const r = runHook(hookPath, projectDir, {
      session_id: 's4',
      stop_hook_active: true,
      last_assistant_message: "I'll build that now.",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('"decision":"block"');
  });
});
