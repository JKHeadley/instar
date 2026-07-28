import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

describe('CLI unknown command handling', () => {
  it('exits clearly for an unknown top-level command instead of entering setup', () => {
    const cli = path.join(process.cwd(), 'dist', 'cli.js');
    if (!fs.existsSync(cli)) {
      return;
    }

    const result = spawnSync(process.execPath, [cli, 'dev:claim-checkk'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: unknown command 'dev:claim-checkk'");
    expect(result.stderr).toContain("Run 'instar --help' for available commands.");
    expect(result.stdout).not.toContain('Interactive setup wizard');
    expect(result.error).toBeUndefined();
  });

  it('prints help for the implicit help command instead of entering setup', () => {
    const cli = path.join(process.cwd(), 'dist', 'cli.js');
    if (!fs.existsSync(cli)) {
      return;
    }

    const result = spawnSync(process.execPath, [cli, 'help'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: instar');
    expect(result.stdout).toContain('Commands:');
    expect(result.stdout).not.toContain('Checking prerequisites');
    expect(result.stdout).not.toContain('Welcome to Instar');
    expect(result.stderr).toBe('');
    expect(result.error).toBeUndefined();
  });
});
