import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ITERATIVE_CONVERGING_AUDIT_SKILL_CONTENT } from '../../src/data/builtinSkillContent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SENTINEL = '<!-- INSTAR:AUDIT-META-ARTIFACT-V2 -->';
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-meta-migration-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'PostUpdateMigrator-auditMetaArtifact.test.ts' }));
  return dir;
}

function installedPath(projectDir: string): string {
  return path.join(projectDir, '.claude', 'skills', 'iterative-converging-audit', 'SKILL.md');
}

function writeInstalled(projectDir: string, content: string): string {
  const target = installedPath(projectDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function migrate(projectDir: string) {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar') } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (migrator as unknown as { migrateIterativeConvergingAuditSkill: (r: typeof result) => void }).migrateIterativeConvergingAuditSkill(result);
  return result;
}

describe('iterative audit meta-artifact V2 migration', () => {
  it('upgrades the exact previously shipped stock copy', () => {
    const dir = project();
    const prior = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'iterative-converging-audit-v1.md'), 'utf8').replace(/\n$/, '');
    const target = writeInstalled(dir, prior);
    const result = migrate(dir);
    expect(fs.readFileSync(target, 'utf8')).toBe(ITERATIVE_CONVERGING_AUDIT_SKILL_CONTENT);
    expect(result.upgraded).toHaveLength(1);
  });

  it('is idempotent once the dedicated sentinel exists', () => {
    const dir = project();
    const target = writeInstalled(dir, ITERATIVE_CONVERGING_AUDIT_SKILL_CONTENT);
    const result = migrate(dir);
    expect(fs.readFileSync(target, 'utf8')).toContain(SENTINEL);
    expect(result.upgraded).toEqual([]);
  });

  it('preserves a customized copy', () => {
    const dir = project();
    const target = writeInstalled(dir, '# custom audit workflow\n');
    const result = migrate(dir);
    expect(fs.readFileSync(target, 'utf8')).toBe('# custom audit workflow\n');
    expect(result.skipped.some((row) => row.includes('customized'))).toBe(true);
  });

  it('leaves a missing install for the fresh-install path', () => {
    const result = migrate(project());
    expect(result).toEqual({ upgraded: [], skipped: [], errors: [] });
  });
});
