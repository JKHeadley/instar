import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'PostUpdateMigrator-feature-maturation.test cleanup' });
});

function setup(): { root: string; run: (overrides?: Record<string, string[]>) => Result } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maturation-migration-'));
  roots.push(root);
  const migrator = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar') } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
  return {
    root,
    run: (overrides = {}) => {
      const result: Result = { upgraded: [], skipped: [], errors: [] };
      (migrator as unknown as { migrateFeatureMaturationGate(r: Result, o?: Record<string, string[]>): void }).migrateFeatureMaturationGate(result, overrides);
      return result;
    },
  };
}

describe('migrateFeatureMaturationGate', () => {
  it('installs missing targets and is idempotent', () => {
    const { root, run } = setup();
    expect(run().errors).toEqual([]);
    const detector = path.join(root, 'scripts', 'feature-maturation-plan-gate.mjs');
    const installedDetector = path.join(root, '.claude', 'scripts', 'feature-maturation-plan-gate.mjs');
    const installedSource = path.join(root, '.claude', 'src', 'core', 'FeatureMaturationPlanGate.mjs');
    const writer = path.join(root, '.claude', 'skills', 'spec-converge', 'scripts', 'write-convergence-tag.mjs');
    expect(fs.readFileSync(detector, 'utf8')).toContain('FeatureMaturationPlanGate.mjs');
    expect(fs.readFileSync(installedDetector, 'utf8')).toContain('FeatureMaturationPlanGate.mjs');
    expect(fs.readFileSync(installedSource, 'utf8')).toContain('findMaturationPlanGaps');
    // 2026-08-07 (Maturation Path clause (a)): the chokepoint REFUSES, it no longer
    // warns. This assertion is the migration-parity proof that a DEPLOYED agent
    // receives the refusing writer — a gate promoted only in the source tree would
    // leave every existing agent still merely warning, which is the exact
    // new-agents-only failure the Migration Parity Standard exists to prevent.
    expect(fs.readFileSync(writer, 'utf8')).toContain('MATURATION_PLAN_REFUSED');
    expect(fs.readFileSync(writer, 'utf8')).not.toContain('MATURATION_PLAN_WARN');
    const before = fs.readFileSync(writer);
    expect(run().upgraded).toEqual([]);
    expect(fs.readFileSync(writer)).toEqual(before);
  });

  /**
   * The constitution mirror, exercised — not grepped.
   *
   * This is the change's ONE load-bearing behaviour: a deployed agent's
   * `docs/STANDARDS-REGISTRY.md` sat at 22 articles dated May 24 while 81 were authored,
   * because nothing refreshed it. Until this test existed the guarantee was asserted by
   * `expect(migratorSource).toContain('alwaysOverwrite: true')` — a check that passes on
   * the string appearing anywhere in the file and would keep passing if the entry were
   * unreachable, mis-pathed, or deleted from the loop. A grep over source text is not a
   * test of behaviour; it is a test of spelling.
   *
   * The drift here is deliberately the SHAPE of the real failure: a stale copy that is
   * plausible, non-empty, and not a customization anyone declared.
   */
  it('REFRESHES a DRIFTED installed writer + delivers the whole phase-5 chain (the deployed-agent state)', () => {
    // Round-11 (integration): the existing assertions only ever exercised the
    // install-if-missing branch, because setup() builds a bare root — so the
    // prior-hash gate that actually governs every deployed agent was never
    // reached, and under it the writer had not refreshed since June. A deployed
    // agent BY DEFINITION already has the file with a drifted hash; that is the
    // only path that matters.
    const { root, run } = setup();
    const writer = path.join(root, '.claude', 'skills', 'spec-converge', 'scripts', 'write-convergence-tag.mjs');
    fs.mkdirSync(path.dirname(writer), { recursive: true });
    fs.writeFileSync(writer, '// stale installed writer from an earlier release\n');

    expect(run().errors).toEqual([]);

    const refreshed = fs.readFileSync(writer, 'utf8');
    expect(refreshed).not.toContain('stale installed writer');
    expect(refreshed).toContain('eli16-overview-check.mjs');
    // …and the module that import line resolves to must be delivered too, or
    // the refreshed writer dies before parsing an argument.
    expect(fs.existsSync(path.join(root, '.claude', 'scripts', 'eli16-overview-check.mjs'))).toBe(true);
    // The sanctioned publish path had no delivery entry at all.
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'spec-converge', 'scripts', 'publish-spec-review.mjs'))).toBe(true);
  });

  it('SYNCS the spec-converge reviewer templates, including one an existing agent never had', () => {
    // Round-10: `installBuiltinSkills` writes a skill's files only when the
    // skill is MISSING, so an existing agent's templates freeze at whatever
    // version first landed. Measured on a live agent home, the wrapper was
    // current while reviewer-decision-completeness.md — a reviewer SKILL.md
    // calls non-optional — was ABSENT entirely, so that reviewer could not run
    // there at all. Shipped content needs its own always-overwrite carrier.
    const { root, run } = setup();
    const templates = path.join(root, '.claude', 'skills', 'spec-converge', 'templates');
    // Pre-seed a STALE copy of one template and leave the non-optional one absent,
    // reproducing the live-agent shape exactly.
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(path.join(templates, 'reviewer-lessons-aware.md'), 'stale bytes');
    expect(fs.existsSync(path.join(templates, 'reviewer-decision-completeness.md'))).toBe(false);

    expect(run().errors).toEqual([]);

    const lessons = fs.readFileSync(path.join(templates, 'reviewer-lessons-aware.md'), 'utf8');
    expect(lessons).not.toBe('stale bytes');
    expect(lessons).toContain('FOUNDATION / SUBSYSTEM AUDIT');
    expect(fs.existsSync(path.join(templates, 'reviewer-decision-completeness.md'))).toBe(true);

    // Idempotent: a second pass changes nothing.
    const before = fs.readFileSync(path.join(templates, 'reviewer-lessons-aware.md'), 'utf8');
    expect(run().errors).toEqual([]);
    expect(fs.readFileSync(path.join(templates, 'reviewer-lessons-aware.md'), 'utf8')).toBe(before);
  });

  it('MIRRORS a drifted constitution back to the packed bytes, and is idempotent', () => {
    const packed = path.join(process.cwd(), 'dist', 'data', 'standards-registry.md');
    const { root, run } = setup();
    const target = path.join(root, 'docs', 'STANDARDS-REGISTRY.md');

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# Standards Registry\n\n### One Stale Article\n\nfrom May.\n');

    expect(run().errors).toEqual([]);

    // Byte equality with what ships — not "contains", not a length check.
    expect(fs.readFileSync(target)).toEqual(fs.readFileSync(packed));

    // Non-vacuity: the fixture must not have happened to equal the packed bytes already,
    // or the assertion above proves nothing about the mirror.
    expect(fs.statSync(packed).size).toBeGreaterThan(1000);

    // Second run rewrites identical bytes and reports nothing upgraded.
    const second = run();
    expect(second.errors).toEqual([]);
    expect(fs.readFileSync(target)).toEqual(fs.readFileSync(packed));
  });

  /**
   * The refusal half. `alwaysOverwrite` is destructive by design, so the one place it
   * must NOT fire is a tree whose `docs/STANDARDS-REGISTRY.md` is the authored original —
   * an older installed package would otherwise revert it, and the migrator's backup is
   * written only once, so a second pass destroys that too.
   */
  it('REFUSES the mirror in a source tree, leaving the authored constitution untouched', () => {
    const { root, run } = setup();
    // Make the fixture a checkout: the markers `holdsAuthoredConstitution` keys on.
    fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n');

    const target = path.join(root, 'docs', 'STANDARDS-REGISTRY.md');
    const authored = '### The Authored Original\n\nnot a copy.\n';
    fs.writeFileSync(target, authored);

    expect(run().errors).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe(authored);
  });

  it('leaves an unknown customized target byte-identical', () => {
    const { root, run } = setup();
    const target = path.join(root, 'scripts', 'feature-maturation-plan-gate.mjs');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'custom detector\n');
    const result = run();
    expect(result.skipped.join('\n')).toContain('customized');
    expect(fs.readFileSync(target, 'utf8')).toBe('custom detector\n');
  });

  it('refuses symlink targets without touching their destination', () => {
    const { root, run } = setup();
    const destination = path.join(root, 'destination.mjs');
    fs.writeFileSync(destination, 'keep\n');
    const target = path.join(root, 'scripts', 'feature-maturation-plan-gate.mjs');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(destination, target);
    expect(run().errors.join('\n')).toContain('refusing symlink target');
    expect(fs.readFileSync(destination, 'utf8')).toBe('keep\n');
  });

  it.each(['write', 'file-sync', 'rename'] as const)('leaves no accepted target on %s failure', (boundary) => {
    const { root, run } = setup();
    const target = path.join(root, 'scripts', 'feature-maturation-plan-gate.mjs');
    if (boundary === 'write') vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('write-stop'); });
    if (boundary === 'file-sync') vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('sync-stop'); });
    if (boundary === 'rename') vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('rename-stop'); });
    expect(run().errors.length).toBeGreaterThan(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('reports directory-sync failure after rename and converges on retry', () => {
    const { root, run } = setup();
    const sync = vi.spyOn(fs, 'fsyncSync');
    sync.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('dir-sync-stop'); });
    expect(run().errors.join('\n')).toContain('dir-sync-stop');
    vi.restoreAllMocks();
    const target = path.join(root, 'scripts', 'feature-maturation-plan-gate.mjs');
    expect(fs.readFileSync(target, 'utf8')).toContain('FeatureMaturationPlanGate.mjs');
    expect(run().errors).toEqual([]);
  });

  it('backs up recognized stock bytes, preserves them on replacement failure, and retries', () => {
    const { root, run } = setup();
    const target = path.join(root, 'scripts', 'feature-maturation-plan-gate.mjs');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const prior = Buffer.from('recognized prior stock\n');
    fs.writeFileSync(target, prior);
    const hash = crypto.createHash('sha256').update(prior).digest('hex');
    let renames = 0;
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      renames += 1;
      if (renames === 2) throw new Error('replacement-rename-stop');
      return realRename(from, to);
    });
    const overrides = { 'feature maturation plan detector': [hash] };
    expect(run(overrides).errors.join('\n')).toContain('replacement-rename-stop');
    expect(fs.readFileSync(target)).toEqual(prior);
    expect(fs.readFileSync(`${target}.pre-feature-maturation-v1.bak`)).toEqual(prior);
    vi.restoreAllMocks();
    expect(run(overrides).errors).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toContain('FeatureMaturationPlanGate.mjs');
  });
});
