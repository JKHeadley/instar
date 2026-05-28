/**
 * Verifies PostUpdateMigrator adds the Agent Updates topic self-broadcast
 * guidance section to existing agents' CLAUDE.md on update.
 *
 * Spec: docs/specs/UPDATE-MESSAGE-TOPIC-ROUTING-SPEC.md (Fix 3).
 *
 * Without this migration, existing agents would never learn that ship/update/
 * restart narration should route through `POST /telegram/post-update` rather
 * than the active session topic. The two code-side routing fixes (lifeline
 * 426 alert + ForegroundRestartWatcher notify) close the automated paths;
 * this template + migration closes the agent-authored path.
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

const MARKER = 'Agent Updates topic (self-broadcasts about ships, restarts, updates)';

describe('PostUpdateMigrator — Agent Updates topic self-broadcast guidance', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-updatebcast-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-updateTopicSelfBroadcast.test.ts:cleanup',
    });
  });

  it('adds the self-broadcast section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(
      result.upgraded.some(u => u.includes('Agent Updates topic self-broadcast guidance')),
    ).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MARKER);
    // The endpoint the agent is supposed to use.
    expect(after).toContain('/telegram/post-update');
    // The trigger sentence.
    expect(after).toContain('the moment I am about to author a conversational message whose subject is *me* shipping');
    // The anti-fallback rule.
    expect(after).toContain('do NOT fall back to sending in the active topic');
  });

  it('is idempotent — re-running does not add a duplicate section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.errors).toEqual([]);
    expect(
      result2.upgraded.some(u => u.includes('Agent Updates topic self-broadcast guidance')),
    ).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    const headingMatches = afterSecond.match(
      /### Agent Updates topic \(self-broadcasts about ships, restarts, updates\)/g,
    );
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

describe('generateClaudeMd template includes Agent Updates topic self-broadcast section', () => {
  it('the source template emits the section so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain(MARKER);
    expect(templateSource).toContain('/telegram/post-update');
    expect(templateSource).toContain('PROACTIVE — this is the trigger');
  });
});
