/**
 * Verifies PostUpdateMigrator adds the "Close the Loop (Untracked = Abandoned)"
 * core principle to existing agents' CLAUDE.md on update, and that the principle
 * is declared in the Standards Registry (the constitution) + the agent template.
 *
 * Ratified with Justin 2026-05-31 out of the rate-limit investigation: the
 * "nothing falls through the cracks" idea — that every opened loop (a user
 * promise, a feature shipped dark, an LLM gate deployed, a flagged issue) must
 * be durably re-surfaced on a cadence until a deliberate close — was elevated to
 * a constitutional standard because it is coherence made operational across time.
 *
 * This migration ensures deployed agents (not only freshly-initialized ones)
 * inherit the operating principle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const MARKER = 'Close the Loop (Untracked = Abandoned)';

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

describe('PostUpdateMigrator — Close the Loop CLAUDE.md core principle', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-closetheloop-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-closeTheLoop.test.ts:cleanup',
    });
  });

  it('adds the Close the Loop principle when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('Close the Loop'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MARKER);
    expect(after).toContain('re-surfaced on a cadence until it reaches a deliberate close');
    expect(after).toContain('coherence across');
    expect(after).toContain('docs/STANDARDS-REGISTRY.md');
  });

  it('is idempotent — re-running does not add a duplicate section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.errors).toEqual([]);
    expect(result2.upgraded.some(u => u.includes('Close the Loop'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    const headingMatches = afterSecond.match(/### Close the Loop \(Untracked = Abandoned\)/g);
    expect(headingMatches?.length).toBe(1);
  });

  it('does NOT double-patch a freshly-initialized agent that already has the template version', () => {
    // A new agent's CLAUDE.md (from the template) already contains the principle
    // in its Core Principles section via the shared marker. The migration must
    // content-sniff on that marker and skip, so the agent is never double-patched.
    const fresh =
      '# CLAUDE.md\n\n### Core Principles\n\n' +
      `**${MARKER}** — Every loop I open must be re-surfaced on a cadence until a deliberate close.\n`;
    fs.writeFileSync(claudeMdPath, fresh);

    const result = runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result.upgraded.some(u => u.includes('Close the Loop'))).toBe(false);
    // Exactly the one occurrence that was already present — none appended.
    const markerMatches = after.match(/Close the Loop \(Untracked = Abandoned\)/g);
    expect(markerMatches?.length).toBe(1);
  });

  it('preserves existing CLAUDE.md content above the new section', () => {
    const original = '# CLAUDE.md\n\n## My Custom Section\n\nDo not delete this.\n';
    fs.writeFileSync(claudeMdPath, original);

    runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(after.startsWith(original)).toBe(true);
    expect(after.length).toBeGreaterThan(original.length);
  });

  it('does not run when CLAUDE.md is missing (graceful skip)', () => {
    expect(fs.existsSync(claudeMdPath)).toBe(false);

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('CLAUDE.md'))).toBe(true);
  });
});

describe('Close the Loop is declared in the constitution + the agent template', () => {
  it('the Standards Registry (the constitution) declares the standard with its story', () => {
    const registry = fs.readFileSync(
      path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md'),
      'utf-8',
    );
    expect(registry).toContain('### Close the Loop');
    expect(registry).toContain('Untracked = Abandoned');
    // The four registry facets must be present for this standard.
    expect(registry).toContain('Distinct from Deferral = Deletion');
    expect(registry).toContain('made operational across');
  });

  it('the agent template emits the principle so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain(MARKER);
    expect(templateSource).toContain('Deferral = Deletion captures it now');
  });
});
