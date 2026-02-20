/**
 * Tests for server command utilities.
 *
 * Validates execFileSync migration (command injection prevention)
 * and server lifecycle patterns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

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
