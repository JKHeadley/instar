/**
 * Unit tests — PostUpdateMigrator.migrateProviderPortability.
 *
 * Idempotent migration entry for v1.0.0 provider-portability. Asserts:
 *   1. First run: writes the migration marker to _instar_migrations.
 *   2. Re-runs: no-op (marker already present).
 *   3. Missing config.json: skipped gracefully.
 *   4. Surfaces detected Codex CLI path in the result message.
 *   5. No other config field is mutated (no frameworkBinaryPaths rewrite,
 *      no topicFrameworks rewrite, no _instar_noMigrate violation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PostUpdateMigrator.migrateProviderPortability', () => {
  let tmpStateDir: string;
  let tmpProjectDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mig-proj-'));
    tmpStateDir = path.join(tmpProjectDir, '.instar');
    fs.mkdirSync(tmpStateDir, { recursive: true });
    configPath = path.join(tmpStateDir, 'config.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpProjectDir, { recursive: true, force: true, operation: 'tests/unit/migrateProviderPortability.test.ts' });
  });

  function runMigrator() {
    return new PostUpdateMigrator({
      stateDir: tmpStateDir,
      projectDir: tmpProjectDir,
      version: '1.0.0',
    }).migrate();
  }

  it('skips gracefully when config.json missing', () => {
    const result = runMigrator();
    expect(result.skipped.some(s => s.includes('provider-portability'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('first run: writes the v1.0.0 migration marker', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      port: 4242, authToken: 'x', agentType: 'managed-project',
    }, null, 2));
    const result = runMigrator();
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written._instar_migrations).toBeDefined();
    expect((written._instar_migrations as string[]).some(m =>
      m.startsWith('provider-portability-v1.0.0'),
    )).toBe(true);
    expect(result.upgraded.some(u => u.includes('provider-portability: v1.0.0 migration recorded'))).toBe(true);
  });

  it('re-runs are no-op when marker already present', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      port: 4242, authToken: 'x', agentType: 'managed-project',
      _instar_migrations: ['provider-portability-v1.0.0-2026-05-18T00:00:00Z'],
    }, null, 2));
    const result = runMigrator();
    expect(result.skipped.some(s => s.includes('provider-portability: already migrated'))).toBe(true);
    expect(result.upgraded.some(u => u.includes('provider-portability: v1.0.0 migration recorded'))).toBe(false);
  });

  it('surfaces Codex CLI detection result in the upgrade message', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      port: 4242, authToken: 'x', agentType: 'managed-project',
    }, null, 2));
    const result = runMigrator();
    const msg = result.upgraded.find(u => u.startsWith('provider-portability'));
    expect(msg).toBeDefined();
    // Either "Codex CLI detected" or "Codex CLI not detected" — both
    // count as successful surfacing.
    expect(msg!.includes('Codex CLI')).toBe(true);
  });

  it('does NOT mutate frameworkBinaryPaths or topicFrameworks fields', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      port: 4242, authToken: 'x', agentType: 'managed-project',
      topicFrameworks: { '9984': 'claude-code' },
    }, null, 2));
    runMigrator();
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.topicFrameworks).toEqual({ '9984': 'claude-code' });
    expect(written.frameworkBinaryPaths).toBeUndefined(); // populated at runtime, not migration
  });
});
