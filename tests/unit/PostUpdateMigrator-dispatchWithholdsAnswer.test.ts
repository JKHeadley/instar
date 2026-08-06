/**
 * Dispatch-withholds-answer migration (constitutional standard "A Dispatch
 * Supplies the Question and Withholds the Answer", ratified 2026-08-06).
 *
 * installBuiltinSkills() is install-if-missing and never overwrites an installed
 * reviewer template, so a CONTENT update reaches already-deployed agents ONLY
 * through this dedicated idempotent migration (Migration Parity case 5b).
 *
 * The protocol block is a reviewer PROMPT (LLM authority), so the deterministic
 * assertion a unit test can make is that the shipped prompt TEXT carries the
 * complete protocol — i.e. the dispatched reviewer is now INSTRUCTED to treat a
 * supplied expectation as untrusted. That instruction's presence is what makes
 * the lens live on the next review run.
 *
 * Both sides of every boundary are covered, per Testing Integrity and the
 * rung-three amendment: the migration must ACT on a stock installed template,
 * and HOLD BACK on one that is already migrated or customized.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const TEMPLATE_DIR = ['skills', 'spec-converge', 'templates'];
const MARKER = 'dispatch-withholds-answer';
const REQUIRED = [
  'untrusted context, not a finding',
  'refuting it is the more valuable result',
  'separately from any hypothesis',
] as const;

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-withhold-mig-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true,
    operation: 'tests/unit/PostUpdateMigrator-dispatchWithholdsAnswer.test.ts',
  }));
  return dir;
}

function installTemplate(projectDir: string, name: string, content: string): string {
  const p = path.join(projectDir, '.claude', ...TEMPLATE_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function runMigration(projectDir: string) {
  const m = new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
  } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (m as unknown as { migrateDispatchWithholdsAnswer: (r: typeof result) => void })
    .migrateDispatchWithholdsAnswer(result);
  return result;
}

const STOCK = '# Reviewer Prompt — Security Perspective\n\nYou are the security reviewer for an instar spec under convergence review.\n\nRead these in order:\n\n1. The spec file.\n';

describe('the bundled reviewer templates carry the withhold-the-answer protocol', () => {
  const names = fs.readdirSync(path.join(repoRoot, ...TEMPLATE_DIR))
    .filter((f) => /^reviewer-.*\.md$/.test(f));

  it('finds reviewer templates at all (an empty set would make every assertion below vacuous)', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)('%s instructs its reviewer with the complete protocol', (name) => {
    const content = fs.readFileSync(path.join(repoRoot, ...TEMPLATE_DIR, name), 'utf8');
    expect(content).toContain(MARKER);
    // Not just the marker: a marker without its instructions is a symbol standing
    // in for the protocol, which is the parent standard's own defect.
    for (const clause of REQUIRED) expect(content).toContain(clause);
  });
});

describe('migrateDispatchWithholdsAnswer — ACTS when it should', () => {
  it('inserts the protocol into a stock installed template that lacks it', () => {
    const project = tmpProject();
    const installed = installTemplate(project, 'reviewer-security.md', STOCK);
    const result = runMigration(project);

    const after = fs.readFileSync(installed, 'utf8');
    expect(after).toContain(MARKER);
    for (const clause of REQUIRED) expect(after).toContain(clause);
    expect(result.upgraded.join(' ')).toContain('reviewer-security.md');
    expect(result.errors).toEqual([]);
    // The original content survives — the migration inserts, never replaces.
    expect(after).toContain('You are the security reviewer');
    expect(after).toContain('1. The spec file.');
  });
});

describe('migrateDispatchWithholdsAnswer — HOLDS BACK when it should', () => {
  it('is idempotent: a second run changes nothing', () => {
    const project = tmpProject();
    const installed = installTemplate(project, 'reviewer-security.md', STOCK);
    runMigration(project);
    const afterFirst = fs.readFileSync(installed, 'utf8');

    const second = runMigration(project);
    expect(fs.readFileSync(installed, 'utf8')).toBe(afterFirst);
    expect(second.upgraded).toEqual([]);
    expect(second.errors).toEqual([]);
  });

  it('leaves a customized template byte-for-byte untouched and says so', () => {
    const project = tmpProject();
    const custom = 'totally custom file with no recognizable role paragraph\n';
    const installed = installTemplate(project, 'reviewer-security.md', custom);

    const result = runMigration(project);
    expect(fs.readFileSync(installed, 'utf8')).toBe(custom);
    expect(result.skipped.join(' ')).toContain('reviewer-security.md');
    expect(result.upgraded).toEqual([]);
  });

  it('does not create a template the agent never had installed', () => {
    const project = tmpProject();
    fs.mkdirSync(path.join(project, '.claude', ...TEMPLATE_DIR), { recursive: true });

    const result = runMigration(project);
    expect(fs.existsSync(path.join(project, '.claude', ...TEMPLATE_DIR, 'reviewer-security.md'))).toBe(false);
    expect(result.upgraded).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
