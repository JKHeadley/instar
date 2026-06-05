/**
 * E2E lifecycle: secret key resolution through the PRODUCTION boot entry point
 * (spec: docs/specs/keychain-per-agent-master-key.md).
 *
 * Mirrors server.ts's first boot step exactly: `loadConfig(projectDir)` over an
 * init-shaped project whose secrets went through the production migration. The
 * "feature is alive" assertion: a migrated agent BOOTS (placeholders resolve to
 * strings); the incident shape FAILS FAST with the actionable error instead of
 * the historical 2-minutes-later tokenHash(Object) crash-loop.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/core/Config.js';
import { migrateSecrets } from '../../src/core/SecretMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('E2E: secret key resolution lifecycle (production boot path)', () => {
  let projectDir: string;
  let stateDir: string;
  let configPath: string;

  beforeAll(() => {
    // ── Phase 1: init-shaped project ──────────────────────────────
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-e2e-keyres-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      projectName: 'e2e-key-resolution',
      port: 0,
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude' },
      authToken: 'e2e-token-value',
      messaging: [
        { type: 'telegram', enabled: true, config: { token: 'bot99:E2E', chatId: '-100999', pollIntervalMs: 5000 } },
      ],
    }, null, 2));

    // ── Phase 2: production secret migration ──────────────────────
    const result = migrateSecrets(configPath, stateDir);
    expect(result.extracted).toBeGreaterThan(0);
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/secret-key-resolution-lifecycle.test.ts:afterAll',
    });
  });

  it('IS ALIVE: a migrated agent boots — loadConfig resolves every placeholder to a string', () => {
    const cfg = loadConfig(projectDir);
    const tg = (cfg.messaging as Array<{ config: Record<string, unknown> }>)[0];
    expect(tg.config['token']).toBe('bot99:E2E');
    expect(tg.config['chatId']).toBe('-100999');
    expect(cfg.authToken).toBe('e2e-token-value');
    // The production migration left a per-agent file key behind (test runs are
    // file-key-only by the VITEST keychain guard; key COHERENCE itself is
    // owned by #810's vault-key-coherence suite).
    expect(fs.existsSync(path.join(stateDir, 'machine', 'secrets-master.key'))).toBe(true);
  });

  it('THE INCIDENT, AT BOOT: an undecryptable store fails the boot FAST with the actionable error', () => {
    // Sabotage the master key — exactly the effect of the poisoned keychain
    const keyPath = path.join(stateDir, 'machine', 'secrets-master.key');
    const original = fs.readFileSync(keyPath, 'utf-8');
    try {
      fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
      expect(() => loadConfig(projectDir)).toThrow(
        /Secrets cannot be resolved for boot-critical config fields[\s\S]*messaging\[0\]\.config\.token/,
      );
    } finally {
      fs.writeFileSync(keyPath, original, { mode: 0o600 });
    }
    // And recovery is immediate once the right key is back:
    const cfg = loadConfig(projectDir);
    expect((cfg.messaging as Array<{ config: Record<string, unknown> }>)[0].config['token']).toBe('bot99:E2E');
  });
});
