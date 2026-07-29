/**
 * "Verify the State, Not Its Symbol" review-check migration.
 *
 * The check is intentionally an LLM reviewer question, not a deterministic
 * parser: strings, files, counts, and rates are useful signals, and only the
 * full-context integration reviewer can judge whether they prove the claimed
 * state. These tests bind both bundled reviewer surfaces to that question and
 * prove that existing stock installations receive the updated prompt content.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

const REVIEW_MARKER = 'Verify the State, Not Its Symbol — evidentiary review-check';
const SKILL_REL = ['skills', 'spec-converge', 'SKILL.md'];
const TEMPLATE_REL = ['skills', 'spec-converge', 'templates', 'reviewer-integration.md'];

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-state-review-mig-'));
  cleanups.push(() =>
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-symbolStateReviewCheck.test.ts',
    }),
  );
  return dir;
}

function installPreChangeStock(projectDir: string, rel: string[], fingerprint: string): string {
  const installed = path.join(projectDir, '.claude', ...rel);
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  const insertionAnchor =
    rel === SKILL_REL
      ? '- **Decision-Completeness.** existing stock question\n'
      : '6. **Backup/restore** — existing stock question\n';
  // Carry the earlier A/B migration marker to prove this new migration is not
  // accidentally satisfied by the already-deployed standards prompt.
  fs.writeFileSync(
    installed,
    `${fingerprint}\n\nmachine-local-justification\nold stock content without P20\n\n${insertionAnchor}`,
  );
  return installed;
}

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
  } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
}

function runMigration(projectDir: string) {
  const migrator = newMigrator(projectDir);
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (
    migrator as unknown as {
      migrateSymbolStateReviewCheck: (migrationResult: typeof result) => void;
    }
  ).migrateSymbolStateReviewCheck(result);
  return result;
}

describe('"Verify the State, Not Its Symbol" reviewer prompt', () => {
  it.each([
    ['skill declaration', SKILL_REL],
    ['spawned integration-reviewer template', TEMPLATE_REL],
  ])('%s carries the complete judgment-bearing question', (_label, rel) => {
    const prompt = fs.readFileSync(path.join(repoRoot, ...rel), 'utf8');

    expect(prompt).toContain(REVIEW_MARKER);
    expect(prompt).toContain('For EVERY detector, metric, or gate');
    expect(prompt).toContain('SYMBOL');
    expect(prompt).toContain('STATE');
    expect(prompt).toContain('independent corroboration');
    expect(prompt).toContain('unmeasurable');
    expect(prompt).toContain('BIDIRECTIONAL');
    expect(prompt).toContain('can the symbol be present while the claimed state is absent');
    expect(prompt).toContain('can the claimed state be present while the symbol is absent');
    expect(prompt).toContain('string, file presence, count, or rate');
    expect(prompt).toContain('MATERIAL FINDING');
  });
});

describe('migrateSymbolStateReviewCheck', () => {
  it('does not mistake a marker-only partial prompt for the deployed capability', () => {
    const projectDir = tmpProject();
    const installed = installPreChangeStock(projectDir, SKILL_REL, '# /spec-converge');
    fs.appendFileSync(installed, `${REVIEW_MARKER}\n`);

    const result = runMigration(projectDir);
    expect(result.upgraded).toHaveLength(1);
    const migrated = fs.readFileSync(installed, 'utf8');
    expect(migrated).toContain('independent corroboration');
    expect(migrated).toContain('BIDIRECTIONALLY');
    expect(migrated).toContain('unmeasurable');
  });

  it('does not mistake a phrase-rich prompt missing the SYMBOL declaration for complete state', () => {
    const projectDir = tmpProject();
    const installed = installPreChangeStock(projectDir, SKILL_REL, '# /spec-converge');
    const bundledQuestion = fs
      .readFileSync(path.join(repoRoot, ...SKILL_REL), 'utf8')
      .split('\n')
      .find((line) => line.includes(REVIEW_MARKER));
    expect(bundledQuestion).toBeTruthy();
    const partialQuestion = bundledQuestion!.replace('**SYMBOL**', 'symbol');
    expect(partialQuestion).not.toBe(bundledQuestion);
    fs.appendFileSync(installed, `${partialQuestion}\n`);

    const result = runMigration(projectDir);
    expect(result.upgraded).toHaveLength(1);
    expect(fs.readFileSync(installed, 'utf8')).toContain(bundledQuestion);
  });

  it('is wired into the public post-update migration pipeline', () => {
    const projectDir = tmpProject();
    const skill = installPreChangeStock(projectDir, SKILL_REL, '# /spec-converge');
    const template = installPreChangeStock(
      projectDir,
      TEMPLATE_REL,
      '# Reviewer Prompt — Integration',
    );

    const result = newMigrator(projectDir).migrate();
    expect(fs.readFileSync(skill, 'utf8')).toContain(REVIEW_MARKER);
    expect(fs.readFileSync(template, 'utf8')).toContain(REVIEW_MARKER);
    expect(result.upgraded.some((entry) => entry.includes('Verify State, Not Symbol'))).toBe(
      true,
    );
  });

  it('updates pre-change stock copies and is idempotent', () => {
    const projectDir = tmpProject();
    const skill = installPreChangeStock(projectDir, SKILL_REL, '# /spec-converge');
    const template = installPreChangeStock(
      projectDir,
      TEMPLATE_REL,
      '# Reviewer Prompt — Integration',
    );

    const first = runMigration(projectDir);
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toHaveLength(2);
    expect(fs.readFileSync(skill, 'utf8')).toContain(REVIEW_MARKER);
    expect(fs.readFileSync(template, 'utf8')).toContain(REVIEW_MARKER);

    const second = runMigration(projectDir);
    expect(second.errors).toEqual([]);
    expect(second.upgraded).toEqual([]);
  });

  it('leaves customized installed content untouched and reports it', () => {
    const projectDir = tmpProject();
    const installed = path.join(projectDir, '.claude', ...SKILL_REL);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, 'custom operator-authored convergence skill\n');

    const result = runMigration(projectDir);
    expect(result.upgraded).toEqual([]);
    expect(result.skipped.join()).toContain('customized or unknown layout — left untouched');
    expect(fs.readFileSync(installed, 'utf8')).toBe(
      'custom operator-authored convergence skill\n',
    );
  });

  it('surgically preserves a stock-derived customization around the unique anchor', () => {
    const projectDir = tmpProject();
    const installed = path.join(projectDir, '.claude', ...SKILL_REL);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(
      installed,
      [
        '# /spec-converge',
        '',
        'machine-local-justification',
        'custom operator preface that is not in the bundled skill',
        '',
        '- **Decision-Completeness.** retained stock anchor',
        'custom operator suffix that is not in the bundled skill',
        '',
      ].join('\n'),
    );

    const result = runMigration(projectDir);
    expect(result.upgraded).toHaveLength(1);
    const migrated = fs.readFileSync(installed, 'utf8');
    expect(migrated).toContain('custom operator preface that is not in the bundled skill');
    expect(migrated).toContain('custom operator suffix that is not in the bundled skill');
    expect(migrated).toContain(REVIEW_MARKER);
  });

  it('silently skips missing installed copies because fresh installs use bundled content', () => {
    const result = runMigration(tmpProject());
    expect(result.upgraded).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
