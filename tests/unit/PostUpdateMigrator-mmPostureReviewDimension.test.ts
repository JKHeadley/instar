/**
 * Multi-machine posture review dimension migration (Cross-Machine Coherence
 * widening, 2026-06-12 topic 13481): deployed agents' installed copies of the
 * instar-dev side-effects template, instar-dev SKILL, and spec-converge SKILL
 * gain the multi-machine posture question — marker-sniffed, fingerprint-guarded
 * (customized files untouched), idempotent.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-posture-mig-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-mmPostureReviewDimension.test.ts' }));
  return dir;
}

function installStockWithoutMarker(projectDir: string, rel: string[], fingerprint: string) {
  const p = path.join(projectDir, '.claude', ...rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // A pre-update stock copy: carries the fingerprint, lacks the new marker.
  fs.writeFileSync(p, `${fingerprint}\n\nold stock content without the new section\n`);
  return p;
}

function runMigration(projectDir: string) {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar') } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (m as unknown as { migrateMultiMachinePostureReviewDimension: (r: typeof result) => void }).migrateMultiMachinePostureReviewDimension(result);
  return result;
}

describe('migrateMultiMachinePostureReviewDimension', () => {
  it('the bundled sources actually carry the marker (the migration has something real to ship)', () => {
    for (const rel of [
      ['skills', 'instar-dev', 'templates', 'side-effects-artifact.md'],
      ['skills', 'instar-dev', 'SKILL.md'],
      ['skills', 'spec-converge', 'SKILL.md'],
    ]) {
      const bundled = fs.readFileSync(path.join(repoRoot, ...rel), 'utf8');
      expect(bundled, rel.join('/')).toContain('Multi-machine posture');
    }
  });

  it('upgrades stock installed copies to the bundled versions (and is idempotent)', () => {
    const projectDir = tmpProject();
    const tpl = installStockWithoutMarker(projectDir, ['skills', 'instar-dev', 'templates', 'side-effects-artifact.md'], '## 6. External surfaces');
    installStockWithoutMarker(projectDir, ['skills', 'instar-dev', 'SKILL.md'], '# /instar-dev');
    installStockWithoutMarker(projectDir, ['skills', 'spec-converge', 'SKILL.md'], '# /spec-converge');

    const r1 = runMigration(projectDir);
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded.length).toBe(3);
    expect(fs.readFileSync(tpl, 'utf8')).toContain('Multi-machine posture');

    const r2 = runMigration(projectDir);
    expect(r2.upgraded).toEqual([]); // marker present → idempotent no-op
    expect(r2.errors).toEqual([]);
  });

  it('leaves a CUSTOMIZED installed copy untouched and reports it', () => {
    const projectDir = tmpProject();
    const p = path.join(projectDir, '.claude', 'skills', 'instar-dev', 'SKILL.md');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'totally custom operator-authored skill\n'); // lacks fingerprint
    const r = runMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(r.skipped.join()).toContain('customized — left untouched');
    expect(fs.readFileSync(p, 'utf8')).toContain('totally custom');
  });

  it('missing installed files are skipped silently (fresh installs get bundled copies elsewhere)', () => {
    const projectDir = tmpProject();
    const r = runMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});
