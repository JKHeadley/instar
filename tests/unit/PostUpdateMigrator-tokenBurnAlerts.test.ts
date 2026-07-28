/**
 * Verifies PostUpdateMigrator adds the Token-Burn Alerts awareness section to
 * existing agents' CLAUDE.md on update, and that the source template emits it
 * for fresh installs.
 *
 * Background: the BurnDetector's absolute-share trigger re-alarmed for a full
 * 24h after one heavy session finished ("consumed 67% of 24h spend … Projected
 * 0 tokens"). The code fix is an activity gate (only alarm if the component is
 * spending in the last hour) plus a monitoring.burnDetection off-switch. This
 * migration closes the awareness gap so an existing agent can answer "why am I
 * getting these token alerts / how do I turn them off?" instead of guessing.
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

const MARKER = 'Token-Burn Alerts';

describe('PostUpdateMigrator — Token-Burn Alerts awareness', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-burnalerts-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-tokenBurnAlerts.test.ts:cleanup',
    });
  });

  it('adds the Token-Burn Alerts section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('Token-Burn Alerts awareness'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MARKER);
    // The off-switch the agent should offer.
    expect(after).toContain('monitoring.burnDetection.enabled: false');
    // The activity-gate explanation (the noise fix).
    expect(after).toContain('absoluteShareActivityFloorTokens');
    // The proactive trigger.
    expect(after).toContain('these token alerts are noisy');
  });

  it('is idempotent — re-running does not add a duplicate section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.errors).toEqual([]);
    expect(result2.upgraded.some(u => u.includes('Token-Burn Alerts awareness'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    const headingMatches = afterSecond.match(/## Token-Burn Alerts/g);
    expect(headingMatches?.length).toBe(1);
  });

  it('preserves existing CLAUDE.md content', () => {
    const original = '# CLAUDE.md\n\n## My Custom Section\n\nDo not delete this.\n';
    fs.writeFileSync(claudeMdPath, original);

    runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(after.startsWith(original)).toBe(true);
    expect(after.length).toBeGreaterThan(original.length);
  });

  it('skips gracefully when CLAUDE.md is missing', () => {
    expect(fs.existsSync(claudeMdPath)).toBe(false);
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('CLAUDE.md'))).toBe(true);
  });
});

describe('generateClaudeMd template includes Token-Burn Alerts section', () => {
  it('the source template emits the section so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain(MARKER);
    expect(templateSource).toContain('monitoring.burnDetection');
    expect(templateSource).toContain('absoluteShareActivityFloorTokens');
  });
});
