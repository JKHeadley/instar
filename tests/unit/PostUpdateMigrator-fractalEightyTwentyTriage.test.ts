// safe-git-allow: reads one immutable historical skill blob to prove the marker migration.
// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * Fractal 80/20 convergence + found-problem triage migration (CMT-917).
 *
 * Per Migration Parity case 5b, installBuiltinSkills() never overwrites an
 * installed SKILL.md, so this migration is the only path the new spec-converge,
 * instar-dev and build content reaches an existing agent. It supersedes
 * migrateConvergeDesignClassCriterion, whose marker is gone from the bundled file.
 *
 * The load-bearing case: a copy carrying an OLDER change's marker (the previous
 * "two consecutive rounds" criterion) must still receive this change. A sibling
 * marker short-circuiting a later change is the gap the superseded migration
 * was itself written to close.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const MARKER = 'FRACTAL_8020_TRIAGE';
const OLD_MARKER = 'No DESIGN-class findings for TWO consecutive rounds';

const BUNDLED = {
  specConverge: path.join(repoRoot, 'skills', 'spec-converge', 'SKILL.md'),
  instarDev: path.join(repoRoot, 'skills', 'instar-dev', 'SKILL.md'),
  build: path.join(repoRoot, '.claude', 'skills', 'build', 'SKILL.md'),
  autonomous: path.join(repoRoot, '.claude', 'skills', 'autonomous', 'SKILL.md'),
};

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-8020-mig-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-fractalEightyTwentyTriage.test.ts' }));
  return dir;
}

function runMigration(projectDir: string) {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar') } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (m as unknown as { migrateFractalEightyTwentyTriage: (r: typeof result) => void }).migrateFractalEightyTwentyTriage(result);
  return result;
}

function writeInstalled(projectDir: string, skill: string, content: string): string {
  const p = path.join(projectDir, '.claude', 'skills', skill, 'SKILL.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('the bundled skills carry the CMT-917 content', () => {
  it('every touched skill carries the marker', () => {
    for (const f of Object.values(BUNDLED)) expect(fs.readFileSync(f, 'utf8')).toContain(MARKER);
  });

  it('spec-converge: convergence is "nothing changes what gets built", with a size-based round cap', () => {
    const s = fs.readFileSync(BUNDLED.specConverge, 'utf8');
    expect(s).toContain('a round finds nothing that would change what gets BUILT');
    expect(s).toContain('Tier 1 (small, reversible): 3 rounds');
    expect(s).toContain('## Left behind');
    expect(s).toContain('## Proportion');
    expect(s).not.toContain('A smaller finding count is NOT convergence');
    expect(s).not.toContain(OLD_MARKER);
  });

  it('instar-dev, build and autonomous carry the triage rule and name the queues', () => {
    for (const f of [BUNDLED.instarDev, BUNDLED.build, BUNDLED.autonomous]) {
      const s = fs.readFileSync(f, 'utf8');
      expect(s).toContain('Blocks the current work?');
      expect(s).toContain('`/feedback`');
      expect(s).toContain('`/commit-action`');
      expect(s).toContain('starts an `/autonomous` run to complete it');
    }
  });
});

describe('spec-converge reviewer templates ask for the DESIGN/PRECISION label', () => {
  it('every reviewer template requires the classification', () => {
    const dir = path.join(repoRoot, 'skills', 'spec-converge', 'templates');
    const names = fs.readdirSync(dir).filter((n) => n.startsWith('reviewer-'));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(fs.readFileSync(path.join(dir, n), 'utf8')).toContain('Classify every finding (required)');
  });
});

describe('migrateFractalEightyTwentyTriage', () => {
  it('upgrades stock spec-converge, instar-dev and build copies', () => {
    const projectDir = tmpProject();
    const sc = writeInstalled(projectDir, 'spec-converge', '# /spec-converge\n\nold\n');
    const id = writeInstalled(projectDir, 'instar-dev', '# /instar-dev\n\nold\n');
    const b = writeInstalled(projectDir, 'build', '# /build — Rigorous Build Skill\n\nold\n');
    const result = runMigration(projectDir);
    expect(fs.readFileSync(sc, 'utf8')).toBe(fs.readFileSync(BUNDLED.specConverge, 'utf8'));
    expect(fs.readFileSync(id, 'utf8')).toBe(fs.readFileSync(BUNDLED.instarDev, 'utf8'));
    expect(fs.readFileSync(b, 'utf8')).toBe(fs.readFileSync(BUNDLED.build, 'utf8'));
    expect(result.upgraded).toHaveLength(3);
    expect(result.errors).toEqual([]);
  });

  it('is idempotent — a second run reports nothing and changes nothing', () => {
    const projectDir = tmpProject();
    const p = writeInstalled(projectDir, 'spec-converge', '# /spec-converge\n\nold\n');
    runMigration(projectDir);
    const afterFirst = fs.readFileSync(p, 'utf8');
    const second = runMigration(projectDir);
    expect(fs.readFileSync(p, 'utf8')).toBe(afterFirst);
    expect(second.upgraded).toEqual([]);
  });

  it('leaves a CUSTOMIZED skill untouched and says so', () => {
    const projectDir = tmpProject();
    const custom = 'my own rewritten converge instructions, no instar heading\n';
    const p = writeInstalled(projectDir, 'spec-converge', custom);
    const result = runMigration(projectDir);
    expect(fs.readFileSync(p, 'utf8')).toBe(custom);
    expect(result.skipped.some((sk) => sk.includes('customized'))).toBe(true);
    expect(result.upgraded).toEqual([]);
  });

  it('does nothing when no skill is installed — a fresh install gets the bundled copy', () => {
    const result = runMigration(tmpProject());
    expect(result.upgraded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('THE POINT: a copy carrying the previous criterion marker still receives this change', () => {
    const projectDir = tmpProject();
    const p = writeInstalled(projectDir, 'spec-converge', `# /spec-converge\n\n${OLD_MARKER}.\n`);
    const result = runMigration(projectDir);
    expect(fs.readFileSync(p, 'utf8')).toContain(MARKER);
    expect(result.upgraded.some((u) => u.includes('fractal 80/20'))).toBe(true);
  });
});

describe('autonomous SKILL marker chain (FRACTAL_8020_TRIAGE step)', () => {
  // Last main commit before this change: carries CHECKBOX_TASK_LIST, not the new marker.
  const PRIOR_COMMIT = '916b3a88868e93ca4ceb98ec0b0681381fbced84';

  it('re-deploys the prior stock autonomous skill, idempotently', () => {
    const prior = execFileSync('git', ['show', `${PRIOR_COMMIT}:.claude/skills/autonomous/SKILL.md`], { cwd: repoRoot }).toString();
    expect(prior).toContain('CHECKBOX_TASK_LIST');
    expect(prior).not.toContain(MARKER);
    const projectDir = tmpProject();
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const dst = writeInstalled(projectDir, 'autonomous', prior);
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4040, hasTelegram: false, projectName: 'test' });
    const run = () => {
      const r = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
      (m as unknown as { migrateAutonomousStopHookTopicKeyed(r: unknown): void }).migrateAutonomousStopHookTopicKeyed(r);
      return r;
    };
    const first = run();
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain('skills/autonomous/SKILL.md (found-problem triage + proportion line)');
    expect(fs.readFileSync(dst, 'utf8')).toBe(fs.readFileSync(BUNDLED.autonomous, 'utf8'));
    const second = run();
    expect(second.upgraded).not.toContain('skills/autonomous/SKILL.md (found-problem triage + proportion line)');
  });
});
