/**
 * Verifies PostUpdateMigrator adds the apprenticeship layer-balance
 * (keystoneBalance) awareness line to existing agents' CLAUDE.md (2026-06-06
 * mentor/mentee balance signal — Migration Parity + Agent Awareness Standards).
 *
 * An agent that doesn't know to CHECK keystoneBalance can't notice its mentee
 * layer starving — so deployed agents need the line, not just new ones.
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

const PROACTIVE_ANCHOR = '- **When to use** (PROACTIVE): when starting or closing a mentorship/apprenticeship instance, drive it through the registry + transitions so the retro-harvest is reviewed before the next instance starts and the lessons are captured before this one closes — never track the lifecycle by memory.';

describe('PostUpdateMigrator — apprenticeship layer-balance awareness', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-balance-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-layerBalance.test.ts:cleanup' });
  });

  it('adds the keystoneBalance line to an agent that already has the section', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n**Apprenticeship Program**\n\nThe standing program.\n${PROACTIVE_ANCHOR}\n`);
    const result = runClaudeMdMigration(newMigrator(projectDir));

    const content = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content).toContain('keystoneBalance');
    expect(content).toContain('role-coverage');
    expect(content).toContain('mentee layer is under-firing');
    expect(result.upgraded).toContain('CLAUDE.md: added apprenticeship layer-balance (keystoneBalance) awareness');
  });

  it('is idempotent — a second run changes nothing and reports no upgrade', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n**Apprenticeship Program**\n\n${PROACTIVE_ANCHOR}\n`);
    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf8');
    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf8');
    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded).not.toContain('CLAUDE.md: added apprenticeship layer-balance (keystoneBalance) awareness');
  });

  it('the INSERT branch does not fire on a bare file (the full section add supplies the line instead)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nNo apprenticeship here.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    // The section-add brings keystoneBalance via the template; the redundant
    // insert branch must NOT also fire.
    expect(result.upgraded).toContain('CLAUDE.md: added Apprenticeship Program section');
    expect(result.upgraded).not.toContain('CLAUDE.md: added apprenticeship layer-balance (keystoneBalance) awareness');
    const content = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content.split('keystoneBalance').length - 1).toBe(1); // present exactly once
  });

  it('a freshly-added section already carries the line — the insert never double-fires', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nBare agent.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.upgraded).toContain('CLAUDE.md: added Apprenticeship Program section');
    expect(result.upgraded).not.toContain('CLAUDE.md: added apprenticeship layer-balance (keystoneBalance) awareness');
    const content = fs.readFileSync(claudeMdPath, 'utf8');
    // present exactly once (from the section template, not also the insert)
    expect(content.split('keystoneBalance').length - 1).toBeGreaterThanOrEqual(1);
  });

  it('upgrades an agent that already carries the PRE-dormancy keystoneBalance shape in place', () => {
    // Simulate an agent migrated by the prior layer-balance change: it has the
    // keystoneBalance line but only the bare `{ ...starved, reason }` shape.
    const oldLine = '- Layer-balance health: `GET /apprenticeship/instances/:id/role-coverage` returns a `keystoneBalance` block — `{ keystoneAxis, keystoneCycleCount, lastKeystoneAt, oversightSinceKeystone, starved, reason }` — answering the balance question. `starved:true` = the mentee layer is under-firing. Observe-only; tune via `?oversightStarvationThreshold=N`.';
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n**Apprenticeship Program**\n\n${PROACTIVE_ANCHOR}\n${oldLine}\n`);
    const result = runClaudeMdMigration(newMigrator(projectDir));

    const content = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content).toContain('oversightSinceKeystone, starved, dormant, lastKeystoneAgeMs, reason }');
    expect(content).not.toContain('oversightSinceKeystone, starved, reason }');
    expect(result.upgraded).toContain('CLAUDE.md: added keystoneBalance dormancy field awareness');
    // the full-line insert must NOT also fire — keystoneBalance was already present
    expect(result.upgraded).not.toContain('CLAUDE.md: added apprenticeship layer-balance (keystoneBalance) awareness');

    // idempotent: a second run changes nothing and reports no dormancy upgrade
    const second = runClaudeMdMigration(newMigrator(projectDir));
    expect(fs.readFileSync(claudeMdPath, 'utf8')).toBe(content);
    expect(second.upgraded).not.toContain('CLAUDE.md: added keystoneBalance dormancy field awareness');
  });
});
