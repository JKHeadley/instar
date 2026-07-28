/**
 * Unit tests for the false-excuse deferral guard in the stop-gate-router hook.
 *
 * The guard is the structural fix for a recurring behavior the operator has flagged
 * REPEATEDLY: the agent NAMES clear remaining work it knows how to do, then STOPS
 * with a self-protective rationalization — "this session is too long", "it's late /
 * at midnight", "I made wrong turns so I'll be careful", "don't want to rush",
 * "tracked so it can't slip", "next focused session". These are FALSE excuses (the
 * agent does not tire; session length / time-of-day are irrelevant; "careful" means
 * do it NOW; "tracked" is not a reason to stop). The guard blocks ONCE
 * (mode-independent, fires even in shadow mode) and re-feeds the directive to PROCEED.
 *
 * These tests render the REAL hook via PostUpdateMigrator.getHookContent and EXECUTE
 * it as a subprocess — so a template-string error or a broken detection path fails
 * the suite. Mirrors stop-gate-stated-continuation.test.ts.
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
    projectDir: '/tmp/stop-gate-fe-render',
    stateDir: '/tmp/stop-gate-fe-render/.instar',
    hasTelegram: false,
    port: 59998,
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

describe('stop-gate-router — false-excuse deferral guard', () => {
  let tmp: string;
  let projectDir: string;
  let hookPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'false-excuse-'));
    projectDir = path.join(tmp, 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    // Dead server port → the server round-trip fails fast so the benign path reaches
    // exitOpen without a running Instar server (the guards run BEFORE the round-trip).
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ port: 59998, authToken: 'test' }),
    );
    hookPath = path.join(tmp, 'stop-gate-router.js');
    fs.writeFileSync(hookPath, renderHook(), { mode: 0o755 });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, {
      recursive: true,
      force: true,
      operation: 'tests/unit/stop-gate-false-excuse-deferral.test.ts',
    });
  });

  it('renders syntactically valid JS containing the guard', () => {
    execFileSync('node', ['--check', hookPath], { encoding: 'utf-8' });
    expect(fs.readFileSync(hookPath, 'utf-8')).toContain('falseExcuseDeferralGuard');
  });

  it('BLOCKS the real-world false-excuse stop (named work + self-protective excuse)', () => {
    const r = runHook(hookPath, projectDir, {
      session_id: 'f1',
      last_assistant_message:
        "I'm not force-pushing the core change into your live agent at midnight after a session where I made several wrong turns. The durable fix is scoped and durably tracked so it can't slip.",
    });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('"decision":"block"');
    expect(r.stdout).toContain('false-excuse deferral');
  });

  it('BLOCKS a session-length / next-session deferral with named work', () => {
    const r = runHook(hookPath, projectDir, {
      session_id: 'f2',
      last_assistant_message:
        'This session is too long already. The durable fix is the next step — I will tackle it next session, fresh and careful.',
    });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('block');
  });

  it('does NOT block a genuine completion (no pending work)', () => {
    const r = runHook(hookPath, projectDir, {
      session_id: 'f3',
      last_assistant_message:
        'Done — everything is verified, all PRs merged, nothing outstanding. Let me know if you need anything.',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('"decision":"block"');
  });

  it('does NOT block a time reference when there is NO clear deferred work (avoids false positive)', () => {
    const r = runHook(hookPath, projectDir, {
      session_id: 'f4',
      last_assistant_message:
        "It's late, but everything is complete and merged and the dashboard is healthy. Nothing is outstanding.",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('"decision":"block"');
  });

  it('does NOT re-block when stop_hook_active is true (loop guard prevents traps)', () => {
    const r = runHook(hookPath, projectDir, {
      session_id: 'f5',
      stop_hook_active: true,
      last_assistant_message: "The durable fix is tracked so it can't slip; next focused session.",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('"decision":"block"');
  });
});
