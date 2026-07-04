/**
 * Anthropic clean-door reviewer disclosure migration (REVIEWER-DOOR-REWIRING
 * §Migration parity, inc1): a deployed agent's installed spec-converge SKILL.md
 * gains the `--family claude-code` clean-door reviewer family + its
 * `clean-door-anthropic-review` disclosure field + the D7 per-round-model line —
 * marker-sniffed (`clean-door-anthropic-review`), fingerprint-guarded
 * (`# /spec-converge`; customized files untouched), idempotent. Per Migration
 * Parity case 5b, installBuiltinSkills() never overwrites an installed SKILL.md,
 * so this dedicated migration is the ONLY path the content reaches existing agents.
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
const MARKER = 'clean-door-anthropic-review';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-reviewer-mig-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-anthropicReviewerDisclosure.test.ts' }));
  return dir;
}

function runMigration(projectDir: string) {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar') } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (m as unknown as { migrateSpecConvergeAnthropicReviewerDisclosure: (r: typeof result) => void }).migrateSpecConvergeAnthropicReviewerDisclosure(result);
  return result;
}

describe('bundled spec-converge SKILL carries the clean-door reviewer content', () => {
  it('the bundled SKILL.md carries the marker + the family + D7 disclosure', () => {
    const skill = fs.readFileSync(path.join(repoRoot, ...SKILL_REL), 'utf8');
    expect(skill).toContain(MARKER);
    expect(skill).toContain('--family claude-code');
    expect(skill).toContain('D7 per-round-model disclosure');
  });
});

describe('migrateSpecConvergeAnthropicReviewerDisclosure', () => {
  it('upgrades a stock installed copy to the bundled version (and is idempotent)', () => {
    const projectDir = tmpProject();
    const p = path.join(projectDir, '.claude', ...SKILL_REL);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '# /spec-converge\n\nold stock content without the clean-door family\n');

    const r1 = runMigration(projectDir);
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded.length).toBe(1);
    expect(fs.readFileSync(p, 'utf8')).toContain(MARKER);

    const r2 = runMigration(projectDir);
    expect(r2.upgraded).toEqual([]); // marker present → idempotent no-op
    expect(r2.errors).toEqual([]);
  });

  it('leaves a CUSTOMIZED installed copy untouched and reports it', () => {
    const projectDir = tmpProject();
    const p = path.join(projectDir, '.claude', ...SKILL_REL);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'totally custom operator-authored skill\n'); // lacks fingerprint
    const r = runMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(r.skipped.join()).toContain('customized — left untouched');
    expect(fs.readFileSync(p, 'utf8')).toContain('totally custom');
  });

  it('missing installed file is skipped silently (fresh installs get the bundled copy elsewhere)', () => {
    const projectDir = tmpProject();
    const r = runMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});
