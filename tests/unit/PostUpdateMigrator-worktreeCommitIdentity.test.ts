/**
 * W26 item 0(a) — Migration Parity for the worktree commit-identity change.
 *
 * The Worktree Convention section is installed add-if-absent, so an agent that
 * already carries it would never receive the corrected text. Without the
 * refresh migration those agents keep reading that the CLI stamps
 * `<name>@instar.local` — a promise the code no longer performs. A document
 * asserting behaviour that was removed is the same class of defect this window
 * exists to repair, one layer up.
 *
 * The migration must also NEVER write an identity of its own: it cannot know
 * one, and inventing one is precisely what the code change stopped doing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

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

/** A CLAUDE.md as it exists on an agent updated BEFORE this change: it already
 *  has the section, so the add-if-absent insert will skip it. */
const STALE_SECTION = `# CLAUDE.md — test

## Worktree Convention

Create worktrees for collaborator repos with \`instar worktree create <branch>\`.

**Caveat — git identity env vars:** the CLI sets per-worktree \`user.name\` / \`user.email\` to \`Instar Agent (<name>)\` / \`<name>@instar.local\`. \`GIT_AUTHOR_NAME\` / \`GIT_COMMITTER_EMAIL\` in the calling environment override that local config. Agents that care about commit attribution must avoid exporting those vars.

## Something After

Text that must survive untouched.
`;

function claudeMd(): string {
  return fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w26-migparity-'));
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/PostUpdateMigrator-worktreeCommitIdentity.test.ts:cleanup',
  });
});

describe('worktree commit-identity CLAUDE.md migration parity', () => {
  it('refreshes the stale identity paragraph on an agent that already has the section', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), STALE_SECTION);

    const result = migrateClaudeMd(projectDir);
    const after = claudeMd();

    // The old promise is gone...
    expect(after).not.toContain('**Caveat — git identity env vars:**');
    expect(after).not.toContain('@instar.local');
    // ...replaced by what the code actually does now.
    expect(after).toContain('**Commit identity — resolved, never invented:**');
    expect(after).toContain('git.commitIdentity');
    expect(after).toContain('REFUSES to create the worktree');
    // The env-var caveat is preserved — it is still true and still load-bearing.
    expect(after).toContain('GIT_AUTHOR_NAME');
    expect(result.upgraded.join(' ')).toContain('commit-identity paragraph');
  });

  it('leaves the rest of the document untouched', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), STALE_SECTION);

    migrateClaudeMd(projectDir);
    const after = claudeMd();

    expect(after).toContain('## Something After');
    expect(after).toContain('Text that must survive untouched.');
    expect(after).toContain('## Worktree Convention');
  });

  it('is idempotent — a second run changes nothing further', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), STALE_SECTION);

    migrateClaudeMd(projectDir);
    const afterFirst = claudeMd();
    migrateClaudeMd(projectDir);
    const afterSecond = claudeMd();

    expect(afterSecond).toBe(afterFirst);
    // and it does not accumulate duplicate paragraphs
    expect(afterSecond.split('**Commit identity — resolved, never invented:**')).toHaveLength(2);
  });

  // The load-bearing guarantee: the migrator handles documentation only. It has
  // no way to know which identity an agent should use, so it must not put one in.
  it('never writes a concrete identity of its own', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), STALE_SECTION);

    migrateClaudeMd(projectDir);
    const after = claudeMd();

    expect(after).not.toContain('@instar.local');
    expect(after).not.toContain('@sagemindai.io');
    // no bare email-looking literal was introduced anywhere in the section
    const section = after.slice(after.indexOf('## Worktree Convention'));
    expect(section).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  it('does not touch a document that never carried the section', () => {
    const plain = '# CLAUDE.md — test\n\nNo worktree section here.\n';
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), plain);

    migrateClaudeMd(projectDir);
    const after = claudeMd();

    // The add-if-absent insert owns this case; the refresh must not double-write.
    expect(after.split('**Commit identity — resolved, never invented:**').length - 1)
      .toBeLessThanOrEqual(1);
    expect(after).not.toContain('**Caveat — git identity env vars:**');
  });
});
