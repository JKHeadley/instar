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

  const run = (args: string[]) => spawnSync(process.execPath, [scriptSrc, ...args, '--pipe-fd3'], {
    cwd: tmpDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, VITEST: '1' },
  });
  const writeConfig = (cfg: unknown) => fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(cfg));

  it('refuses bare reads and transfers only one array leaf through a private channel', () => {
    writeConfig({ messaging: [{ config: { token: 'synthetic-array-token', appToken: 'synthetic-other-token' } }] });
    const bare = spawnSync(process.execPath, [scriptSrc, 'messaging'], { cwd: tmpDir, encoding: 'utf8' });
    expect(bare.status).toBe(2);
    expect(bare.stdout).toBe('');
    expect(bare.stderr).not.toContain('synthetic-array-token');
    const leaf = run(['messaging[0].config.token']);
    expect(leaf.status).toBe(0);
    expect(leaf.stdout).toBe('');
    expect(leaf.output[3]).toBe('synthetic-array-token');
    expect(run(['messaging']).status).toBe(1);
  });

  it('refuses an internal pipe aliased to stdout or stderr', () => {
    if (process.platform === 'win32') return;
    writeConfig({ authToken: 'synthetic-aliased-token' });
    for (const destination of ['3>&1', '3>&2']) {
      const refused = spawnSync('/bin/sh', ['-c', '"$1" "$2" authToken --pipe-fd3 ' + destination, 'fixture', process.execPath, scriptSrc],
        { cwd: tmpDir, encoding: 'utf8' });
      expect(refused.status).toBe(2);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).not.toContain('synthetic-aliased-token');
    }
  });

  it('drops both streams from an explicit child, including when a child echoes stdin', () => {
    writeConfig({ authToken: 'synthetic-child-token' });
    const consuming = spawnSync(process.execPath, [
      scriptSrc, 'authToken', '--run', '--', process.execPath, '-e',
      "const value = require('node:fs').readFileSync(0, 'utf8'); process.stdout.write(value); process.stderr.write(value); process.exit(value === 'synthetic-child-token' ? 0 : 9)",
    ], { cwd: tmpDir, encoding: 'utf8' });
    expect(consuming.status).toBe(0);
    expect(consuming.stdout).toBe('');
    expect(consuming.stderr).not.toContain('synthetic-child-token');
  });

  it('with no vault, returns a plain config value and names the source on stderr only', () => {
    writeConfig({ authToken: 'plain-token-123', messaging: { slack: { botToken: 'xoxb-plain' } } });
    const r = run(['authToken']);
    expect(r.status).toBe(0);
    expect(r.output[3]).toBe('plain-token-123');
    expect(r.stderr).toContain('config.json');
    expect(r.stderr).not.toContain('plain-token-123');
    const nested = run(['messaging.slack.botToken']);
    expect(nested.status).toBe(0);
    expect(nested.output[3]).toBe('xoxb-plain');
  });

  it('with a vault lacking the key, falls back to the plain config value', () => {
    new SecretStore({ stateDir }).write({ github_token: 'ghp_x' });
    writeConfig({ authToken: 'plain-token-456' });
    const r = run(['authToken']);
    expect(r.status).toBe(0);
    expect(r.output[3]).toBe('plain-token-456');
    expect(r.stderr).toContain('not in the vault');
  });

  it('prefers the vault value when both exist', () => {
    new SecretStore({ stateDir }).write({ authToken: 'vault-token' });
    writeConfig({ authToken: 'stale-plain-token' });
    const r = run(['authToken']);
    expect(r.status).toBe(0);
    expect(r.output[3]).toBe('vault-token');
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
