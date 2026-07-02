/**
 * Migration Parity (G3 §5/§6) — existing agents learn about the dark-but-load-bearing
 * classification + the accept-fallback route ONLY through migrateClaudeMd. An agent
 * that already carries the base Guard Posture section still gets the G3 addendum.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}
function runClaudeMdMigration(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Dark-but-Load-Bearing (G3) CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-g3-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'PostUpdateMigrator-guardLoadBearingSection cleanup' });
  });

  it('adds the G3 section (with the accept route + loadBearingGap vocabulary) when absent', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('Dark-but-Load-Bearing Guards (G3)'))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('loadBearingGap');
    expect(after).toContain('/guards/<key>/accept-fallback');
    expect(after).toContain('A Dark Feature Guards Nothing');
  });

  it('adds it even to an agent that ALREADY has the base Guard Posture section', () => {
    // Seed a CLAUDE.md that already has the base section (so its content-sniff skips)
    // but NOT the G3 addendum — the exact state of a deployed agent.
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\n### Guard Posture — which safety systems are genuinely on (`GET /guards`)\n\nbase section.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.skipped.some((s) => s.includes('Guard Posture (/guards) capability section already present'))).toBe(true);
    expect(result.upgraded.some((u) => u.includes('Dark-but-Load-Bearing Guards (G3)'))).toBe(true);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toContain('loadBearingGap');
  });

  it('is idempotent — a second run skips, content unchanged', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const second = runClaudeMdMigration(newMigrator(projectDir));
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe(afterFirst);
    expect(second.upgraded.some((u) => u.includes('Dark-but-Load-Bearing Guards (G3)'))).toBe(false);
    expect(second.skipped.some((s) => s.includes('Dark-but-Load-Bearing Guards (G3)'))).toBe(true);
  });
});
