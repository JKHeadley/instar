/**
 * Verifies PostUpdateMigrator patches existing agents' CLAUDE.md with the
 * AUP-rejection wedge note (second wedge-signature family) + the API
 * fresh-respawn lever.
 *
 * 2026-06-05 EXO 3.0 incident: a session whose transcript accumulated
 * red-team test payloads got EVERY reply rejected by the API's Usage Policy
 * classifier — permanently dead, invisible to the (then thinking-block-only)
 * ContextWedgeSentinel, and recoverable only by hand-editing
 * topic-resume-map.json because /sessions/refresh did not expose fresh:true.
 *
 * Migration Parity Standard: agents that already have the Stuck-Context
 * Recovery section (installed by the original migration) only learn about
 * the second signature + the API lever through this patch.
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

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — AUP-rejection wedge CLAUDE.md note', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-aupwedge-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-aupWedgeNote.test.ts:cleanup',
    });
  });

  it('fresh section install includes the AUP note (new agents get both families)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Stuck-Context Recovery');
    expect(after).toContain('AUP-rejection wedge');
    expect(after).toContain('"fresh":true');
  });

  it('patches agents that already have the Stuck-Context section but not the AUP note', () => {
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n## Stuck-Context Recovery (thinking-block wedge)\n\nThe ContextWedgeSentinel (4th member of the silently-stopped family) detects ...\n',
    );

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('AUP-rejection wedge'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('AUP-rejection wedge');
    expect(after).toContain('POST /sessions/refresh');
    // The original section is preserved, not duplicated.
    expect(after.match(/Stuck-Context Recovery/g)!.length).toBe(1);
  });

  it('is idempotent — a second run skips, content unchanged', () => {
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n## Stuck-Context Recovery (thinking-block wedge)\n\nThe ContextWedgeSentinel detects ...\n',
    );

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some(u => u.includes('AUP-rejection wedge'))).toBe(false);
  });
});
