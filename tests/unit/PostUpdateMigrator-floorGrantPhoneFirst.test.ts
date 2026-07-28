/**
 * Verifies PostUpdateMigrator patches existing agents' CLAUDE.md with the
 * phone-first floor-grant guidance (Mobile-Complete Operator Actions,
 * instar#1080).
 *
 * 2026-06-12 lesson: when the operator needed a floor grant (scenario 8/8 of
 * the Slack live test), the agent's only awareness was the API route, so it
 * handed the operator a terminal command — a laptop-only step in an operator
 * loop. Agents that already carry the Coordination Mandate section only learn
 * to point operators at the Mandates-tab grant form through this patch.
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

const ANCHOR_LINE = 'point them at the dashboard **Mandates tab** (issue/revoke forms + the decision audit live there).';

describe('PostUpdateMigrator — phone-first floor-grant CLAUDE.md guidance', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-grantphone-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-floorGrantPhoneFirst.test.ts:cleanup',
    });
  });

  it('fresh CLAUDE.md gains the mandate section WITH the phone-first grant bullet', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('/mandate/evaluate');
    expect(after).toContain('User floor-action grants are phone-first');
    expect(after).toContain('NEVER a terminal command');
  });

  it('patches agents that already carry the mandate section, INSIDE the section at its anchor', () => {
    fs.writeFileSync(
      claudeMdPath,
      `# CLAUDE.md\n\n**Coordination Mandate** — …\n- check it: POST /mandate/evaluate …\n- **You cannot issue or revoke mandates.** … ${ANCHOR_LINE}\n- Every evaluation is audited.\n`,
    );

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('phone-first floor-grant'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    // Inserted directly after the anchor line, inside the section.
    expect(after).toContain(ANCHOR_LINE + '\n- **User floor-action grants are phone-first.**');
    // The audited bullet still follows — the section was edited, not clobbered.
    expect(after.indexOf('User floor-action grants are phone-first')).toBeLessThan(after.indexOf('Every evaluation is audited'));
  });

  it('still gains the guidance when the anchor was hand-edited away (appended, not lost)', () => {
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n**Coordination Mandate** — …\n- check it: POST /mandate/evaluate …\n- my own rewritten PIN bullet.\n',
    );

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('User floor-action grants are phone-first');
  });

  it('is idempotent — a second run changes nothing', () => {
    fs.writeFileSync(
      claudeMdPath,
      `# CLAUDE.md\n\n**Coordination Mandate** — …\n- check it: POST /mandate/evaluate …\n- … ${ANCHOR_LINE}\n`,
    );

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some(u => u.includes('phone-first floor-grant'))).toBe(false);
    expect(afterFirst.match(/User floor-action grants are phone-first/g)!.length).toBe(1);
  });
});
