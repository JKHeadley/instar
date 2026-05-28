/**
 * Tests for the two mentor-retirement migrations (spec MENTOR-LIVE-READINESS
 * §Migration parity):
 *   - migrateRetireDeadMentorConfig — non-silent removal of mentor.dailySpendCapUsd
 *     (silent when default, LOUD REVIEW prefix when non-default — don't repeat the
 *     silent-dead-config bug at migration time).
 *   - migrateRetireMentorOutbox — sweep the legacy {stateDir}/mentor-outbox/ files
 *     (replaced by the a2a Telegram comms primitive).
 *
 * Both idempotent via the `_instar_migrations` marker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function buildMigrator(projectDir: string): PostUpdateMigrator {
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return new PostUpdateMigrator({
    projectDir,
    stateDir,
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function readConfig(stateDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
}

function writeConfig(stateDir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config, null, 2));
}

describe('PostUpdateMigrator.migrateRetireDeadMentorConfig', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mentor-retire-'));
    stateDir = path.join(projectDir, '.instar');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'mentor-retire test' });
  });

  it('skips silently when mentor.dailySpendCapUsd is absent', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, { mentor: { enabled: false } });
    const result: { upgraded: string[]; skipped: string[]; errors: string[] } = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateRetireDeadMentorConfig: (r: typeof result) => void }).migrateRetireDeadMentorConfig(result);
    expect(result.errors).toEqual([]);
    expect(result.skipped.some((s) => s.includes('never present'))).toBe(true);
    // Marker set so subsequent runs short-circuit.
    expect((readConfig(stateDir)._instar_migrations as string[])?.some((m) => m.startsWith('mentor-dailySpendCapUsd-retire-v1'))).toBe(true);
  });

  it('SILENTLY deletes the default value (0.5) — no LOUD warning when the user never changed it', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, { mentor: { enabled: false, dailySpendCapUsd: 0.5 } });
    const result: { upgraded: string[]; skipped: string[]; errors: string[] } = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateRetireDeadMentorConfig: (r: typeof result) => void }).migrateRetireDeadMentorConfig(result);
    const post = readConfig(stateDir);
    expect((post.mentor as Record<string, unknown>).dailySpendCapUsd).toBeUndefined();
    expect(result.upgraded[0]).toMatch(/dailySpendCapUsd retired/);
    expect(result.upgraded[0]).not.toMatch(/REVIEW:/); // default value → no LOUD prefix
  });

  it('LOUDLY surfaces a non-default value with REVIEW: prefix (don\'t repeat the silent-dead-config bug)', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, { mentor: { enabled: false, dailySpendCapUsd: 5.0 } });
    const result: { upgraded: string[]; skipped: string[]; errors: string[] } = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateRetireDeadMentorConfig: (r: typeof result) => void }).migrateRetireDeadMentorConfig(result);
    const post = readConfig(stateDir);
    expect((post.mentor as Record<string, unknown>).dailySpendCapUsd).toBeUndefined();
    expect(result.upgraded[0]).toMatch(/^REVIEW:.*dailySpendCapUsd=5/);
    expect(result.upgraded[0]).toMatch(/decorative.*never enforced/);
    expect(result.upgraded[0]).toMatch(/subscription/);
  });

  it('IDEMPOTENT: a second run is a no-op', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, { mentor: { dailySpendCapUsd: 0.5 } });
    const r1: { upgraded: string[]; skipped: string[]; errors: string[] } = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateRetireDeadMentorConfig: (r: typeof r1) => void }).migrateRetireDeadMentorConfig(r1);
    expect(r1.upgraded.length).toBe(1);

    const r2: { upgraded: string[]; skipped: string[]; errors: string[] } = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateRetireDeadMentorConfig: (r: typeof r2) => void }).migrateRetireDeadMentorConfig(r2);
    expect(r2.upgraded).toEqual([]);
    expect(r2.skipped.some((s) => s.includes('already migrated'))).toBe(true);
  });
});

describe('PostUpdateMigrator.migrateRetireMentorOutbox', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mentor-outbox-'));
    stateDir = path.join(projectDir, '.instar');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'mentor-outbox test' });
  });

  it('removes the legacy mentor-outbox directory + records the file count', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, {});
    const outboxDir = path.join(stateDir, 'mentor-outbox');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'codex-cli.jsonl'), '{}\n{}\n');
    fs.writeFileSync(path.join(outboxDir, 'other.jsonl'), '{}\n');

    const result: { upgraded: string[]; skipped: string[]; errors: string[] } = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateRetireMentorOutbox: (r: typeof result) => void }).migrateRetireMentorOutbox(result);
    expect(fs.existsSync(outboxDir)).toBe(false);
    expect(result.upgraded[0]).toMatch(/mentor-outbox directory retired/);
    expect(result.upgraded[0]).toMatch(/removed 2 file/);
    expect(result.errors).toEqual([]);
  });

  it('IDEMPOTENT: subsequent runs are no-ops (marker set)', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, {});
    fs.mkdirSync(path.join(stateDir, 'mentor-outbox'), { recursive: true });
    const r1: { upgraded: string[]; skipped: string[]; errors: string[] } = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateRetireMentorOutbox: (r: typeof r1) => void }).migrateRetireMentorOutbox(r1);

    const r2: { upgraded: string[]; skipped: string[]; errors: string[] } = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateRetireMentorOutbox: (r: typeof r2) => void }).migrateRetireMentorOutbox(r2);
    expect(r2.upgraded).toEqual([]);
    expect(r2.skipped.some((s) => s.includes('already migrated'))).toBe(true);
  });

  it('handles directory-absent gracefully (marker set, no error)', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, {});
    expect(fs.existsSync(path.join(stateDir, 'mentor-outbox'))).toBe(false);
    const result: { upgraded: string[]; skipped: string[]; errors: string[] } = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateRetireMentorOutbox: (r: typeof result) => void }).migrateRetireMentorOutbox(result);
    expect(result.errors).toEqual([]);
    expect(result.skipped.some((s) => s.includes('not present'))).toBe(true);
  });
});
