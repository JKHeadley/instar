// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup only.

/**
 * Migration Parity — Avoid TCC-Protected Directories (operator mandate
 * 2026-10-14). Existing agents learn about the mandate on UPDATE, not only
 * new agents at init:
 *  - the CLAUDE.md awareness section reaches existing agents idempotently
 *    (sniff key `TCC-protected path guard`) and the template carries the
 *    same section for new agents;
 *  - `migrateTccProtectedPath` surfaces the condition in the migration
 *    summary for an agent that ALREADY lives under ~/Documents on macOS,
 *    points at the runbook, moves NOTHING, and is a strict no-op elsewhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const realPlatform = process.platform;
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-mig-home-'));
  fs.mkdirSync(path.join(home, 'Documents', 'Projects'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Projects'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
  SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-tccProtectedPath.test.ts' });
});

function migratorFor(projectDir: string): PostUpdateMigrator {
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
}

const runClaudeMd = (m: PostUpdateMigrator): MigrationResult => {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
};

const runTcc = (m: PostUpdateMigrator): MigrationResult => {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateTccProtectedPath(r: MigrationResult): void }).migrateTccProtectedPath(result);
  return result;
};

describe('CLAUDE.md awareness parity', () => {
  it('adds the section once to an existing agent and is idempotent', () => {
    const projectDir = path.join(home, 'Projects', 'agent');
    const m = migratorFor(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md\n');
    const r1 = runClaudeMd(m);
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded).toContain('CLAUDE.md: added TCC-protected path guard section');
    const after = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain('## TCC-protected path guard');
    expect(after).toContain('AVOIDED AT ALL COSTS');
    expect(after).toContain('docs/runbooks/move-agent-out-of-documents.md');
    expect(after).toContain('monitoring.tccProtectedPathGuard');
    const r2 = runClaudeMd(m);
    expect(r2.upgraded).not.toContain('CLAUDE.md: added TCC-protected path guard section');
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8').split('## TCC-protected path guard').length - 1).toBe(1);
  });

  it('the template carries the same section for new agents', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain('## TCC-protected path guard');
    expect(md).toContain('Refused at creation');
    expect(md).toContain('docs/runbooks/move-agent-out-of-documents.md');
  });
});

describe('migrateTccProtectedPath — surfaces the condition, moves nothing', () => {
  it('macOS + agent under ~/Documents → ONE migration warning naming the path and the runbook; directory untouched', () => {
    setPlatform('darwin');
    const projectDir = path.join(home, 'Documents', 'Projects', 'instar-codey');
    const m = migratorFor(projectDir);
    const r = runTcc(m);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('tcc-protected-path:');
    expect(r.errors[0]).toContain('~/Documents');
    expect(r.errors[0]).toContain('docs/runbooks/move-agent-out-of-documents.md');
    expect(r.upgraded).toEqual([]);
    expect(fs.existsSync(path.join(projectDir, '.instar'))).toBe(true);
    // Idempotent: a second run says the same thing again (it re-surfaces until moved).
    const r2 = runTcc(m);
    expect(r2.errors).toEqual(r.errors);
  });

  it('macOS + safe location → skipped as clear', () => {
    setPlatform('darwin');
    const r = runTcc(migratorFor(path.join(home, 'Projects', 'agent')));
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual(['tcc-protected-path: agent location is clear (outside Documents/Desktop/Downloads/iCloud Drive)']);
  });

  it('Linux + agent under ~/Documents → not applicable, no warning', () => {
    setPlatform('linux');
    const r = runTcc(migratorFor(path.join(home, 'Documents', 'Projects', 'agent')));
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual(['tcc-protected-path: not applicable on linux (macOS-only check)']);
  });

  it('is dispatched from the migrator run list (not an orphan method)', () => {
    const src = fs.readFileSync(path.resolve('src/core/PostUpdateMigrator.ts'), 'utf-8');
    expect(src).toContain('this.migrateTccProtectedPath(result);');
  });
});
