// safe-git-allow: test file — fs.rmSync via _framework cleanup is per-test only.
/**
 * Real-world-state scenario: agent boots correctly when authToken has been
 * externalized to the encrypted secret store.
 *
 * This is the regression backstop for the post-mortem's pattern #1
 * ("tested on fresh state, not real-world state") applied to the #542
 * incident class — `loadConfig()` (the canonical boot-time config read)
 * MUST return the real `authToken` string when the on-disk config holds
 * the `{ "secret": true }` placeholder, OR every downstream consumer that
 * doesn't go through `loadConfig()` will silently 403.
 *
 * Why this test exists
 * --------------------
 * PR #542's existing test suite covers the SHELL HOOK and SCRIPT side of
 * the fix (env-first + string-type guard). But the IN-PROCESS Node side
 * (server, sessionManager, scheduler, etc.) trusts `loadConfig()` to
 * merge `mergeConfigWithSecrets` transparently. None of the existing
 * unit tests exercise loadConfig against the externalized shape — they
 * use a fresh config with the plaintext authToken. So a regression in
 * the merge layer would not have been caught.
 *
 * This test fills that gap: it materializes the externalized shape on
 * disk, runs loadConfig (the actual production read path), and asserts
 * the merge produces the real string.
 *
 * Lever-B framework
 * -----------------
 * Lives in `tests/real-world-state/` — a new test category for boot-time
 * scenarios against real-shaped state. PR-tier (runs every CI shard;
 * fixture is tiny). The nightly tier (multi-100MB DBs, environment-
 * specific shapes) is gated on `INSTAR_REAL_WORLD_BIG=1`. See
 * `_framework.ts` for the rationale.
 */

import { it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { describeAtTier, makeAgentFixture } from './_framework.js';
import type { AgentFixtureCtx } from './_framework.js';
import { migrateSecrets } from '../../src/core/SecretMigrator.js';
import { loadConfig } from '../../src/core/Config.js';
import { SecretStore } from '../../src/core/SecretStore.js';

const SECRET = 'sk-real-secret-token-only-here-not-on-disk-after-migration';

describeAtTier('pr', 'externalized-config-boot — loadConfig() merges the real authToken', () => {
  let fx: AgentFixtureCtx;

  afterEach(() => {
    if (fx) fx.cleanup();
  });

  function seedExternalizedAgent(): { configPath: string } {
    fx = makeAgentFixture();

    // Write a config with the REAL authToken on disk.
    const configPath = path.join(fx.stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      projectName: 'rws-externalized-config-boot',
      projectDir: fx.projectDir,
      stateDir: fx.stateDir,
      port: 4242,
      authToken: SECRET,
      sessions: { claudePath: 'claude' },
      messaging: [],
    }, null, 2));

    // Run the SAME migration the multi-machine pairing path runs.
    const result = migrateSecrets(configPath, fx.stateDir);
    expect(result.extracted, 'pairing migration must extract ≥1 secret').toBeGreaterThan(0);
    expect(result.fields, 'authToken must be among extracted secrets').toContain('authToken');

    // Belt-and-suspenders: disk MUST hold the placeholder, NOT the secret.
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(onDisk.authToken).toEqual({ secret: true });

    // And the SecretStore MUST hold the real value.
    const store = new SecretStore({ stateDir: fx.stateDir, forceFileKey: true });
    expect(store.get('authToken')).toBe(SECRET);

    return { configPath };
  }

  it('disk shape after pairing matches the expected externalized layout', () => {
    seedExternalizedAgent();
    // (assertions inside the seeder)
  });

  it('loadConfig() returns the MERGED real authToken string, not the placeholder', () => {
    seedExternalizedAgent();
    const merged = loadConfig(fx.projectDir);
    expect(merged.authToken, 'merged authToken must be the real secret string').toBe(SECRET);
    // Defensive: confirm the merged value is a string, not an object.
    expect(typeof merged.authToken).toBe('string');
  });

  it('loadConfig() never leaks the placeholder shape (regression check for #542)', () => {
    seedExternalizedAgent();
    const merged = loadConfig(fx.projectDir);
    // The whole point of the merge: never return the placeholder.
    expect(merged.authToken).not.toEqual({ secret: true });
    // And no toString-coerced form thereof. We avoid `not.toContain('secret')`
    // because the test SECRET string itself contains the literal word; instead
    // check the specific failure shapes the bug produced (Object coercion +
    // JSON form of the placeholder).
    const coerced = String(merged.authToken);
    expect(coerced).not.toContain('[object Object]');
    expect(coerced).not.toBe(JSON.stringify({ secret: true }));
    expect(coerced).not.toBe('{secret:true}');
    expect(coerced).not.toBe('{\'secret\': True}'); // Python repr — the shell-side incident shape
  });

  it('other externalized fields are also merged (telegram token + chatId, dashboardPin, tunnel.token)', () => {
    // Full-shape scenario — agent with telegram + tunnel + dashboard configured,
    // all secrets externalized. Tests that mergeConfigWithSecrets reconstructs
    // every known secret field, not just authToken.
    fx = makeAgentFixture();
    const configPath = path.join(fx.stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      projectName: 'rws-externalized-config-boot-full',
      projectDir: fx.projectDir,
      stateDir: fx.stateDir,
      port: 4242,
      authToken: 'auth-real',
      dashboardPin: '123456',
      tunnel: { enabled: true, token: 'tunnel-real' },
      messaging: [{
        type: 'telegram',
        enabled: true,
        config: { token: 'bot999:REAL', chatId: '-100999', pollIntervalMs: 3000 },
      }],
      sessions: { claudePath: 'claude' },
    }, null, 2));

    migrateSecrets(configPath, fx.stateDir);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(onDisk.authToken, 'authToken externalized').toEqual({ secret: true });
    expect(onDisk.dashboardPin, 'dashboardPin externalized').toEqual({ secret: true });
    expect(onDisk.tunnel.token, 'tunnel.token externalized').toEqual({ secret: true });
    expect(onDisk.messaging[0].config.token, 'telegram token externalized').toEqual({ secret: true });
    expect(onDisk.messaging[0].config.chatId, 'telegram chatId externalized').toEqual({ secret: true });

    // loadConfig must merge ALL of them back.
    const merged = loadConfig(fx.projectDir);
    expect(merged.authToken).toBe('auth-real');
    expect(merged.dashboardPin).toBe('123456');
    expect(merged.tunnel?.token).toBe('tunnel-real');
    const telegram = merged.messaging?.[0] as { config: { token: string; chatId: string } } | undefined;
    expect(telegram?.config.token).toBe('bot999:REAL');
    expect(telegram?.config.chatId).toBe('-100999');
  });

  it('idempotent: re-running migrateSecrets on the externalized config is a no-op', () => {
    seedExternalizedAgent();
    // Second pairing run — must NOT alter the disk shape or the stored secret.
    const result2 = migrateSecrets(path.join(fx.stateDir, 'config.json'), fx.stateDir);
    expect(result2.extracted, 'no new extractions on the second run').toBe(0);

    const store = new SecretStore({ stateDir: fx.stateDir, forceFileKey: true });
    expect(store.get('authToken')).toBe(SECRET);

    const merged = loadConfig(fx.projectDir);
    expect(merged.authToken).toBe(SECRET);
  });
});
