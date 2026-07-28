/**
 * Verifies PostUpdateMigrator delivers the AgentWorktreeReaper initial-pass
 * awareness bullet (reaper-never-fires fix) to EXISTING agents (Agent Awareness
 * + Migration Parity): fresh CLAUDE.mds get it inside the Stale-Worktree Reclaim
 * section; already-installed sections get the addendum inserted after the known
 * anchor line; drifted sections still receive the bullet (appended) rather than
 * silently skipping; and the whole path is idempotent.
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
function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

const ANCHOR = '- Review the dry-run report FIRST, then enable in `.instar/config.json`: `{"monitoring": {"agentWorktreeReaper": {"enabled": true, "dryRun": false}}}`. Tune `maxReapsPerPass` (default 20).';

describe('PostUpdateMigrator — AgentWorktreeReaper initial-pass bullet', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-reaper-bullet-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-reaperInitialPassBullet.test.ts:cleanup' });
  });

  it('a FRESH CLAUDE.md gets the section WITH the initial-pass bullet in one pass', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('/worktrees/agent-reaper');
    expect(after).toContain('initialPassDelayMs');
    expect(after).toContain('Initial pass after boot');
  });

  it('an ALREADY-INSTALLED section (pre-fix, with the known anchor) gets the bullet inserted after the anchor', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n## Stale-Worktree Reclaim (AgentWorktreeReaper)\n\nsee \`/worktrees/agent-reaper\`.\n${ANCHOR}\n- Pairs with the Spotlight-exclusion marker.\n`);
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('initial-pass bullet'))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('initialPassDelayMs');
    // inserted directly after the anchor line, before the following bullet
    const anchorIdx = after.indexOf(ANCHOR);
    const bulletIdx = after.indexOf('Initial pass after boot');
    const pairsIdx = after.indexOf('Pairs with the Spotlight-exclusion');
    expect(anchorIdx).toBeGreaterThan(-1);
    expect(bulletIdx).toBeGreaterThan(anchorIdx);
    expect(bulletIdx).toBeLessThan(pairsIdx);
  });

  it('a DRIFTED already-installed section (anchor line reworded) still receives the bullet (appended, never skipped)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\n## Stale-Worktree Reclaim (AgentWorktreeReaper)\n\nsee `/worktrees/agent-reaper` (reworded section, no anchor line).\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('initial-pass bullet'))).toBe(true);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toContain('initialPassDelayMs');
  });

  it('idempotent — a second run changes nothing', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\nsee \`/worktrees/agent-reaper\`.\n${ANCHOR}\n`);
    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some((u) => u.includes('initial-pass bullet'))).toBe(false);
  });
});
