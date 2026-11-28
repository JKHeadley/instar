/**
 * Credential-bearing config.json must stay owner-only (0600) through
 * temp-file-and-rename rewrites, and the Claude credential stored at
 * sessions.credentials.anthropic.value must migrate to the secret store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { migrateSecrets } from '../../src/core/SecretMigrator.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('config credential protection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-mode-test-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/config-credential-file-mode.test.ts' });
  });

  it('LiveConfig.set rewrite keeps config.json at mode 0600', () => {
    if (process.platform === 'win32') return;
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'mode-check' }, null, 2), { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);

    const live = new LiveConfig(tmpDir, { checkIntervalMs: 60_000 });
    live.set('scheduler.enabled', true);

    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).scheduler.enabled).toBe(true);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('migrateSecrets moves sessions.credentials.anthropic.value into the secret store', () => {
    const configPath = path.join(tmpDir, 'config.json');
    const placeholderValue = ['claude', 'credential', 'placeholder'].join('-');
    fs.writeFileSync(configPath, JSON.stringify({
      projectName: 'migrate-check',
      sessions: { credentials: { anthropic: { value: placeholderValue, baseUrl: 'http://127.0.0.1:1' } } },
    }, null, 2));

    const result = migrateSecrets(configPath, tmpDir);

    expect(result.fields).toContain('sessions.credentials.anthropic.value');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.sessions.credentials.anthropic.value).toEqual({ secret: true });
    expect(config.sessions.credentials.anthropic.baseUrl).toBe('http://127.0.0.1:1');
    const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
    expect(store.get('sessions.credentials.anthropic.value')).toBe(placeholderValue);
  });
  it('loading a group/world-readable config.json (0664) repairs it to 0600', () => {
    if (process.platform === 'win32') return;
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'open-file' }, null, 2));
    fs.chmodSync(configPath, 0o664);

    const live = new LiveConfig(tmpDir, { checkIntervalMs: 60_000 });

    expect(live.get('projectName', '')).toBe('open-file');
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('LiveConfig.set on a config.json that started at 0664 leaves it at 0600', () => {
    if (process.platform === 'win32') return;
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'open-then-set' }, null, 2));
    fs.chmodSync(configPath, 0o664);

    const live = new LiveConfig(tmpDir, { checkIntervalMs: 60_000 });
    live.set('scheduler.enabled', true);

    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('an owner-only config.json is left unchanged on load', () => {
    if (process.platform === 'win32') return;
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'closed' }, null, 2), { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    new LiveConfig(tmpDir, { checkIntervalMs: 60_000 });
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
