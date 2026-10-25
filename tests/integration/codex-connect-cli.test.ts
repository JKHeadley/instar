/**
 * Integration — `instar codex connect <agent>` through the real CLI (dist/cli.js),
 * the way an operator types it. Runs against a temp HOME (so `~/.instar/agents/<agent>`
 * and the machine registry are the test's own) and a temp CODEX_HOME.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const CLI = path.join(process.cwd(), 'dist', 'cli.js');

describe('instar codex connect <agent> (CLI)', () => {
  let tmp: string;
  let home: string;
  let codexHome: string;
  let env: NodeJS.ProcessEnv;

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args], {
        cwd: tmp,
        env,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
    }
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-codex-connect-cli-'));
    home = path.join(tmp, 'home');
    codexHome = path.join(tmp, 'codex');
    fs.mkdirSync(path.join(home, '.instar', 'agents', 'cli-agent', '.instar'), { recursive: true });
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      INSTAR_TEST_REGISTRY_DIR: path.join(home, '.instar'),
    };
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/codex-connect-cli.test.ts' });
  });

  it('writes the agent\'s threadline entry into $CODEX_HOME/config.toml and reports the file', () => {
    if (!fs.existsSync(CLI)) return; // dist-gated; the default suite builds dist via globalSetup
    const r = run(['codex', 'connect', 'cli-agent']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Connected hand-started Codex to agent "cli-agent"');
    expect(r.stdout).toContain(path.join(codexHome, 'config.toml'));

    const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8');
    expect(toml).toContain('[mcp_servers."threadline"]');
    expect(toml).toContain(`"--state-dir", "${path.join(home, '.instar', 'agents', 'cli-agent', '.instar')}"`);
    expect(toml).toContain('"--agent-name", "cli-agent"');
  });

  it('--dry-run prints the entry and writes nothing', () => {
    if (!fs.existsSync(CLI)) return;
    const r = run(['codex', 'connect', 'cli-agent', '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Dry run');
    expect(r.stdout).toContain('--agent-name cli-agent');
    expect(fs.existsSync(codexHome)).toBe(false);
  });

  it('exits non-zero with a plain reason for an agent that is not installed', () => {
    if (!fs.existsSync(CLI)) return;
    const r = run(['codex', 'connect', 'ghost-agent']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('codex connect failed');
    expect(r.stderr).toContain('ghost-agent');
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
  });
});
