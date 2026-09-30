/**
 * Migration Parity for the WorktreeMonitor announce-on-change change: existing
 * agents learn why worktree notices went quiet and where the live findings
 * are. Add-if-absent on the heading, so a second run changes nothing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

let projectDir: string;

function migrateClaudeMd(dir: string): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (new PostUpdateMigrator({
    projectDir: dir,
    stateDir: path.join(dir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  }) as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

function claudeMd(): string {
  return fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-notices-migparity-'));
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/PostUpdateMigrator-worktreeNotices.test.ts:cleanup',
  });
});

describe('Worktree Notices CLAUDE.md migration parity', () => {
  it('adds the section to an existing agent that lacks it, once', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md — test\n\n## Something\n\nKeep me.\n');

    const first = migrateClaudeMd(projectDir);
    const afterFirst = claudeMd();
    expect(first.upgraded).toContain('CLAUDE.md: added Worktree Notices section');
    expect(afterFirst).toContain('## Worktree Notices');
    expect(afterFirst).toContain('/hooks/worktrees/last-report');
    expect(afterFirst).toContain('Keep me.');

    const second = migrateClaudeMd(projectDir);
    expect(second.skipped).toContain('CLAUDE.md: Worktree Notices section already present');
    expect(claudeMd().split('## Worktree Notices').length - 1).toBe(1);
  });

  it('new agents get the same section from the template', () => {
    const md = generateClaudeMd('test', 'Echo', 4042, false);
    expect(md).toContain('## Worktree Notices');
    expect(md).toContain('http://localhost:4042/hooks/worktrees');
  });
});
