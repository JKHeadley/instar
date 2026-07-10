/**
 * Verifies PostUpdateMigrator adds the Non-Gating Failure-Swap awareness section to
 * existing agents' CLAUDE.md on update, and that the source template emits it for fresh
 * installs (Agent Awareness + Migration Parity).
 *
 * Spec: docs/specs/nongating-failure-swap.md.
 *
 * Without this migration, existing agents would never learn that non-gating internal
 * calls (e.g. TopicIntentExtractor) now get a bounded, herd-safe swap on an
 * invocation-level failure — the fix for the 28% codex invocation-error class.
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

const MARKER = 'non-gating internal calls also get a bounded';

describe('PostUpdateMigrator — Non-Gating Failure-Swap awareness', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-nongating-swap-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-nonGatingFailureSwap.test.ts:cleanup',
    });
  });

  it('adds the non-gating failure-swap section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('Non-Gating Failure-Swap awareness'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MARKER);
    expect(after).toContain('intelligence.nonGatingFailureSwap');
    expect(after).toContain('intelligence.nonGatingSwapTimeoutMs');
    // the herd-safety invariant is stated
    expect(after).toContain('never herd onto the last-resort Claude tail');
    // the off-switch
    expect(after).toContain('intelligence.nonGatingFailureSwap.enabled: false');
  });

  it('is idempotent — re-running does not add a duplicate section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.errors).toEqual([]);
    expect(result2.upgraded.some(u => u.includes('Non-Gating Failure-Swap awareness'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    const matches = afterSecond.match(/non-gating internal calls also get a bounded/g);
    expect(matches?.length).toBe(1);
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

describe('generateClaudeMd template includes the non-gating failure-swap note', () => {
  it('the source template emits the note so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain('Non-gating calls also get a bounded swap now');
    expect(templateSource).toContain('intelligence.nonGatingFailureSwap');
    expect(templateSource).toContain('intelligence.nonGatingSwapTimeoutMs');
    expect(templateSource).toContain('nongating-failure-swap.md');
  });
});
