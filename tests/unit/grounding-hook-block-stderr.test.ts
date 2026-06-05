/**
 * The grounding-before-messaging hook must put BLOCK output on STDERR.
 *
 * On a PreToolUse exit-2 block, Claude Code surfaces ONLY stderr to the agent.
 * The 2026-06-05 live incident: block reasons went to stdout, so every blocked
 * message rendered as "hook error ... No stderr output" — the agent saw a
 * malfunction instead of the quality findings and retried blind.
 *
 * Tests run the REAL template (both copies: src/templates/hooks/ and the
 * PostUpdateMigrator inline source that migrateHooks deploys) against a stub
 * convergence-check, asserting: block → exit 2 + findings on STDERR (stdout
 * quiet of them); pass → exit 0 + GROUNDED on stdout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(__dirname, '../../src/templates/hooks/grounding-before-messaging.sh');

function runHook(hookPath: string, projectDir: string, input: string, checkExit: number) {
  // Stub convergence-check: prints a finding and exits as instructed.
  const scriptsDir = path.join(projectDir, '.instar', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, 'convergence-check.sh'),
    `#!/bin/bash\necho "FINDING: stub quality issue"\nexit ${checkExit}\n`, { mode: 0o755 });
  try {
    const stdout = execFileSync('bash', [hookPath, input], {
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

const MSG = 'cat <<EOF | .instar/scripts/telegram-reply.sh 123\nhello\nEOF';

describe.each([
  ['src/templates copy', () => fs.readFileSync(TEMPLATE, 'utf-8')],
  ['PostUpdateMigrator deployed copy', () => {
    const migrator = new PostUpdateMigrator({ projectDir: '/tmp', stateDir: '/tmp/.instar', port: 4040 } as any);
    return (migrator as unknown as { getGroundingBeforeMessaging(): string }).getGroundingBeforeMessaging();
  }],
])('grounding-before-messaging block-output routing — %s', (_label, getSource) => {
  let dir: string;
  let hookPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ground-hook-'));
    hookPath = path.join(dir, 'hook.sh');
    fs.writeFileSync(hookPath, getSource(), { mode: 0o755 });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/grounding-hook-block-stderr.test.ts' }));

  it('BLOCK: exit 2 with the findings on STDERR (the channel Claude Code surfaces)', () => {
    const r = runHook(hookPath, dir, MSG, 1);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('FINDING: stub quality issue');
    expect(r.stderr).toContain('MESSAGE BLOCKED');
    expect(r.stdout).not.toContain('MESSAGE BLOCKED');
  });

  it('PASS: exit 0 with GROUNDED on stdout', () => {
    const r = runHook(hookPath, dir, MSG, 0);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('GROUNDED');
    expect(r.stderr).toBe('');
  });

  it('NON-MESSAGING input passes through untouched', () => {
    const r = runHook(hookPath, dir, 'ls -la /tmp', 1);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('GROUNDED');
  });
});
