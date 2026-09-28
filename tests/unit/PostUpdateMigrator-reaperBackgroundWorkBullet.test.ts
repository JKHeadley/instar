/**
 * The SessionReaper background-work bullet reaches EXISTING agents (Migration
 * Parity): an agent whose CLAUDE.md already carries the SessionReaper bullets
 * — installed before this bullet existed — gets it through migrateClaudeMd,
 * idempotently, and its revival wording never promises a guaranteed revival.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { REAPER_BACKGROUND_WORK_MARKER, REAPER_BACKGROUND_WORK_BULLET } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}

const OLD_REAPER_BULLETS = [
  '**SessionReaper** — Pressure-aware cleanup of idle-but-alive sessions.',
  '- **CPU-aware active-process keep** (`cpuAwareActiveProcessKeep`, dark by default): …',
  '- **Busy-orphan detection** (`busyOrphanDetection`, OBSERVE-ONLY): …',
].join('\n');

const count = (s: string) => s.split(REAPER_BACKGROUND_WORK_MARKER).length - 1;

describe('PostUpdateMigrator — SessionReaper background-work bullet', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-reaper-bullet-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-reaperBackgroundWorkBullet.test.ts:cleanup' }));

  it('phrases revival as eligible, subject to the resume queue gates and cap', () => {
    expect(REAPER_BACKGROUND_WORK_BULLET).toContain("eligible for revival, subject to the resume queue's existing gates and cap");
    expect(REAPER_BACKGROUND_WORK_BULLET).not.toMatch(/revives it/);
  });

  it('inserts the bullet before the busy-orphan bullet of an existing SessionReaper list', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + OLD_REAPER_BULLETS + '\n');
    const r = run(projectDir);
    const after = fs.readFileSync(claudeMd, 'utf8');
    expect(r.upgraded).toContain('CLAUDE.md: added SessionReaper background-work bullet');
    expect(count(after)).toBe(1);
    expect(after.indexOf(REAPER_BACKGROUND_WORK_MARKER)).toBeLessThan(after.indexOf('- **Busy-orphan detection**'));
    expect(after.indexOf(REAPER_BACKGROUND_WORK_MARKER)).toBeGreaterThan(after.indexOf('- **CPU-aware active-process keep**'));
  });

  it('appends the bullet when the anchor is absent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n');
    run(projectDir);
    expect(count(fs.readFileSync(claudeMd, 'utf8'))).toBe(1);
  });

  it('is idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + OLD_REAPER_BULLETS + '\n');
    run(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    const r2 = run(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(r2.skipped).toContain('CLAUDE.md: SessionReaper background-work bullet already present');
  });
});
