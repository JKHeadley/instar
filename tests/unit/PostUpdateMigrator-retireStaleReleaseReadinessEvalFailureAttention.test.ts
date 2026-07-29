/**
 * Unit tests for
 * PostUpdateMigrator.migrateRetireStaleReleaseReadinessEvalFailureAttention.
 *
 * Background: from v1.3.43 down, ReleaseReadinessSentinel posted a per-stage
 * Attention item (and therefore a per-stage Telegram topic) every time the
 * watchdog's own fetch / analyzer / tick stage broke. That violated the
 * sentinel-trio standard (post-2026-05-22 topic-spam fix). The code-level fix
 * demotes those emissions to audit-only by default; this migration cleans up
 * stragglers already on-disk so they don't keep haunting existing agents'
 * topic lists after update.
 *
 * Covers: skips when attention-items.json absent / unreadable / empty; drops
 * only ids beginning with `release-readiness-eval-failure-` (leaves the
 * legitimate `release-readiness-<sha>` user-actionable items alone); atomic
 * write; idempotency.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface MigrationResult {
  upgraded: string[];
  errors: string[];
  skipped: string[];
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-retire-rr-eval-failure-'));
}

function cleanup(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-retireStaleReleaseReadinessEvalFailureAttention.test.ts:cleanup' });
}

function buildMigrator(projectDir: string) {
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  const migrator = new PostUpdateMigrator({
    projectDir,
    stateDir,
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
  const run = (migrator as unknown as {
    migrateRetireStaleReleaseReadinessEvalFailureAttention: (result: MigrationResult) => void;
  }).migrateRetireStaleReleaseReadinessEvalFailureAttention.bind(migrator);
  return { stateDir, run };
}

function writeAttention(stateDir: string, items: Array<Record<string, unknown>>): string {
  const p = path.join(stateDir, 'state', 'attention-items.json');
  fs.writeFileSync(p, JSON.stringify({ items }, null, 2));
  return p;
}

function readAttention(stateDir: string): { items: Array<Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'attention-items.json'), 'utf-8'));
}

describe('PostUpdateMigrator.migrateRetireStaleReleaseReadinessEvalFailureAttention', () => {
  let projectDir: string;
  beforeEach(() => { projectDir = createTempDir(); });
  afterEach(() => cleanup(projectDir));

  it('skips gracefully when attention-items.json does not exist', () => {
    const { run } = buildMigrator(projectDir);
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);
    expect(result.errors).toEqual([]);
    expect(result.skipped.some((s) => s.includes('no attention-items.json'))).toBe(true);
    expect(result.upgraded).toEqual([]);
  });

  it('skips when the items array is empty', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    writeAttention(stateDir, []);
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);
    expect(result.errors).toEqual([]);
    expect(result.skipped.some((s) => s.includes('empty attention items'))).toBe(true);
  });

  it('skips when no eval-failure items exist (idempotent on a clean install)', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    writeAttention(stateDir, [
      { id: 'release-readiness-abcdef123456', status: 'OPEN', title: 'Release blocked — unreleased work is piling up' },
      { id: 'attn-unrelated-1', status: 'OPEN', title: 'Some other item' },
    ]);
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);
    expect(result.upgraded).toEqual([]);
    expect(result.skipped.some((s) => s.includes('none on disk'))).toBe(true);
    // Untouched.
    const after = readAttention(stateDir);
    expect(after.items).toHaveLength(2);
  });

  it('drops only `release-readiness-eval-failure-*` items and preserves the rest', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    writeAttention(stateDir, [
      { id: 'release-readiness-eval-failure-fetch', status: 'DONE', topicId: 14496, title: 'Release-readiness check could not evaluate' },
      { id: 'release-readiness-eval-failure-analyzer', status: 'DONE', topicId: 14618, title: 'Release-readiness check could not evaluate' },
      { id: 'release-readiness-abcdef123456', status: 'OPEN', title: 'Release blocked — unreleased work is piling up' },
      { id: 'attn-unrelated-1', status: 'OPEN', title: 'Some other item' },
    ]);

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((m) => m.includes('dropped 2 stale item(s)'))).toBe(true);

    const after = readAttention(stateDir);
    expect(after.items.map((i) => i.id)).toEqual([
      'release-readiness-abcdef123456',
      'attn-unrelated-1',
    ]);
  });

  it('is fully idempotent — a second run reports none on disk and is a no-op', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    writeAttention(stateDir, [
      { id: 'release-readiness-eval-failure-fetch', status: 'DONE', topicId: 14496 },
      { id: 'attn-unrelated-1', status: 'OPEN' },
    ]);

    const first: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(first);
    expect(first.upgraded.some((m) => m.includes('dropped 1 stale item(s)'))).toBe(true);

    const second: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(second);
    expect(second.upgraded).toEqual([]);
    expect(second.skipped.some((s) => s.includes('none on disk'))).toBe(true);
  });

  it('tolerates malformed entries (missing id field) without throwing', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    writeAttention(stateDir, [
      { id: 'release-readiness-eval-failure-tick', status: 'OPEN' },
      { /* no id */ status: 'OPEN', title: 'broken entry' },
      { id: 42 as unknown as string, status: 'OPEN', title: 'wrong type' },
      { id: 'attn-keep', status: 'OPEN' },
    ]);

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((m) => m.includes('dropped 1 stale item(s)'))).toBe(true);

    const after = readAttention(stateDir);
    // The malformed entries are PRESERVED — the migration only targets the
    // matched eval-failure ids, never silently rewrites unrelated items.
    expect(after.items).toHaveLength(3);
    expect(after.items.find((i) => i.id === 'attn-keep')).toBeDefined();
  });

  it('records a read error if attention-items.json is unparseable JSON', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    fs.writeFileSync(path.join(stateDir, 'state', 'attention-items.json'), '{ not json');
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('retire-stale-release-readiness-eval-failure-attention read');
  });
});
