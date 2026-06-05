/**
 * Boot-guard integration tests (spec: docs/specs/keychain-per-agent-master-key.md §3).
 *
 * loadConfig() must FAIL FAST with an actionable error when {secret:true}
 * placeholders survive the merge in boot-critical fields — instead of leaking
 * placeholder objects into runtime config and crashing minutes later on a type
 * error (the 2026-06-05 incident's tokenHash(Object) crash-loop).
 *
 * These tests drive the REAL production path: config.json + SecretStore on
 * disk → loadConfig() → merge → guard. No keychain interaction (temp stateDirs
 * generate file keys only).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../../src/core/Config.js';
import { migrateSecrets } from '../../src/core/SecretMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('loadConfig boot guard — critical secret placeholders', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-boot-guard-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/config-critical-secret-placeholders.test.ts:afterEach',
    });
  });

  function writeConfig(config: Record<string, unknown>): string {
    const p = path.join(stateDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
    return p;
  }

  it('GREEN PATH: migrated secrets resolve through loadConfig (the production roundtrip)', () => {
    const configPath = writeConfig({
      projectName: 'boot-guard-green',
      port: 4099,
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude' },
      messaging: [
        { type: 'telegram', enabled: true, config: { token: 'bot42:REAL', chatId: '-100777', pollIntervalMs: 1000 } },
      ],
    });
    const result = migrateSecrets(configPath, stateDir);
    expect(result.extracted).toBeGreaterThan(0);
    // On-disk config now holds placeholders…
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(onDisk.messaging[0].config.token).toEqual({ secret: true });
    // …but loadConfig resolves them back to strings (no boot-guard trip)
    const cfg = loadConfig(projectDir);
    const tg = (cfg.messaging as Array<{ config: Record<string, unknown> }>)[0];
    expect(tg.config['token']).toBe('bot42:REAL');
    expect(tg.config['chatId']).toBe('-100777');
  });

  it('THE INCIDENT SHAPE: undecryptable store + enabled telegram placeholders → fast, actionable boot failure', () => {
    const configPath = writeConfig({
      projectName: 'boot-guard-incident',
      port: 4099,
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude' },
      messaging: [
        { type: 'telegram', enabled: true, config: { token: 'bot42:REAL', chatId: '-100777' } },
      ],
    });
    migrateSecrets(configPath, stateDir);
    // Corrupt the master key: the store can no longer be decrypted by anything
    fs.writeFileSync(
      path.join(stateDir, 'machine', 'secrets-master.key'),
      crypto.randomBytes(32).toString('hex'),
      { mode: 0o600 },
    );
    expect(() => loadConfig(projectDir)).toThrow(
      /Secrets cannot be resolved for boot-critical config fields: messaging\[0\]\.config\.token, messaging\[0\]\.config\.chatId[\s\S]*keychain-per-agent-master-key/,
    );
  });

  it('DISABLED adapters never gate boot — placeholders degrade with a report instead', () => {
    const configPath = writeConfig({
      projectName: 'boot-guard-disabled',
      port: 4099,
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude' },
      messaging: [
        { type: 'telegram', enabled: false, config: { token: 'bot42:REAL', chatId: '-100777' } },
      ],
    });
    migrateSecrets(configPath, stateDir);
    fs.writeFileSync(
      path.join(stateDir, 'machine', 'secrets-master.key'),
      crypto.randomBytes(32).toString('hex'),
      { mode: 0o600 },
    );
    expect(() => loadConfig(projectDir)).not.toThrow();
  });

  it('authToken placeholder gates boot ONLY when binding non-loopback', () => {
    const base = {
      projectName: 'boot-guard-authtoken',
      port: 4099,
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude' },
      authToken: 'sk-secret-token-value',
      messaging: [],
    };
    // Loopback (default host): degraded, not fatal
    const configPath = writeConfig(base);
    migrateSecrets(configPath, stateDir);
    fs.writeFileSync(
      path.join(stateDir, 'machine', 'secrets-master.key'),
      crypto.randomBytes(32).toString('hex'),
      { mode: 0o600 },
    );
    expect(() => loadConfig(projectDir)).not.toThrow();

    // Non-loopback: fatal
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    onDisk.host = '0.0.0.0';
    fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2));
    expect(() => loadConfig(projectDir)).toThrow(/boot-critical config fields: authToken/);
  });

  it('a config with NO placeholders never trips the guard even when the merge throws', () => {
    // Plain config, but plant an undecryptable store so mergeConfigWithSecrets throws
    writeConfig({
      projectName: 'boot-guard-plain',
      port: 4099,
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude' },
      authToken: 'raw-token',
      messaging: [
        { type: 'telegram', enabled: true, config: { token: 'raw:token', chatId: '-1' } },
      ],
    });
    const secretsDir = path.join(stateDir, 'secrets');
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, 'config.secrets.enc'), crypto.randomBytes(64));
    const cfg = loadConfig(projectDir);
    const tg = (cfg.messaging as Array<{ config: Record<string, unknown> }>)[0];
    expect(tg.config['token']).toBe('raw:token');
  });
});
