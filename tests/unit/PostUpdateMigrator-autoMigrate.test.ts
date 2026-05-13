/**
 * Phase 5 — PostUpdateMigrator auto-migrate path for legacy jobs.json.
 *
 * Asserts the auto-migrate step:
 *   - SKIP when .migration-complete.json exists
 *   - SKIP when .migration-abandoned.json exists
 *   - SKIP when jobs.json is absent
 *   - Auto-runs jobsMigrate with --default-action=fork when none of the
 *     above sentinels are present
 *   - Honors the Seamless Migration Guarantee invariants 5 and 7
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PostUpdateMigrator auto-migrate-legacy-jobs.json (Phase 5)', () => {
  let workspace: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pum-am-'));
    projectDir = path.join(workspace, 'project');
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'PostUpdateMigrator-autoMigrate.test cleanup' });
  });

  function makeMigrator() {
    return new PostUpdateMigrator({
      projectDir,
      stateDir,
      port: 4042,
      hasTelegram: false,
      projectName: 'test-agent',
    });
  }

  function writeJobsJson(entries: any[]) {
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify(entries, null, 2), 'utf-8');
  }

  it('skips when jobs.json is absent (fresh install)', () => {
    const m = makeMigrator();
    // Run only the auto-migrate path via a focused proxy.
    const result = { upgraded: [], skipped: [], errors: [] };
    (m as any).autoMigrateLegacyJobsJson(result);
    expect(result.upgraded).toEqual([]);
    expect(result.errors).toEqual([]);
    // No skipped entry either, since absence of jobs.json is a non-event.
    expect(result.skipped.filter((s: string) => s.includes('legacy jobs.json'))).toEqual([]);
  });

  it('skips when .migration-complete.json exists (operator confirmed)', () => {
    writeJobsJson([{ slug: 'a', execute: { type: 'prompt', value: 'x' }, schedule: '* * * * *' }]);
    fs.mkdirSync(path.join(stateDir, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'jobs', '.migration-complete.json'), '{"confirmedAt":"2026-01-01"}');

    const m = makeMigrator();
    const result = { upgraded: [], skipped: [], errors: [] };
    (m as any).autoMigrateLegacyJobsJson(result);

    expect(result.skipped.some((s: string) => s.includes('operator-confirmed'))).toBe(true);
    // No schedule manifest written.
    expect(fs.existsSync(path.join(stateDir, 'jobs', 'schedule'))).toBe(false);
  });

  it('skips when .migration-abandoned.json exists (operator rolled back)', () => {
    writeJobsJson([{ slug: 'a', execute: { type: 'prompt', value: 'x' }, schedule: '* * * * *' }]);
    fs.mkdirSync(path.join(stateDir, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'jobs', '.migration-abandoned.json'), '{"abandonedAt":"2026-01-01"}');

    const m = makeMigrator();
    const result = { upgraded: [], skipped: [], errors: [] };
    (m as any).autoMigrateLegacyJobsJson(result);

    expect(result.skipped.some((s: string) => s.includes('explicitly abandoned'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'jobs', 'schedule'))).toBe(false);
  });

  it('runs jobsMigrate with --default-action=fork when no sentinels present', () => {
    writeJobsJson([
      {
        slug: 'my-user-job',
        name: 'My User Job',
        description: 'd',
        schedule: '0 9 * * *',
        priority: 'low',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'Do thing\n' },
      },
    ]);

    const m = makeMigrator();
    const result = { upgraded: [], skipped: [], errors: [] };
    (m as any).autoMigrateLegacyJobsJson(result);

    // The auto-runner produces an upgraded message.
    expect(result.upgraded.some((s: string) => s.includes('auto-ran on update'))).toBe(true);
    // Schedule manifest was written.
    expect(fs.existsSync(path.join(stateDir, 'jobs', 'schedule', 'my-user-job.json'))).toBe(true);
    // Backup was written.
    const stateContents = fs.readdirSync(stateDir);
    expect(stateContents.some((f) => f.startsWith('jobs.json.pre-migrate-'))).toBe(true);
  });

  it('does NOT auto-write .migration-complete.json (only Dashboard does)', () => {
    writeJobsJson([{ slug: 'a', execute: { type: 'prompt', value: 'x' }, schedule: '* * * * *' }]);

    const m = makeMigrator();
    const result = { upgraded: [], skipped: [], errors: [] };
    (m as any).autoMigrateLegacyJobsJson(result);

    expect(fs.existsSync(path.join(stateDir, 'jobs', '.migration-complete.json'))).toBe(false);
  });
});
