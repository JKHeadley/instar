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
    expect(fs.readFileSync(writer, 'utf8')).toContain('MATURATION_PLAN_WARN');
    const before = fs.readFileSync(writer);
    expect(run().upgraded).toEqual([]);
    expect(fs.readFileSync(writer)).toEqual(before);
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
