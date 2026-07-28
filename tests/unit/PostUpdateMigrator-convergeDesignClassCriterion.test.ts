/**
 * Corrected convergence stop-criterion migration.
 *
 * PR #1673 replaced "no material new issues" with "no DESIGN-class findings for TWO
 * consecutive rounds". Per Migration Parity case 5b, installBuiltinSkills() never
 * overwrites an installed SKILL.md, so a dedicated migration is the ONLY path that
 * content reaches an existing agent.
 *
 * WHY THIS TEST FILE EXISTS AT ALL — the finding, not the feature. The sibling
 * migration `migrateConformanceGateAutoInvoke` already delivers this same file, and
 * its idempotency guard returns early once the installed copy contains the marker
 * from THAT change. So every agent that took it was permanently short-circuited for
 * every LATER change to spec-converge/SKILL.md. Verified live on the authoring agent
 * 2026-07-27: the conformance marker present, the corrected criterion absent — so
 * #1673 could never arrive, and a re-run would have used the OLD unterminating rule
 * while reporting itself as the fixed loop.
 *
 * The last test below is the load-bearing one: it pins that a copy already carrying
 * the SIBLING marker still gets this change. That is the exact case the sibling
 * guard silently drops, and the reason a per-change marker is required rather than
 * reusing an existing one.
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
const SKILL_REL = ['skills', 'spec-converge', 'SKILL.md'];
const MARKER = 'No DESIGN-class findings for TWO consecutive rounds';
const SIBLING_MARKER = 'Standards-Conformance Gate auto-invocation';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-criterion-mig-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-convergeDesignClassCriterion.test.ts' }));
  return dir;
}

function runMigration(projectDir: string) {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar') } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (m as unknown as { migrateConvergeDesignClassCriterion: (r: typeof result) => void }).migrateConvergeDesignClassCriterion(result);
  return result;
}

function writeInstalled(projectDir: string, content: string): string {
  const p = path.join(projectDir, '.claude', ...SKILL_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('the bundled SKILL carries the corrected criterion', () => {
  it('names the DESIGN-class two-consecutive-quiet-rounds rule', () => {
    const skill = fs.readFileSync(path.join(repoRoot, ...SKILL_REL), 'utf8');
    expect(skill).toContain(MARKER);
  });
});

describe('migrateConvergeDesignClassCriterion', () => {
  it('upgrades a stock installed copy carrying the OLD criterion', () => {
    const projectDir = tmpProject();
    const p = writeInstalled(projectDir, '# /spec-converge\n\nThe new round produces no material new issues.\n');
    const result = runMigration(projectDir);
    expect(fs.readFileSync(p, 'utf8')).toContain(MARKER);
    expect(result.upgraded.some((u) => u.includes('design-class convergence criterion'))).toBe(true);
  });

  it('is idempotent — a second run reports nothing and changes nothing', () => {
    const projectDir = tmpProject();
    const p = writeInstalled(projectDir, '# /spec-converge\n\nThe new round produces no material new issues.\n');
    runMigration(projectDir);
    const afterFirst = fs.readFileSync(p, 'utf8');
    const second = runMigration(projectDir);
    expect(fs.readFileSync(p, 'utf8')).toBe(afterFirst);
    expect(second.upgraded).toEqual([]);
  });

  it('leaves a CUSTOMIZED skill untouched and says so', () => {
    // The guard that makes widening safe: an operator who rewrote this file keeps it.
    const projectDir = tmpProject();
    const custom = 'my own rewritten converge instructions, no instar heading\n';
    const p = writeInstalled(projectDir, custom);
    const result = runMigration(projectDir);
    expect(fs.readFileSync(p, 'utf8')).toBe(custom);
    expect(result.skipped.some((sk) => sk.includes('customized'))).toBe(true);
    expect(result.upgraded).toEqual([]);
  });

  it('does nothing when no skill is installed — a fresh install gets the bundled copy', () => {
    const projectDir = tmpProject();
    const result = runMigration(projectDir);
    expect(result.upgraded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('THE POINT: an agent already carrying the SIBLING marker still receives this change', () => {
    // migrateConformanceGateAutoInvoke returns early forever once its own marker is
    // present. That is precisely the population this migration exists to reach — and
    // it is the live state of the authoring agent, which is how the gap was found.
    const projectDir = tmpProject();
    const p = writeInstalled(
      projectDir,
      `# /spec-converge\n\n${SIBLING_MARKER} is wired in Phase 1.\n\nThe new round produces no material new issues.\n`,
    );
    const before = fs.readFileSync(p, 'utf8');
    expect(before).toContain(SIBLING_MARKER);
    expect(before).not.toContain(MARKER);

    const result = runMigration(projectDir);

    expect(fs.readFileSync(p, 'utf8')).toContain(MARKER);
    expect(result.upgraded.some((u) => u.includes('design-class convergence criterion'))).toBe(true);
  });
});
