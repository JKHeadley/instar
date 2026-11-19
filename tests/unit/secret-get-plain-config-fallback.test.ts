import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// A machine whose secrets were never moved into the vault keeps them as plain
// strings in .instar/config.json (seen on the M5, 2026-11-17: `secret-get.mjs
// authToken` printed nothing there). The script falls back to that plain value;
// a `{ secret: true }` placeholder is a vault reference and is never returned.

describe('secret-get.mjs — plain config.json fallback', () => {
  let tmpDir: string;
  let stateDir: string;
  const scriptSrc = path.resolve(__dirname, '../../src/templates/scripts/secret-get.mjs');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-get-cfg-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.symlinkSync(path.resolve(__dirname, '../../dist'), path.join(tmpDir, 'dist'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/secret-get-plain-config-fallback.test.ts:afterEach' });
  });

  const run = (args: string[]) => spawnSync(process.execPath, [scriptSrc, ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, VITEST: '1' },
  });
  const writeConfig = (cfg: unknown) => fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(cfg));

  it('with no vault, returns a plain config value and names the source on stderr only', () => {
    writeConfig({ authToken: 'plain-token-123', messaging: { slack: { botToken: 'xoxb-plain' } } });
    const r = run(['authToken']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('plain-token-123');
    expect(r.stderr).toContain('config.json');
    expect(r.stderr).not.toContain('plain-token-123');
    const nested = run(['messaging.slack.botToken']);
    expect(nested.status).toBe(0);
    expect(nested.stdout).toBe('xoxb-plain');
  });

  it('with a vault lacking the key, falls back to the plain config value', () => {
    new SecretStore({ stateDir }).write({ github_token: 'ghp_x' });
    writeConfig({ authToken: 'plain-token-456' });
    const r = run(['authToken']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('plain-token-456');
    expect(r.stderr).toContain('not in the vault');
  });

  it('prefers the vault value when both exist', () => {
    new SecretStore({ stateDir }).write({ authToken: 'vault-token' });
    writeConfig({ authToken: 'stale-plain-token' });
    const r = run(['authToken']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('vault-token');
    expect(r.stderr).toBe('');
  });

  it('never returns a { secret: true } placeholder, and fails with zero stdout bytes', () => {
    new SecretStore({ stateDir }).write({ github_token: 'ghp_x' });
    writeConfig({ authToken: { secret: true } });
    const r = run(['authToken']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('github_token');
  });

  it('with no vault and no plain value, keeps the no-vault error', () => {
    writeConfig({ authToken: { secret: true }, port: 4042 });
    for (const key of ['authToken', 'port', 'missing']) {
      const r = run([key]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('no vault');
    }
  });
});
