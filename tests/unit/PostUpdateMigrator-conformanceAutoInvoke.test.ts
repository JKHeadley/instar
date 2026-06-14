/**
 * Standards-Conformance Gate auto-invocation migration (2026-06-12, topic 13481):
 * the gate sat callable-but-never-called for 19 days because the auto-invocation
 * staging lived only in prose. The wiring is now a mandatory spec-converge Phase-1
 * step; this migration delivers the updated skill content to deployed agents.
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

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-autoinvoke-mig-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-conformanceAutoInvoke.test.ts' }));
  return dir;
}

function runMigration(projectDir: string) {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar') } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (m as unknown as { migrateConformanceGateAutoInvoke: (r: typeof result) => void }).migrateConformanceGateAutoInvoke(result);
  return result;
}

describe('migrateConformanceGateAutoInvoke', () => {
  it('the bundled spec-converge SKILL really carries the auto-invocation step', () => {
    const bundled = fs.readFileSync(path.join(repoRoot, 'skills', 'spec-converge', 'SKILL.md'), 'utf8');
    expect(bundled).toContain('Standards-Conformance Gate auto-invocation');
    expect(bundled).toContain('/spec/conformance-check');
  });

  it('upgrades a stock installed copy and is idempotent', () => {
    const projectDir = tmpProject();
    const installed = path.join(projectDir, '.claude', 'skills', 'spec-converge', 'SKILL.md');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '# /spec-converge\n\nold stock content without the wiring\n');

    const r1 = runMigration(projectDir);
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded.length).toBe(1);
    expect(fs.readFileSync(installed, 'utf8')).toContain('Standards-Conformance Gate auto-invocation');

    const r2 = runMigration(projectDir);
    expect(r2.upgraded).toEqual([]); // marker present — idempotent
  });

  it('leaves a customized installed copy untouched', () => {
    const projectDir = tmpProject();
    const installed = path.join(projectDir, '.claude', 'skills', 'spec-converge', 'SKILL.md');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, 'operator-custom skill\n');
    const r = runMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(r.skipped.join()).toContain('customized — left untouched');
  });

  it('the registry no longer claims the gate is un-invoked (prose honesty)', () => {
    const registry = fs.readFileSync(path.join(repoRoot, 'docs', 'STANDARDS-REGISTRY.md'), 'utf8');
    expect(registry).not.toContain('not yet auto-invoked');
    expect(registry).toContain('AUTO-INVOKED as of 2026-06-12');
  });
});
