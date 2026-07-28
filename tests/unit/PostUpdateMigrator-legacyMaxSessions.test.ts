/**
 * Verifies PostUpdateMigrator canonicalizes the legacy top-level
 * `maxSessions` key into `sessions.maxSessions` (codex-instar audit
 * Item 10).
 *
 * Older agent configs used a top-level `maxSessions` field. The
 * canonical location is `sessions.maxSessions`. Some agents (echo as of
 * 2026-05-22) carry BOTH keys, with divergent values. The legacy key
 * is dead in code today (Item 2's fallback chain reads canonical first),
 * but the duplication is still misleading. This migration cleans it up
 * idempotently.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateLegacyMaxSessions(r: MigrationResult): void }).migrateLegacyMaxSessions(result);
  return result;
}

describe('PostUpdateMigrator — legacy maxSessions canonicalization', () => {
  let projectDir: string;
  let configPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-legacy-maxsessions-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    configPath = path.join(projectDir, '.instar', 'config.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-legacyMaxSessions.test.ts:cleanup',
    });
  });

  it('promotes legacy maxSessions to sessions.maxSessions when only legacy exists', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ maxSessions: 12, projectName: 'agent-with-legacy-only' }),
    );

    const result = runMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('promoted legacy maxSessions=12'))).toBe(true);

    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.maxSessions).toBeUndefined();
    expect(after.sessions?.maxSessions).toBe(12);
  });

  it('promotes legacy into existing sessions block without dropping other fields', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        maxSessions: 8,
        sessions: { tmuxPath: '/opt/homebrew/bin/tmux', protectedSessions: ['agent-server'] },
      }),
    );

    const result = runMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.maxSessions).toBeUndefined();
    expect(after.sessions.maxSessions).toBe(8);
    expect(after.sessions.tmuxPath).toBe('/opt/homebrew/bin/tmux');
    expect(after.sessions.protectedSessions).toEqual(['agent-server']);
  });

  it('removes legacy when canonical exists and matches', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ maxSessions: 10, sessions: { maxSessions: 10 } }),
    );

    const result = runMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('duplicate legacy maxSessions=10'))).toBe(true);

    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.maxSessions).toBeUndefined();
    expect(after.sessions.maxSessions).toBe(10);
  });

  it('removes legacy when canonical exists with a different value (canonical wins)', () => {
    // The exact shape codex-instar audit Item 10 cares about: echo had
    // maxSessions=10 AND sessions.maxSessions=30. Canonical is authoritative;
    // legacy is treated as stale.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ maxSessions: 10, sessions: { maxSessions: 30 } }),
    );

    const result = runMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('stale legacy maxSessions=10'))).toBe(true);
    expect(result.upgraded.some(u => u.includes('canonical sessions.maxSessions=30 retained'))).toBe(true);

    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.maxSessions).toBeUndefined();
    expect(after.sessions.maxSessions).toBe(30);
  });

  it('skips when only canonical exists (no-op)', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ sessions: { maxSessions: 5 } }),
    );

    const result = runMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded).toEqual([]);
    expect(result.skipped.some(s => s.includes('no legacy key'))).toBe(true);

    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.sessions.maxSessions).toBe(5);
    expect(after.maxSessions).toBeUndefined();
  });

  it('skips when neither key exists', () => {
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'bare' }));

    const result = runMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded).toEqual([]);
    expect(result.skipped.some(s => s.includes('no legacy key'))).toBe(true);
  });

  it('is idempotent — re-running after migration is a no-op', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ maxSessions: 7 }),
    );

    runMigration(newMigrator(projectDir));
    const second = runMigration(newMigrator(projectDir));

    expect(second.errors).toEqual([]);
    expect(second.upgraded).toEqual([]);
    expect(second.skipped.some(s => s.includes('no legacy key'))).toBe(true);
  });

  it('skips gracefully when config.json is missing', () => {
    expect(fs.existsSync(configPath)).toBe(false);

    const result = runMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('config.json not found'))).toBe(true);
  });

  it('records an audit entry in security.jsonl', () => {
    fs.writeFileSync(configPath, JSON.stringify({ maxSessions: 4 }));

    runMigration(newMigrator(projectDir));

    const securityLogPath = path.join(projectDir, '.instar', 'security.jsonl');
    expect(fs.existsSync(securityLogPath)).toBe(true);
    const lines = fs.readFileSync(securityLogPath, 'utf-8').trim().split('\n').filter(Boolean);
    const matching = lines.find(l => l.includes('config-migration-legacy-maxsessions'));
    expect(matching).toBeDefined();
    const entry = JSON.parse(matching!);
    expect(entry.event).toBe('config-migration-legacy-maxsessions');
    expect(entry.source).toBe('PostUpdateMigrator.migrateLegacyMaxSessions');
  });
});
