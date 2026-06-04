/**
 * Tests for server command utilities.
 *
 * Validates execFileSync migration (command injection prevention)
 * and server lifecycle patterns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { shouldRejectServerLifecycleFromSession } from '../../src/core/SessionServerGuard.js';

describe('server command security', () => {
  it('execFileSync prevents shell injection in session names', () => {
    // Verify that execFileSync with argument arrays doesn't allow injection
    // A malicious project name like "test; rm -rf /" would be treated as a literal session name
    const maliciousName = 'test; rm -rf /';

    // execFileSync with args array passes the name as a single argument
    // Unlike execSync which would interpret the semicolon as a command separator
    expect(() => {
      execFileSync('echo', ['has-session', '-t', `=${maliciousName}`], { encoding: 'utf-8' });
    }).not.toThrow();

    // The output should contain the full malicious string as a literal
    const output = execFileSync('echo', ['-t', `=${maliciousName}`], { encoding: 'utf-8' });
    expect(output.trim()).toBe(`-t =${maliciousName}`);
  });

  it('execFileSync with backticks in name is safe', () => {
    const backtickName = 'test`whoami`';
    const output = execFileSync('echo', [backtickName], { encoding: 'utf-8' });
    expect(output.trim()).toBe(backtickName);
  });

  it('execFileSync with dollar sign in name is safe', () => {
    const dollarName = 'test$(id)';
    const output = execFileSync('echo', [dollarName], { encoding: 'utf-8' });
    expect(output.trim()).toBe(dollarName);
  });
});

describe('server startup warnings', () => {
  it('server.ts warns when no auth token is configured', () => {
    const source = require('fs').readFileSync(
      path.join(process.cwd(), 'src/commands/server.ts'),
      'utf-8'
    );
    // Should check for missing authToken and warn
    expect(source).toContain('!config.authToken');
    expect(source).toContain('WARNING');
    expect(source).toContain('unauthenticated');
  });
});

describe('server session name derivation', () => {
  it('server session name is derived from project name', () => {
    const projectName = 'my-agent';
    const serverSessionName = `${projectName}-server`;
    expect(serverSessionName).toBe('my-agent-server');
  });

  it('handles unicode project names', () => {
    const projectName = 'agente-español';
    const serverSessionName = `${projectName}-server`;
    expect(serverSessionName).toBe('agente-español-server');
  });
});

describe('session server lifecycle guard', () => {
  it('allows server lifecycle commands outside a session', () => {
    const decision = shouldRejectServerLifecycleFromSession({
      action: 'server restart',
      currentProjectDir: '/tmp/codey',
      targetDir: '/tmp/codey',
      sessionId: '',
    });

    expect(decision.reject).toBe(false);
  });

  it('rejects restarting the current managing server and includes a supervisor hint', () => {
    const decision = shouldRejectServerLifecycleFromSession({
      action: 'server restart',
      currentProjectDir: '/tmp/codey',
      targetDir: '/tmp/codey',
      sessionId: 'session-123',
      uid: 501,
      projectName: 'codey',
    });

    expect(decision.reject).toBe(true);
    expect(decision.message).toContain("Cannot 'server restart' for this agent");
    expect(decision.supervisorHint).toBe('launchctl kickstart -k gui/501/ai.instar.codey');
  });

  it('allows restarting a sibling agent server from inside a session', () => {
    const decision = shouldRejectServerLifecycleFromSession({
      action: 'server restart',
      currentProjectDir: '/tmp/codey',
      targetDir: '/tmp/gemini',
      sessionId: 'session-123',
    });

    expect(decision.reject).toBe(false);
  });

  it('rejects a symlink target that resolves to the current managing server', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-session-guard-'));
    try {
      const currentProjectDir = path.join(root, 'codey');
      const linkedProjectDir = path.join(root, 'codey-link');
      fs.mkdirSync(currentProjectDir);
      fs.symlinkSync(currentProjectDir, linkedProjectDir);

      const decision = shouldRejectServerLifecycleFromSession({
        action: 'server restart',
        currentProjectDir,
        targetDir: linkedProjectDir,
        sessionId: 'session-123',
        uid: 501,
        projectName: 'codey',
      });

      expect(decision.reject).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(root, {
        recursive: true,
        force: true,
        operation: 'tests/unit/server-commands.test.ts:session-server-lifecycle-guard',
      });
    }
  });
});
